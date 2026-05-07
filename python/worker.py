#!/usr/bin/env python3

import os
import re
import json
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

from dotenv import load_dotenv
import redis
import psycopg2
from psycopg2.extras import Json
from google import genai
import threading

from db_pool import initialize_pool, get_connection, return_connection, load_environment
from ticker_cache import verify_ticker_exists, verify_tickers_exist
from performance_tracker import track_performance


MAX_SIGNAL_AGE_HOURS = int(os.getenv('MAX_SIGNAL_AGE_HOURS', '72'))
QUOTE_LOOKUP_TIMEOUT_SEC = float(os.getenv('QUOTE_LOOKUP_TIMEOUT_SEC', '5'))
GEMINI_MAX_RETRIES = int(os.getenv('GEMINI_MAX_RETRIES', '4'))
GEMINI_RETRY_BASE_SEC = float(os.getenv('GEMINI_RETRY_BASE_SEC', '1.5'))
MATURITY_THRESHOLD_HOURS = 24  # Signal is "mature" after 24 hours from publication


def ensure_signal_columns() -> None:
    """Add rich signal columns to older databases before the worker runs."""
    statements = [
        'ALTER TABLE signals ADD COLUMN IF NOT EXISTS time_horizon VARCHAR(50)',
        'ALTER TABLE signals ADD COLUMN IF NOT EXISTS ticker_profiles JSONB',
        'ALTER TABLE signals ADD COLUMN IF NOT EXISTS root_cause TEXT',
        'ALTER TABLE signals ADD COLUMN IF NOT EXISTS source_headline TEXT',
        'ALTER TABLE signals ADD COLUMN IF NOT EXISTS source_name VARCHAR(255)',
        'ALTER TABLE signals ADD COLUMN IF NOT EXISTS source_attribution TEXT',
        'ALTER TABLE signals ADD COLUMN IF NOT EXISTS geography VARCHAR(255)',
        'ALTER TABLE signals ADD COLUMN IF NOT EXISTS market_consensus_divergence TEXT',
        'ALTER TABLE signals ADD COLUMN IF NOT EXISTS investment_thesis TEXT',
        'ALTER TABLE signals ADD COLUMN IF NOT EXISTS first_order_effects JSONB',
        'ALTER TABLE signals ADD COLUMN IF NOT EXISTS second_order_effects JSONB',
        'ALTER TABLE signals ADD COLUMN IF NOT EXISTS positively_affected TEXT[]',
        'ALTER TABLE signals ADD COLUMN IF NOT EXISTS negatively_affected TEXT[]',
        'ALTER TABLE signals ADD COLUMN IF NOT EXISTS thesis_risks JSONB',
        'ALTER TABLE signals ADD COLUMN IF NOT EXISTS catalyst_chain JSONB',
        'ALTER TABLE signals ADD COLUMN IF NOT EXISTS relationship_graph JSONB',
        'ALTER TABLE signals ADD COLUMN IF NOT EXISTS article_published_at TIMESTAMP WITH TIME ZONE',
        'ALTER TABLE signals ADD COLUMN IF NOT EXISTS vulnerability_type VARCHAR(100)',
        'ALTER TABLE signals ADD COLUMN IF NOT EXISTS contagion_path JSONB',
        'ALTER TABLE signals ADD COLUMN IF NOT EXISTS chokepoint TEXT',
        '''
        CREATE TABLE IF NOT EXISTS signal_performance (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            signal_id UUID NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
            ticker VARCHAR(10) NOT NULL,
            check_interval VARCHAR(20) NOT NULL,
            entry_price NUMERIC,
            check_price NUMERIC,
            return_pct NUMERIC,
            direction_correct BOOLEAN,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(signal_id, ticker, check_interval)
        )
        '''
    ]

    conn = None
    cur = None
    try:
        conn = get_connection()
        cur = conn.cursor()
        for statement in statements:
            cur.execute(statement)
        conn.commit()
    finally:
        if cur is not None:
            cur.close()
        if conn is not None:
            return_connection(conn)


def simple_signal_extractor(title: str, description: str) -> dict:
    """Heuristic signal extractor for MVP.

    - Extracts candidate tickers as 1-5 uppercase words from title/description
    - Infers direction via simple keyword matching
    - Assigns a basic confidence score
    """
    text = f"{title} {description or ''}"

    # Find uppercase tokens that look like tickers
    tickers = re.findall(r"\b[A-Z]{1,5}\b", text)
    # Filter obvious non-tickers (common short words)
    blacklist = {"THE", "A", "I", "AND", "FOR", "TO", "IN", "ON", "UP", "NEW"}
    tickers = [t for t in tickers if t not in blacklist]

    # If a ticker list exists under data/tickers.txt, use it for validation
    valid_tickers = None
    ticker_file = Path(__file__).resolve().parents[1] / 'data' / 'tickers.txt'
    if ticker_file.exists():
        try:
            with open(ticker_file, 'r') as fh:
                valid_tickers = {line.strip().upper() for line in fh if line.strip()}
        except Exception:
            valid_tickers = None

    if valid_tickers is not None:
        tickers = [t for t in tickers if t in valid_tickers]

    direction = 'NEUTRAL'
    confidence = 40
    if tickers:
        confidence += min(len(tickers) * 8, 24)

    return {
        'tickers': tickers,
        'direction': direction,
        'confidence': int(confidence),
        'reasoning': (
            'Fallback signal generated without directional keyword inference. '
            'Enable Gemini path for causal analysis and directional classification.'
        ),
        'time_horizon': 'short-term',
    }


def classify_source_origin(article: dict) -> str:
    """Best-effort attribution of primary source category from URL/source metadata."""
    url = (article.get('url') or '').lower()
    source_name = (article.get('source') or '').lower()
    title = (article.get('title') or '').lower()

    if 'sec.gov' in url or '10-k' in title or '8-k' in title or 'form 8-k' in title:
        return 'SEC filing'
    if 'federalreserve.gov' in url or 'ecb.europa.eu' in url or 'bls.gov' in url:
        return 'Official government/central bank statement'
    if 'investor' in url or 'press-release' in url or 'globenewswire' in url or 'prnewswire' in url:
        return 'Company press release or investor-relations statement'
    if source_name in {'reuters', 'bloomberg', 'cnbc', 'yahoo finance', 'wsj', 'financial times'}:
        return 'Secondary financial media report (primary source not explicit)'
    return 'Primary source not explicit in metadata'


def lookup_ticker_profile(symbol: str) -> dict:
    """Return best-effort company and business metadata for a ticker symbol."""
    symbol = (symbol or '').strip().upper()
    if not symbol:
        return {}

    params = urllib.parse.urlencode({'symbols': symbol})
    url = f'https://query1.finance.yahoo.com/v7/finance/quote?{params}'
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})

    try:
        with urllib.request.urlopen(req, timeout=QUOTE_LOOKUP_TIMEOUT_SEC) as resp:
            payload = json.loads(resp.read().decode('utf-8', errors='replace'))
        results = payload.get('quoteResponse', {}).get('result', [])
        if results:
            row = results[0]
            return {
                'symbol': symbol,
                'company_name': str(row.get('longName') or row.get('shortName') or symbol).strip(),
                'business_type': str(row.get('industry') or row.get('sector') or row.get('quoteType') or '').strip(),
                'sector': str(row.get('sector') or '').strip(),
                'industry': str(row.get('industry') or '').strip(),
                'quote_type': str(row.get('quoteType') or '').strip(),
            }
    except Exception:
        pass

    try:
        search_params = urllib.parse.urlencode({'q': symbol})
        search_url = f'https://query1.finance.yahoo.com/v1/finance/search?{search_params}'
        search_req = urllib.request.Request(search_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(search_req, timeout=QUOTE_LOOKUP_TIMEOUT_SEC) as resp:
            payload = json.loads(resp.read().decode('utf-8', errors='replace'))

        quotes = payload.get('quotes', [])
        exact = None
        for q in quotes:
            if str(q.get('symbol', '')).upper() == symbol:
                exact = q
                break

        if exact:
            return {
                'symbol': symbol,
                'company_name': str(exact.get('longname') or exact.get('shortname') or symbol).strip(),
                'business_type': str(exact.get('industry') or exact.get('sector') or exact.get('quoteType') or '').strip(),
                'sector': str(exact.get('sector') or '').strip(),
                'industry': str(exact.get('industry') or '').strip(),
                'quote_type': str(exact.get('quoteType') or '').strip(),
            }
    except Exception:
        pass

    return {'symbol': symbol}


def normalize_confidence(parsed: dict, verified_tickers, source_attribution: str) -> int:
    """Calibrate confidence with evidence-quality penalties/bonuses."""
    # Base confidence from model
    try:
        base = int(parsed.get('confidence', 50))
    except Exception:
        base = 50

    confidence = max(0, min(100, base))

    # Penalize heavily if no verified tickers
    if not verified_tickers:
        confidence -= 35
    elif len(verified_tickers) == 1:
        confidence -= 5
    else:
        confidence += 5

    # Source quality adjustment
    if 'secondary' in (source_attribution or '').lower() or 'not explicit' in (source_attribution or '').lower():
        confidence -= 10
    else:
        confidence += 5

    # Event-type calibration: downweight 'request' / 'speculation'
    root = str(parsed.get('root_cause', '')).strip().lower()
    if any(k in root for k in ['request', 'requested', 'rfp', 'expressed interest', 'request for']):
        # Cap confidence to request/speculation band if model gave higher
        confidence = min(confidence, 60)
        confidence = max(confidence, 40)

    # Forward-looking guidance/forecast events should not be near-certain.
    forward_text = ' '.join([
        str(parsed.get('reasoning', '')),
        str(parsed.get('root_cause', '')),
        ' '.join([str(x) for x in parsed.get('first_order_effects', [])]),
        ' '.join([str(x) for x in parsed.get('second_order_effects', [])]),
    ]).lower()
    has_guidance_signal = any(
        k in forward_text for k in ['guidance', 'forecast', 'outlook', 'expected', 'projected', 'plan to', 'plans to', 'capex']
    )
    if has_guidance_signal:
        confidence = min(confidence, 80)

    # Hard evidence events can carry higher confidence bands.
    has_hard_evidence = any(
        k in forward_text for k in ['signed contract', 'signed contracts', 'shipment data', 'shipments', 'confirmed order', 'confirmed funding']
    )
    if has_hard_evidence:
        confidence = min(max(confidence, 80), 95)

    # Mixed direction should generally carry slightly lower certainty than one-sided directional calls.
    if str(parsed.get('direction', '')).upper() == 'MIXED':
        confidence = min(confidence, 88)

    # Per-ticker conviction adjustments (if provided)
    try:
        # verified_tickers may be list of symbols; look up convictions from parsed['tickers']
        tickers_meta = {t['symbol']: t.get('conviction', 'medium') for t in parsed.get('tickers', []) if isinstance(t, dict)}
        for s in verified_tickers:
            conv = tickers_meta.get(s, 'medium')
            if conv == 'high':
                confidence += 3
            elif conv == 'medium':
                confidence += 1
            else:
                confidence -= 2
    except Exception:
        pass

    # Require basic causal explanation structure quality.
    second_order = parsed.get('second_order_effects', [])
    if not root:
        confidence -= 10
    if not second_order:
        confidence -= 5

    # Enforce final confidence ceilings after all boosts/penalties.
    if has_guidance_signal:
        confidence = min(confidence, 80)
    if has_hard_evidence:
        confidence = min(max(confidence, 80), 95)

    return max(0, min(100, confidence))


def build_relationship_graph(signal: dict) -> dict:
    """Build a fallback graph that gives the UI multiple branch groups."""

    def looks_like_ticker(value: str) -> bool:
        text = str(value or '').strip().upper()
        return bool(text) and len(text) <= 5 and text.isalpha()

    def normalize_items(items, default_kind: str, direction: str, relationship: str):
        normalized = []
        for index, item in enumerate(items or []):
            if isinstance(item, dict):
                label = str(
                    item.get('label')
                    or item.get('ticker')
                    or item.get('symbol')
                    or item.get('name')
                    or item.get('title')
                    or item.get('reason')
                    or ''
                ).strip()
                children = item.get('children') or []
                if not label:
                    continue
                # Derive per-item direction from 'impact' or 'direction' fields.
                item_direction = str(
                    item.get('direction')
                    or item.get('impact')
                    or direction
                ).lower()
                ticker = str(item.get('ticker') or item.get('symbol') or '').upper().strip()
                kind = str(item.get('kind') or item.get('type') or default_kind)
                if not ticker and kind == 'ticker' and not looks_like_ticker(label):
                    kind = 'theme'
                normalized.append({
                    'id': str(item.get('id') or f'{relationship.lower().replace(" ", "-")}-{index}'),
                    'label': label,
                    'ticker': ticker or None,
                    'kind': kind,
                    'direction': item_direction,
                    'conviction': str(item.get('conviction') or item.get('weight') or 'medium'),
                    'relationship': str(item.get('relationship') or relationship),
                    'why_it_matters': str(item.get('why_it_matters') or item.get('details') or item.get('reason') or item.get('impact') or ''),
                    'children': normalize_items(children if isinstance(children, list) else [], 'concept', item_direction, f'{label} follow-through'),
                })
            else:
                label = str(item).strip()
                if not label:
                    continue
                ticker = label.upper() if looks_like_ticker(label) else None
                normalized.append({
                    'id': f'{relationship.lower().replace(" ", "-")}-{index}',
                    'label': label,
                    'ticker': ticker,
                    'kind': default_kind if ticker else 'theme',
                    'direction': direction,
                    'conviction': 'medium',
                    'relationship': relationship,
                    'why_it_matters': '',
                    'children': [],
                })
        return normalized

    branches = []

    def add_branch(label: str, items, default_kind: str, direction: str):
        nodes = normalize_items(items, default_kind, direction, label)
        if nodes:
            branches.append({
                'label': label,
                'tone': direction,
                'nodes': nodes,
            })

    # Derive overall signal tone for primary tickers branch from the signal direction.
    sig_direction = str(signal.get('direction', 'NEUTRAL')).upper()
    primary_tone = (
        'positive' if sig_direction == 'BULLISH'
        else 'negative' if sig_direction == 'BEARISH'
        else 'mixed' if sig_direction == 'MIXED'
        else 'neutral'
    )
    add_branch('Primary tickers', signal.get('tickers', []), 'ticker', primary_tone)
    add_branch('Direct effects', signal.get('first_order_effects', []), 'effect', 'neutral')
    add_branch('Secondary effects', signal.get('second_order_effects', []), 'effect', 'neutral')
    add_branch('Beneficiaries', signal.get('positively_affected', []), 'ticker', 'positive')
    add_branch('Headwinds', signal.get('negatively_affected', []), 'ticker', 'negative')
    add_branch('Invalidators', signal.get('thesis_risks', []), 'risk', 'neutral')

    divergence = str(signal.get('market_consensus_divergence', '')).strip()
    geography = str(signal.get('geography', '')).strip()
    source_attribution = str(signal.get('source_attribution', '')).strip()
    context_nodes = [value for value in [divergence, geography, source_attribution] if value]
    add_branch('Context', context_nodes, 'context', 'neutral')

    return {
        'root': str(signal.get('root_cause') or 'News Event Detected').strip(),
        'branches': branches,
    }


def generate_signal_with_gemini(article: dict) -> dict:
    """Generate a structured signal using the official google-genai SDK."""
    api_key = os.getenv('GEMINI_API_KEY')
    if not api_key:
        raise RuntimeError('GEMINI_API_KEY not set')

    title = article.get('title', '')
    description = article.get('description', '') or ''
    content = f"{title}\n\n{description}"

    prompt = (
            "You are a senior equity analyst specializing in event-driven market signals. "
            "Think through the causal chain internally, but do not output scratchpad text. "
            "Return JSON only.\n\n"
            "HARD CONSTRAINTS:\n"
            "1. EVERY symbol in the 'tickers' array MUST exist in the 'relationship_graph' as a node with a matching 'ticker' field.\n"
            "2. The 'root_cause' and 'relationship_graph.root' MUST be the driving EVENT or CATALYST (e.g., 'Production Target Cut'), NEVER a company name (e.g., NOT 'Lucid Motors').\n"
            "3. If direction is MIXED, every ticker in the array must have an explicit impact field of either positive or negative.\n\n"

            "{\n"
            "  \"tickers\": [{\"symbol\": \"TICKER1\", \"conviction\": \"high|medium|low\", \"impact\": \"positive|negative\", \"exposure_detail\": {\"dependency_type\": \"sole_source|major_supplier|minor_supplier|customer|competitor|substitute|none\", \"estimated_revenue_exposure\": \"~40% or unknown\", \"vulnerability_mechanism\": \"one sentence explaining WHY this company is exposed\", \"time_to_impact\": \"immediate|1-2 quarters|3+ quarters\"}}],\n"
            "  \"direction\": \"BULLISH\"|\"BEARISH\"|\"MIXED\"|\"NEUTRAL\",\n"
            "  \"confidence\": 0-100,\n"
            "  \"time_horizon\": \"intraday\"|\"short-term\"|\"medium-term\",\n"
            "  \"geography\": \"country/region most relevant to the signal or 'unspecified'\",\n"
            "  \"root_cause\": \"concise factual event driving the news (e.g. 'Port Strike' not 'Maersk')\",\n"
            "  \"first_order_effects\": [{\"label\": \"3-5 word concise title\", \"details\": \"Full technical explanation of the direct effect\"}],\n"
            "  \"second_order_effects\": [{\"label\": \"3-5 word concise title\", \"details\": \"Full technical explanation of the downstream effect\"}],\n"
            "  \"positively_affected\": [\"ticker or asset names that benefit\"],\n"
            "  \"negatively_affected\": [\"ticker or asset names that are hurt\"],\n"
            "  \"source_attribution\": \"best guess of original source: filing/press release/central bank/etc\",\n"
            "  \"confidence_basis\": [\"factors used to assign confidence\"],\n"
            "  \"vulnerability_type\": \"supply_disruption|demand_shift|regulatory_shock|infrastructure_failure|geopolitical_contagion|none\",\n"
            "  \"chokepoint\": \"the specific facility, port, route, resource, or regulation disrupted — or empty string if not applicable\",\n"
            "  \"relationship_graph\": {\n"
            "    \"root\": \"short causal summary of the event\",\n"
            "    \"branches\": [\n"
            "      {\n"
            "        \"label\": \"Primary tickers\",\n"
            "        \"tone\": \"positive|negative|neutral\",\n"
            "        \"nodes\": [\n"
            "          {\n"
            "            \"label\": \"Ticker or company name\",\n"
            "            \"ticker\": \"TICKER\",\n"
            "            \"kind\": \"ticker|sector|supplier|customer|chokepoint|substitute|risk|theme\",\n"
            "            \"direction\": \"positive|negative|neutral\",\n"
            "            \"conviction\": \"high|medium|low\",\n"
            "            \"relationship\": \"why this node is connected to the root cause\",\n"
            "            \"why_it_matters\": \"1 short sentence with the market link\",\n"
            "            \"exposure_pct\": \"estimated revenue/cost exposure percentage like ~40% or empty string\",\n"
            "            \"children\": [\n"
            "              {\"label\": \"Optional downstream or peer node\", \"ticker\": \"\", \"kind\": \"theme\", \"direction\": \"neutral\", \"conviction\": \"low\", \"relationship\": \"secondary read-through\", \"why_it_matters\": \"\", \"exposure_pct\": \"\", \"children\": []}\n"
            "            ]\n"
            "          }\n"
            "        ]\n"
            "      }\n"
            "    ]\n"
            "  },\n"
            "  \"catalyst_chain\": [\n"
            "    \"Step 1: The immediate factual change\",\n"
            "    \"Step 2: The direct financial/operational impact on named entities\",\n"
            "    \"Step 3: The transmission to sector/supply chain\",\n"
            "    \"Step 4: The second-order market repricing effect\"\n"
            "  ],\n"
            "  \"investment_thesis\": \"3-5 sentences synthesizing the market mispricing, why it matters now, and why these tickers are the best expression of the trade.\",\n"
            "  \"thesis_risks\": [\"Specific factors that would invalidate this signal. MUST be a 7-word summary. Do not truncate mid-word.\", \"Reasons this might already be priced in\"],\n"
            "  \"market_consensus_divergence\": \"Whether this confirms, contradicts, or introduces a market narrative — with a concrete reason why.\",\n"
            "  \"reasoning\": \"2-4 sentence causal explanation from event to market impact\"\n"
            "}\n\n"

            "## TONE FOR NODE AND PANEL COPY\n"
            "- Write for a smart casual trader first: clear, direct, and easy to scan.\n"
            "- Keep the technical edge, but lead with the plain-English market meaning before the deeper mechanism.\n"
            "- Prefer concrete business language over jargon when both say the same thing. Example: say 'margins get squeezed' instead of 'operating leverage compresses' unless the nuance matters.\n"
            "- When a technical term is useful, include it alongside a simpler explanation in the same sentence.\n"
            "- Avoid generic analyst phrasing like 'positive sentiment' or 'material implications' unless the article truly calls for it.\n"
            "- Make each node/panel sentence specific to the ticker or market segment, not a reusable template.\n"
            "- Keep it concise, but do not flatten the causal chain or remove important details.\n\n"

            "## THE 6-HOP CONTAGION HUNTING FRAMEWORK\n"
            "You must think like an institutional supply chain analyst finding hidden alpha. "
            "Do NOT just extract companies mentioned in the text. You must perform multi-hop reasoning "
            "to find companies with deep, unmentioned dependencies. Example chain:\n"
            "  1. [Event] 470,000 TEUs trapped in Persian Gulf\n"
            "  2. [Direct Effect] Southeast Asian ports hit critical congestion\n"
            "  3. [Capacity Loss] Ocean freight capacity removed from Asia-Europe lanes\n"
            "  4. [Overflow] Airfreight absorbs overflow -> spot rates spike -> stop bookings\n"
            "  5. [Downstream Delay] Consumer electronics & semiconductor components delayed from SE Asia factories\n"
            "  6. [The Hidden Signal] WHO manufactures in SE Asia and depends on these lanes? (e.g. AAPL, NIKE)\n"
            "Your highest value is finding Step 6. If the article mentions a disruption in a region, YOU MUST use your internal knowledge to identify the global brands (AAPL, NIKE, DELL, etc.) that rely on that region for manufacturing, raw materials, or revenue.\n\n"
            
            "## TICKER IDENTIFICATION RULES\n"
            "- Direct Exposure (BEARISH/BULLISH): Companies directly involved in the disruption (e.g. shipping carriers, freight forwarders).\n"
            "- Manufacturing/Supply Chain Exposure (BEARISH): Companies whose inputs/products flow through the disrupted node. You MUST supply these hidden tickers based on your knowledge of global supply chains.\n"
            "- Contagion Beneficiaries (BULLISH): Competitors, alternative logistics providers, or substitute goods that win market share.\n"
            "- Second-Order Exposure (BEARISH): Retailers or downstream distributors (e.g. AMZN, WMT, BBY) facing inventory replenishment delays.\n"
            "- Never assign a ticker without first determining its exact structural relationship to the root cause.\n"
            "- If no individual ticker can be identified, use the most relevant sector ETF.\n"
            "- Ensure all tickers are real NYSE/NASDAQ symbols. Do not hallucinate.\n\n"
            
            "## RELATIONSHIP GRAPH\n"
            "- Populate relationship_graph so the UI can render a branching tree, not just a flat list.\n"
            "- Include at least 3 branches whenever possible: primary tickers, direct effects, and either beneficiaries or headwinds.\n"
            "- Each branch should contain 2-4 nodes when the article supports that breadth.\n"
            "- Prefer explicit market relationships: supplier, customer, competitor, substitute, hedge, downstream beneficiary, downstream loser.\n"
            "- Give each node a short why_it_matters sentence so the UI can show connection strength.\n"
            "- Use nested children for second-order read-throughs or peers that emerge from the first branch.\n\n"
            
            "## DIRECTION & IMPACT\n"
            "- Do NOT rely on directional words in the headline. Infer direction from causal fundamentals only.\n"
            "- Second-order supply chain exposure alone is insufficient for BEARISH. You must identify: (1) what % of the company's revenue or COGS is exposed, (2) whether they have stated alternative sourcing, and (3) whether the disruption duration exceeds their inventory buffer. If all three cannot be answered from the article, use MIXED with low conviction.\n"
            "- If the event has clear winners AND losers, set direction to MIXED.\n"
            "- When direction is MIXED, every ticker in the tickers array must have an explicit impact field of either positive or negative. No ticker should be ambiguous.\n"
            "- Use NEUTRAL only when no sector is plausibly affected. If any sector is affected use BULLISH, BEARISH, or MIXED.\n"
            "- Every positive impact ticker must appear in positively_affected. Every negative impact ticker must appear in negatively_affected.\n\n"
            
            "## BUSINESS MODEL NUANCE & CAUSALITY\n"
            "- Pay extremely close attention to the difference between PRODUCERS and SERVICES/EQUIPMENT providers.\n"
            "- Example: In a geopolitical conflict, oil producers are BULLISH, but oilfield service companies are BEARISH because conflict freezes capital expenditure.\n"
            "- Always separate the commodity/product price effect from the operational/capex effect.\n\n"
            
            "## SUPPLY CHAIN CONTAGION MAPPING\n"
            "- For every event involving geography, infrastructure, raw materials, logistics, or regulation:\n"
            "  1. Identify the CHOKEPOINT: What specific facility, port, route, policy, or resource is disrupted? Put it in the chokepoint field.\n"
            "  2. Map UPSTREAM DEPENDENCIES: Which companies source critical inputs from the affected area? Estimate revenue exposure percentage when inferable (e.g. '~40% of raw materials').\n"
            "  3. Map DOWNSTREAM CONTAGION: Which global brands (customers) face delivery delays or cost pass-through? (The Step 6 Hidden Signals).\n"
            "  4. Identify SUBSTITUTION BENEFICIARIES: Who gains market share or pricing power from the disruption?\n"
            "- Set vulnerability_type to the best fit: supply_disruption, demand_shift, regulatory_shock, infrastructure_failure, geopolitical_contagion.\n"
            "- For each affected ticker, populate the exposure_detail object with dependency_type, estimated_revenue_exposure, vulnerability_mechanism, and time_to_impact.\n"
            "- In the relationship_graph, use kind='chokepoint' for the disrupted facility/route, kind='supplier' for upstream dependencies, kind='customer' for downstream exposure, and kind='substitute' for beneficiaries.\n"
            "- Include exposure_pct on each relationship_graph node when you can estimate it.\n"
            "- When a company is flagged as negatively exposed, ALWAYS check: does this company have competitors who could benefit? Add them as substitution beneficiaries.\n\n"

            "## CONFIDENCE CALIBRATION\n"
            "- 40-55: Speculation / unconfirmed rumor / RFP / expressed interest\n"
            "- 56-70: Approved budget / formal policy decision / stated intent\n"
            "- 71-84: Signed contract / confirmed funding / definitive regulatory shift\n"
            "- 85-95: Hard earnings surprise / audited order flow / finalized M&A\n"
            "- If the article appears older than 72 hours, drop to the next lowest tier.\n"
            "- If the event is an unconfirmed rumor, cap at 55.\n\n"

            "## TIME HORIZON\n"
            "- intraday: earnings releases, single data prints, breaking news\n"
            "- short-term: 1-4 week drift from policy decisions, contract awards, guidance changes\n"
            "- medium-term: multi-month structural shifts, regulatory changes, geopolitical developments\n\n"

            "## OUTPUT QUALITY\n"
            "- investment_thesis must be 3-5 sentences and answer: what is the market mispricing, "
            "why does it matter now, and what is the specific mechanism connecting event to tickers.\n"
            "- investment_thesis must NOT merely repeat the catalyst_chain.\n"
            "- market_consensus_divergence must state whether this event (a) confirms, "
            "(b) contradicts, or (c) introduces a market narrative — with a concrete reason.\n"
            "- Every signal must include at least one realistic thesis_risk.\n"
            "- reasoning must explain the causal chain, not restate the headline.\n"
            "  Bad: 'Meta raised capex so stock fell.'\n"
            "  Good: 'Raised capex without ROI clarity signals margin compression risk, "
            "triggering multiple compression across high-valuation peers.'\n"
            "- For data center / hyperscaler capex news, always consider: VST, CEG, NEE, ETR.\n"
            "- For memory demand signals, always consider NVDA and AMD at medium conviction.\n\n"

            "## JSON RULES\n"
            "- Return a single valid JSON object only. No preamble, no postscript.\n"
            "- Do NOT wrap in markdown fences or ```json blocks.\n"
            "- No trailing commas. No comments inside JSON. No extra keys outside the schema.\n\n"

        "Article:\n" + content
    )

    model = os.getenv('GEMINI_MODEL', 'gemini-3.1-flash-lite-preview')
    client = genai.Client(api_key=api_key)

    last_err = None
    for attempt in range(1, GEMINI_MAX_RETRIES + 1):
        try:
            response = client.models.generate_content(model=model, contents=prompt)
            text = (response.text or '').strip()
            break
        except Exception as err:
            last_err = err
            msg = str(err)
            transient = any(k in msg for k in ['503', 'UNAVAILABLE', '429', 'RESOURCE_EXHAUSTED', 'DEADLINE_EXCEEDED'])
            if not transient or attempt >= GEMINI_MAX_RETRIES:
                raise
            sleep_s = GEMINI_RETRY_BASE_SEC * (2 ** (attempt - 1))
            print(f'  Gemini transient error, retry {attempt}/{GEMINI_MAX_RETRIES} in {sleep_s:.1f}s: {msg}')
            time.sleep(sleep_s)
    else:
        raise RuntimeError(f'Gemini failed after retries: {last_err}')

    # Some responses may still contain code fences; strip safely.
    if text.startswith('```'):
        text = re.sub(r'^```[a-zA-Z0-9]*\n?', '', text)
        text = re.sub(r'\n?```$', '', text)

    # Remove any scratchpad block if the model still emits one.
    text = re.sub(r'<scratchpad>.*?</scratchpad>', '', text, flags=re.DOTALL | re.IGNORECASE).strip()

    # If extra prose is present, extract the outermost JSON object.
    json_start = text.find('{')
    json_end = text.rfind('}')
    if json_start != -1 and json_end != -1 and json_end > json_start:
        candidate = text[json_start:json_end + 1].strip()
    else:
        candidate = text

    try:
        parsed = json.loads(candidate)
    except json.JSONDecodeError as e:
        raise RuntimeError(f'Gemini returned non-JSON output: {candidate[:200]}') from e

    # Normalize and validate fields
    # Accept either a list of ticker symbols or a list of objects {symbol, conviction}.
    raw_tickers = parsed.get('tickers', []) or []
    normalized_tickers = []
    if raw_tickers and isinstance(raw_tickers[0], dict):
        for item in raw_tickers:
            sym = str(item.get('symbol') or item.get('ticker') or '').upper()
            conv = str(item.get('conviction') or item.get('conviction_level') or '').lower()
            if conv not in {'high', 'medium', 'low'}:
                conv = 'medium'
            if sym:
                entry = {'symbol': sym, 'conviction': conv}
                # Preserve impact field
                impact = str(item.get('impact') or item.get('direction') or '').lower()
                if impact in {'positive', 'negative'}:
                    entry['impact'] = impact
                # Preserve exposure_detail for contagion tracking
                exposure = item.get('exposure_detail')
                if isinstance(exposure, dict):
                    exposure.setdefault('dependency_type', 'none')
                    exposure.setdefault('estimated_revenue_exposure', 'unknown')
                    exposure.setdefault('vulnerability_mechanism', '')
                    exposure.setdefault('time_to_impact', 'unknown')
                    entry['exposure_detail'] = exposure
                normalized_tickers.append(entry)
    else:
        for t in raw_tickers:
            sym = str(t).upper()
            if sym:
                normalized_tickers.append({'symbol': sym, 'conviction': 'medium'})
    parsed['tickers'] = normalized_tickers
    parsed['direction'] = str(parsed.get('direction', 'NEUTRAL')).upper()
    if parsed['direction'] not in {'BULLISH', 'BEARISH', 'MIXED', 'NEUTRAL'}:
        parsed['direction'] = 'NEUTRAL'
    try:
        parsed['confidence'] = max(0, min(100, int(parsed.get('confidence', 50))))
    except Exception:
        parsed['confidence'] = 50
    parsed['reasoning'] = str(parsed.get('reasoning', ''))
    parsed['time_horizon'] = str(parsed.get('time_horizon', 'short-term'))
    parsed['root_cause'] = str(parsed.get('root_cause', '')).strip()
    # Keep first/second order effects as dicts (not strings) so they serialize properly to JSON
    parsed['first_order_effects'] = [
        {
            'label': str(x.get('label', '') if isinstance(x, dict) else x).strip(),
            'details': str(x.get('details', '') if isinstance(x, dict) else '').strip()
        }
        for x in parsed.get('first_order_effects', [])
        if (isinstance(x, dict) and x.get('label')) or (isinstance(x, str) and x.strip())
    ]
    parsed['second_order_effects'] = [
        {
            'label': str(x.get('label', '') if isinstance(x, dict) else x).strip(),
            'details': str(x.get('details', '') if isinstance(x, dict) else '').strip()
        }
        for x in parsed.get('second_order_effects', [])
        if (isinstance(x, dict) and x.get('label')) or (isinstance(x, str) and x.strip())
    ]
    parsed['positively_affected'] = [str(x) for x in parsed.get('positively_affected', []) if str(x).strip()]
    parsed['negatively_affected'] = [str(x) for x in parsed.get('negatively_affected', []) if str(x).strip()]
    # Require both sides when direction is mixed or when one side is missing.
    if not parsed['positively_affected'] and parsed['tickers']:
        parsed['positively_affected'] = [f"{t.get('symbol')}" for t in parsed['tickers'][:2] if t.get('symbol')]
    if not parsed['negatively_affected'] and parsed['tickers']:
        parsed['negatively_affected'] = [f"{t.get('symbol')}" for t in parsed['tickers'][-2:] if t.get('symbol')]
    parsed['geography'] = str(parsed.get('geography', '')).strip() or 'unspecified'
    parsed['source_attribution'] = str(parsed.get('source_attribution', '')).strip()
    parsed['confidence_basis'] = [str(x) for x in parsed.get('confidence_basis', []) if str(x).strip()]
    # Contagion fields
    parsed['vulnerability_type'] = str(parsed.get('vulnerability_type', 'none')).strip().lower()
    if parsed['vulnerability_type'] not in {'supply_disruption', 'demand_shift', 'regulatory_shock', 'infrastructure_failure', 'geopolitical_contagion', 'none'}:
        parsed['vulnerability_type'] = 'none'
    parsed['chokepoint'] = str(parsed.get('chokepoint', '')).strip()
    relationship_graph = parsed.get('relationship_graph', {})
    if isinstance(relationship_graph, str):
        try:
            relationship_graph = json.loads(relationship_graph)
        except Exception:
            relationship_graph = {}
    if not isinstance(relationship_graph, dict):
        relationship_graph = {}
    if not relationship_graph:
        relationship_graph = build_relationship_graph(parsed)
    parsed['relationship_graph'] = relationship_graph
    # Extract contagion_path from relationship graph for structured storage
    contagion_path = []
    supply_chain_kinds = {'supplier', 'customer', 'substitute', 'chokepoint'}
    for branch in (relationship_graph.get('branches') or []):
        for node in (branch.get('nodes') or []):
            if isinstance(node, dict):
                node_kind = str(node.get('kind', '')).lower()
                node_rel = str(node.get('relationship', '')).lower()
                effective_kind = node_kind if node_kind in supply_chain_kinds else (node_rel if node_rel in supply_chain_kinds else None)
                if effective_kind:
                    contagion_path.append({
                        'ticker': str(node.get('ticker') or node.get('label') or '').strip(),
                        'dependency_type': effective_kind,
                        'exposure_pct': str(node.get('exposure_pct', '')).strip(),
                    'mechanism': str(node.get('why_it_matters') or node.get('relationship') or '').strip(),
                })
                # Also check children for downstream contagion
                for child in (node.get('children') or []):
                    if isinstance(child, dict):
                        child_kind = str(child.get('kind', '')).lower()
                        child_rel = str(child.get('relationship', '')).lower()
                        child_eff_kind = child_kind if child_kind in supply_chain_kinds else (child_rel if child_rel in supply_chain_kinds else None)
                        if child_eff_kind:
                            contagion_path.append({
                                'ticker': str(child.get('ticker') or child.get('label') or '').strip(),
                                'dependency_type': child_eff_kind,
                                'exposure_pct': str(child.get('exposure_pct', '')).strip(),
                            'mechanism': str(child.get('why_it_matters') or child.get('relationship') or '').strip(),
                        })
    parsed['contagion_path'] = contagion_path
    return parsed


def parse_iso_datetime(value: str):
    if not value:
        return None
    try:
        normalized = value.replace('Z', '+00:00')
        dt = datetime.fromisoformat(normalized)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def is_fresh_enough(published_at: str) -> bool:
    dt = parse_iso_datetime(published_at)
    if not dt:
        # If timestamp is missing/invalid, do not drop it blindly.
        return True
    age_hours = (datetime.now(timezone.utc) - dt).total_seconds() / 3600
    return 0 <= age_hours <= MAX_SIGNAL_AGE_HOURS


def save_signal(signal: dict) -> str:
    conn = None
    cur = None
    try:
        conn = get_connection()
        cur = conn.cursor()

        # Build tickers as a Postgres text[] of validated symbol strings.
        raw_tickers = signal.get('tickers', [])
        tickers_payload = []
        ticker_profiles = signal.get('ticker_profiles') or []
        for t in raw_tickers:
            if isinstance(t, dict):
                s = t.get('symbol') or t.get('ticker')
            else:
                s = t
            if s:
                tickers_payload.append(str(s).upper())

        # Normalise TEXT[] fields (list of plain strings).
        positively_affected = [str(x) for x in (signal.get('positively_affected') or []) if x]
        negatively_affected = [str(x) for x in (signal.get('negatively_affected') or []) if x]

        query = """
            INSERT INTO signals (
                tickers, ticker_profiles, direction, confidence, reasoning, source_url, created_at,
                time_horizon, root_cause, source_headline, source_name,
                source_attribution, geography, market_consensus_divergence,
                investment_thesis, first_order_effects, second_order_effects,
                positively_affected, negatively_affected, thesis_risks, catalyst_chain,
                relationship_graph, article_published_at,
                vulnerability_type, contagion_path, chokepoint
            ) VALUES (
                %s, %s, %s, %s, %s, %s, %s,
                %s, %s, %s, %s,
                %s, %s, %s,
                %s, %s, %s,
                %s, %s, %s, %s,
                %s, %s,
                %s, %s, %s
            ) RETURNING id
        """
        values = (
            # --- original 6 columns ---
            tickers_payload,
            Json(ticker_profiles),
            signal.get('direction', 'NEUTRAL'),
            signal.get('confidence', 0),
            signal.get('reasoning', ''),
            signal.get('source_url', ''),
            datetime.now(timezone.utc),
            # --- 14 rich-signal columns ---
            signal.get('time_horizon') or None,
            signal.get('root_cause') or None,
            signal.get('source_headline') or None,
            signal.get('source_name') or None,
            signal.get('source_attribution') or None,
            signal.get('geography') or None,
            signal.get('market_consensus_divergence') or None,
            signal.get('investment_thesis') or None,
            Json(signal.get('first_order_effects') or []),
            Json(signal.get('second_order_effects') or []),
            positively_affected or None,
            negatively_affected or None,
            Json(signal.get('thesis_risks') or []),
            Json(signal.get('catalyst_chain') or []),
            Json(signal.get('relationship_graph') or {}),
            parse_iso_datetime(signal.get('article_published_at')) if signal.get('article_published_at') else None,
            # --- 3 contagion columns ---
            signal.get('vulnerability_type') or None,
            Json(signal.get('contagion_path') or []),
            signal.get('chokepoint') or None,
        )
        cur.execute(query, values)
        signal_id = cur.fetchone()[0]
        conn.commit()
        return str(signal_id)
    except Exception as e:
        print(f'Failed to save signal to DB: {e}')
        if conn:
            conn.rollback()
        return None
    finally:
        if cur is not None:
            cur.close()
        if conn is not None:
            return_connection(conn)


def publish_signal(r: redis.Redis, stream: str, signal: dict, signal_id: str):
    try:
        payload = {
            'id': signal_id,
            'tickers': json.dumps(signal.get('tickers', [])),
            'ticker_profiles': json.dumps(signal.get('ticker_profiles', [])),
            'direction': signal.get('direction', 'NEUTRAL'),
            'confidence': str(signal.get('confidence', 0)),
            'time_horizon': str(signal.get('time_horizon', 'short-term')),
            'root_cause': str(signal.get('root_cause', '')),
            'first_order_effects': json.dumps(signal.get('first_order_effects', [])),
            'second_order_effects': json.dumps(signal.get('second_order_effects', [])),
            'positively_affected': json.dumps(signal.get('positively_affected', [])),
            'negatively_affected': json.dumps(signal.get('negatively_affected', [])),
            'investment_thesis': signal.get('investment_thesis', ''),
            'thesis_risks': json.dumps(signal.get('thesis_risks', [])),
            'catalyst_chain': json.dumps(signal.get('catalyst_chain', [])),
            'relationship_graph': json.dumps(signal.get('relationship_graph', {})),
            'geography': signal.get('geography', ''),
            'source_attribution': str(signal.get('source_attribution', '')),
            'source_name': str(signal.get('source_name', 'unknown')),
            'reasoning': signal.get('reasoning', ''),
            'source_url': signal.get('source_url', ''),
            'source_headline': signal.get('source_headline', ''),
            'created_at': datetime.now(timezone.utc).isoformat(),
            'article_published_at': signal.get('article_published_at', ''),
            'performance': json.dumps(signal.get('performance', [])),
            'vulnerability_type': signal.get('vulnerability_type', ''),
            'contagion_path': json.dumps(signal.get('contagion_path', [])),
            'chokepoint': signal.get('chokepoint', ''),
        }
        r.xadd(stream, payload)
    except Exception as e:
        print(f'Failed to publish signal to Redis: {e}')


def is_mature_signal(published_at_str: str) -> bool:
    """Check if signal is mature (>= 24 hours old)."""
    dt = parse_iso_datetime(published_at_str)
    if not dt:
        return False  # Unknown age, treat as immature for caution
    age_hours = (datetime.now(timezone.utc) - dt).total_seconds() / 3600
    return age_hours >= MATURITY_THRESHOLD_HOURS


def parallelize_ticker_verification(tickers: list, max_workers: int = 5) -> list:
    """
    Verify tickers in parallel using ThreadPoolExecutor.
    Returns list of verified symbol strings.
    """
    if not tickers:
        return []
    
    # Extract unique symbols
    unique_symbols = []
    seen = set()
    for t in tickers:
        if isinstance(t, dict):
            s = str(t.get('symbol', '')).upper().strip()
        else:
            s = str(t).upper().strip()
        if not s or s in seen:
            continue
        seen.add(s)
        unique_symbols.append(s)
    
    if not unique_symbols:
        return []
    
    # Verify in parallel
    verified = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(verify_ticker_exists, sym): sym for sym in unique_symbols}
        for future in as_completed(futures):
            sym = futures[future]
            try:
                if future.result():
                    verified.append(sym)
            except Exception as e:
                print(f'  Warning: Ticker verification failed for {sym}: {e}')
    
    return verified


def queue_immature_signal(r: redis.Redis, signal: dict, signal_id: str):
    """Queue signal for later performance tracking."""
    try:
        published_at = signal.get('article_published_at', '')
        dt = parse_iso_datetime(published_at)
        score = dt.timestamp() if dt else datetime.now(timezone.utc).timestamp()
        r.zadd('signals:immature_queue', {signal_id: score})
        print(f'  queued signal {signal_id} for later performance tracking (published {published_at})')
    except Exception as e:
        print(f'  Warning: Failed to queue immature signal: {e}')


def main() -> int:
    load_environment()
    initialize_pool()

    DATABASE_URL = os.getenv('DATABASE_URL')
    REDIS_URL = os.getenv('REDIS_URL')

    if not DATABASE_URL or not REDIS_URL:
        print('Missing DATABASE_URL or REDIS_URL in environment')
        return 1

    r = redis.from_url(REDIS_URL)

    try:
        ensure_signal_columns()
    except Exception as e:
        print(f'Failed to ensure signal columns: {e}')
        return 1

    STREAM_KEY = 'news:raw'
    GROUP = 'signals_workers'
    CONSUMER = f'worker-{int(time.time())}'
    OUT_STREAM = 'signals:ready'

    # Create group if needed
    try:
        r.xgroup_create(STREAM_KEY, GROUP, id='0', mkstream=True)
    except redis.ResponseError:
        pass

    print('MarketPulse worker started, listening to', STREAM_KEY)

    try:
        while True:
            resp = r.xreadgroup(GROUP, CONSUMER, {STREAM_KEY: '>'}, count=1, block=5000)
            if not resp:
                continue

            for stream_name, messages in resp:
                for msg_id, fields in messages:
                    article_json = fields.get(b'article')
                    if not article_json:
                        r.xack(STREAM_KEY, GROUP, msg_id)
                        continue

                    try:
                        article = json.loads(article_json.decode('utf-8'))
                    except Exception:
                        r.xack(STREAM_KEY, GROUP, msg_id)
                        continue

                    title = article.get('title', '')
                    desc = article.get('description', '')
                    print('Processing:', title)

                    # Enforce freshness at worker level too (default 72h).
                    if not is_fresh_enough(article.get('publishedAt', '')):
                        print(f'  skipped: older than {MAX_SIGNAL_AGE_HOURS} hours')
                        r.xack(STREAM_KEY, GROUP, msg_id)
                        continue

                    # Gemini is the primary signal engine for this project.
                    try:
                        signal = generate_signal_with_gemini(article)
                    except Exception as gemini_err:
                        print(f'  Gemini failed, skipping article: {gemini_err}')
                        r.xack(STREAM_KEY, GROUP, msg_id)
                        continue

                    # Parallel ticker verification (Phase 3)
                    verified_symbols = parallelize_ticker_verification(signal.get('tickers', []))
                    kept = [t for t in signal.get('tickers', []) if isinstance(t, dict) and t.get('symbol') in verified_symbols]
                    if not kept and verified_symbols:
                        kept = [{'symbol': s, 'conviction': 'medium'} for s in verified_symbols]
                    signal['tickers'] = kept
                    signal['ticker_profiles'] = [lookup_ticker_profile(s) for s in verified_symbols]

                    # Source attribution and confidence normalization.
                    source_hint = classify_source_origin(article)
                    signal_source = signal.get('source_attribution', '')
                    signal['source_attribution'] = signal_source or source_hint
                    verified_symbol_list = [t['symbol'] for t in signal.get('tickers', []) if isinstance(t, dict)]
                    signal['confidence'] = normalize_confidence(signal, verified_symbol_list, signal['source_attribution'])

                    # Expand reasoning with causal chain and source attribution.
                    root = signal.get('root_cause', '')
                    first_order = '; '.join(signal.get('first_order_effects', [])[:2])
                    second_order = '; '.join(signal.get('second_order_effects', [])[:2])
                    source_attr = signal.get('source_attribution', '')
                    base_reasoning = signal.get('reasoning', '')
                    details = [
                        f'Root cause: {root}' if root else '',
                        f'First-order effects: {first_order}' if first_order else '',
                        f'Second-order effects: {second_order}' if second_order else '',
                        f'Source attribution: {source_attr}' if source_attr else '',
                    ]
                    details_text = ' | '.join([x for x in details if x])
                    if details_text:
                        signal['reasoning'] = f'{base_reasoning} {details_text}'.strip()

                    signal.update({
                        'source_url': article.get('url', ''),
                        'source_headline': title,
                        'source_name': article.get('source', 'unknown'),
                        'article_published_at': article.get('publishedAt', ''),
                    })

                    if not signal.get('tickers'):
                        print('  no tickers found, skipping')
                        r.xack(STREAM_KEY, GROUP, msg_id)
                        continue

                    sid = save_signal(signal)
                    if sid:
                        # Phase 1: Conditional blocking based on maturity
                        published_at = signal.get('article_published_at', '')
                        is_mature = is_mature_signal(published_at)
                        
                        if is_mature:
                            # Mature signal (>= 24h old): wait for performance metrics before publishing
                            print(f'  signal {sid} is mature, fetching performance metrics...')
                            try:
                                track_performance(sid)
                                # Fetch performance records to include in publish
                                conn = get_connection()
                                try:
                                    with conn.cursor() as cur:
                                        cur.execute("SELECT row_to_json(sp) FROM signal_performance sp WHERE signal_id = %s", (sid,))
                                        signal['performance'] = [r[0] for r in cur.fetchall()]
                                finally:
                                    return_connection(conn)
                            except Exception as e:
                                print(f'  Warning: Performance tracking failed for mature signal: {e}')
                                signal['performance'] = []
                            
                            publish_signal(r, OUT_STREAM, signal, sid)
                            print(f'  saved mature signal {sid} with performance metrics -> {signal.get("tickers")}')
                        else:
                            # Fresh signal (< 24h old): publish immediately, queue for later tracking
                            print(f'  signal {sid} is fresh, publishing immediately...')
                            signal['performance'] = []
                            publish_signal(r, OUT_STREAM, signal, sid)
                            queue_immature_signal(r, signal, sid)
                            print(f'  saved fresh signal {sid} -> {signal.get("tickers")}')

                    r.xack(STREAM_KEY, GROUP, msg_id)

    except KeyboardInterrupt:
        print('Worker stopped')
        return 0
    except Exception as e:
        print('Worker error:', e)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())