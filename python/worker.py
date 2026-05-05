#!/usr/bin/env python3

import os
import re
import json
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
import redis
import psycopg2
from psycopg2.extras import Json
from google import genai


MAX_SIGNAL_AGE_HOURS = int(os.getenv('MAX_SIGNAL_AGE_HOURS', '72'))
QUOTE_LOOKUP_TIMEOUT_SEC = float(os.getenv('QUOTE_LOOKUP_TIMEOUT_SEC', '5'))
GEMINI_MAX_RETRIES = int(os.getenv('GEMINI_MAX_RETRIES', '4'))
GEMINI_RETRY_BASE_SEC = float(os.getenv('GEMINI_RETRY_BASE_SEC', '1.5'))
_TICKER_CACHE = {}


def load_environment() -> None:
    project_root = Path(__file__).resolve().parents[1]
    load_dotenv(project_root / '.env')


def ensure_signal_columns(conn_str: str) -> None:
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
    ]

    conn = None
    cur = None
    try:
        conn = psycopg2.connect(conn_str)
        cur = conn.cursor()
        for statement in statements:
            cur.execute(statement)
        conn.commit()
    finally:
        if cur is not None:
            cur.close()
        if conn is not None:
            conn.close()


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


def verify_ticker_exists(symbol: str) -> bool:
    """Verify ticker existence via live Yahoo Finance quote lookup.

    This is a pragmatic MVP guard to avoid hallucinated symbols.
    """
    symbol = (symbol or '').strip().upper()
    if not symbol:
        return False
    if symbol in _TICKER_CACHE:
        return _TICKER_CACHE[symbol]

    params = urllib.parse.urlencode({'symbols': symbol})
    url = f'https://query1.finance.yahoo.com/v7/finance/quote?{params}'
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})

    try:
        with urllib.request.urlopen(req, timeout=QUOTE_LOOKUP_TIMEOUT_SEC) as resp:
            payload = json.loads(resp.read().decode('utf-8', errors='replace'))
        results = payload.get('quoteResponse', {}).get('result', [])
        if not results:
            _TICKER_CACHE[symbol] = False
            return False
        row = results[0]
        quote_type = str(row.get('quoteType') or '').upper()
        market_price = row.get('regularMarketPrice')
        ok = quote_type in {'EQUITY', 'ETF'} and market_price is not None
        _TICKER_CACHE[symbol] = ok
        return ok
    except Exception:
        # Fallback: search endpoint usually works without auth where quote endpoint may return 401.
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

            if not exact:
                _TICKER_CACHE[symbol] = False
                return False

            qt = str(exact.get('quoteType', '')).upper()
            ok = qt in {'EQUITY', 'ETF'}
            _TICKER_CACHE[symbol] = ok
            return ok
        except Exception:
            _TICKER_CACHE[symbol] = False
            return False


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


def verify_tickers_exist(tickers):
    # Accept list of dicts or simple symbols; return list of verified symbol strings
    unique = []
    seen = set()
    for t in tickers or []:
        if isinstance(t, dict):
            s = str(t.get('symbol', '')).upper().strip()
        else:
            s = str(t).upper().strip()
        if not s or s in seen:
            continue
        seen.add(s)
        if verify_ticker_exists(s):
            unique.append(s)
    return unique


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
                normalized.append({
                    'id': str(item.get('id') or f'{relationship.lower().replace(" ", "-")}-{index}'),
                    'label': label,
                    'ticker': str(item.get('ticker') or item.get('symbol') or '').upper() or None,
                    'kind': str(item.get('kind') or item.get('type') or default_kind),
                    'direction': item_direction,
                    'conviction': str(item.get('conviction') or item.get('weight') or 'medium'),
                    'relationship': str(item.get('relationship') or relationship),
                    'why_it_matters': str(item.get('why_it_matters') or item.get('reason') or item.get('impact') or ''),
                    'children': normalize_items(children if isinstance(children, list) else [], 'concept', item_direction, f'{label} follow-through'),
                })
            else:
                label = str(item).strip()
                if not label:
                    continue
                normalized.append({
                    'id': f'{relationship.lower().replace(" ", "-")}-{index}',
                    'label': label,
                    'ticker': label.upper() if len(label) <= 5 and label.isalpha() else None,
                    'kind': default_kind,
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

            "{\n"
            "  \"tickers\": [{\"symbol\": \"TICKER1\", \"conviction\": \"high|medium|low\", \"impact\": \"positive|negative\"}],\n"
            "  \"direction\": \"BULLISH\"|\"BEARISH\"|\"MIXED\"|\"NEUTRAL\",\n"
            "  \"confidence\": 0-100,\n"
            "  \"time_horizon\": \"intraday\"|\"short-term\"|\"medium-term\",\n"
            "  \"geography\": \"country/region most relevant to the signal or 'unspecified'\",\n"
            "  \"root_cause\": \"actual event/decision/data point driving the news\",\n"
            "  \"first_order_effects\": [\"direct market/sector effects\"],\n"
            "  \"second_order_effects\": [\"downstream indirect effects\"],\n"
            "  \"positively_affected\": [\"ticker or asset names that benefit\"],\n"
            "  \"negatively_affected\": [\"ticker or asset names that are hurt\"],\n"
            "  \"source_attribution\": \"best guess of original source: filing/press release/central bank/etc\",\n"
            "  \"confidence_basis\": [\"factors used to assign confidence\"],\n"
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
            "            \"kind\": \"ticker|sector|supplier|customer|risk|theme\",\n"
            "            \"direction\": \"positive|negative|neutral\",\n"
            "            \"conviction\": \"high|medium|low\",\n"
            "            \"relationship\": \"why this node is connected to the root cause\",\n"
            "            \"why_it_matters\": \"1 short sentence with the market link\",\n"
            "            \"children\": [\n"
            "              {\"label\": \"Optional downstream or peer node\", \"ticker\": \"\", \"kind\": \"theme\", \"direction\": \"neutral\", \"conviction\": \"low\", \"relationship\": \"secondary read-through\", \"why_it_matters\": \"\", \"children\": []}\n"
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
            "  \"thesis_risks\": [\"Specific factors that would invalidate this signal\", \"Reasons this might already be priced in\"],\n"
            "  \"market_consensus_divergence\": \"Whether this confirms, contradicts, or introduces a market narrative — with a concrete reason why.\",\n"
            "  \"reasoning\": \"2-4 sentence causal explanation from event to market impact\"\n"
            "}\n\n"

            "## TICKER IDENTIFICATION\n"
            "Use the scratchpad to follow this chain:\n"
            "  1. What is the root cause of this event?\n"
            "  2. Which industries or supply chains does it directly affect?\n"
            "  3. Which publicly traded companies have material revenue exposure to that industry?\n"
            "  4. Who are the top 2-3 most exposed companies — high conviction tickers.\n"
            "  5. Who benefits indirectly as a second-order effect — medium conviction.\n"
            "  6. Who loses from the same chain — at least one negative impact ticker.\n"
            "- Before assigning any ticker, decide: does this company WIN or LOSE from the root cause? "
            "Cost-bearers are losers. Infrastructure/input suppliers are winners. "
            "Never assign a ticker without first determining which side of the trade it sits on.\n"
            "- If no individual ticker can be identified, use the most relevant sector ETF: "
            "XLK (tech), XLE (energy), XLF (financials), XLI (industrials), XLV (healthcare), ITA (defense).\n"
            "- Avoid broad index ETFs like QQQ or SPY unless the signal is explicitly macro.\n"
            "- Ensure all tickers are real NYSE/NASDAQ symbols. Do not hallucinate.\n"
            "- When geography is inferable, weight tickers to companies exposed to that region.\n\n"

            "## RELATIONSHIP GRAPH\n"
            "- Populate relationship_graph so the UI can render a branching tree, not just a flat list.\n"
            "- Include at least 3 branches whenever possible: primary tickers, direct effects, and either beneficiaries or headwinds.\n"
            "- Each branch should contain 2-4 nodes when the article supports that breadth.\n"
            "- Prefer explicit market relationships: supplier, customer, competitor, substitute, hedge, downstream beneficiary, downstream loser.\n"
            "- Give each node a short why_it_matters sentence so the UI can show connection strength.\n"
            "- Use nested children for second-order read-throughs or peers that emerge from the first branch.\n\n"

            "## DIRECTION & IMPACT\n"
            "- Do NOT rely on directional words in the headline. "
            "Infer direction from causal fundamentals only.\n"
            "- Never let short-term stock price reaction override fundamental cause-and-effect.\n"
            "- If the event has clear winners AND losers, set direction to MIXED.\n"
            "- Use NEUTRAL only when no sector is plausibly affected. If any sector is affected use BULLISH, BEARISH, or MIXED.\n"
            "- Every positive impact ticker must appear in positively_affected.\n"
            "- Every negative impact ticker must appear in negatively_affected.\n\n"

            "## BUSINESS MODEL NUANCE & CAUSALITY\n"
            "- Pay extremely close attention to the difference between PRODUCERS and SERVICES/EQUIPMENT providers.\n"
            "- Example: In a geopolitical conflict or supply disruption (e.g. Gulf conflict), oil producers (XOM, CVX, OXY) are BULLISH because reduced supply = higher commodity prices. However, oilfield service companies (SLB, HAL) are BEARISH because conflict freezes new capital expenditure, stops active drilling, and spikes insurance/logistics costs. They get paid to drill, not to sell oil.\n"
            "- Example 2: Escalation in conflict often leads to defense procurement, making defense contractors (LMT, RTX) BULLISH.\n"
            "- Always separate the commodity/product price effect from the operational/capex effect. Ensure your tickers reflect the exact business model's exposure.\n\n"

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
                normalized_tickers.append({'symbol': sym, 'conviction': conv})
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
    parsed['first_order_effects'] = [str(x) for x in parsed.get('first_order_effects', []) if str(x).strip()]
    parsed['second_order_effects'] = [str(x) for x in parsed.get('second_order_effects', []) if str(x).strip()]
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


def save_signal(conn_str: str, signal: dict) -> str:
    try:
        conn = psycopg2.connect(conn_str)
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
                relationship_graph
            ) VALUES (
                %s, %s, %s, %s, %s, %s, %s,
                %s, %s, %s, %s,
                %s, %s, %s,
                %s, %s, %s,
                %s, %s, %s, %s,
                %s
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
            # --- 14 new rich-signal columns ---
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
        )
        cur.execute(query, values)
        signal_id = cur.fetchone()[0]
        conn.commit()
        cur.close()
        conn.close()
        return str(signal_id)
    except Exception as e:
        print(f'Failed to save signal to DB: {e}')
        return None


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
        }
        r.xadd(stream, payload)
    except Exception as e:
        print(f'Failed to publish signal to Redis: {e}')


def main() -> int:
    load_environment()

    DATABASE_URL = os.getenv('DATABASE_URL')
    REDIS_URL = os.getenv('REDIS_URL')

    if not DATABASE_URL or not REDIS_URL:
        print('Missing DATABASE_URL or REDIS_URL in environment')
        return 1

    r = redis.from_url(REDIS_URL)

    try:
        ensure_signal_columns(DATABASE_URL)
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
                    # Heuristic fallback is optional and off by default.
                    try:
                        signal = generate_signal_with_gemini(article)
                    except Exception as gemini_err:
                        print(f'  Gemini failed, skipping article: {gemini_err}')
                        r.xack(STREAM_KEY, GROUP, msg_id)
                        continue



                    # Hard live verification: only keep real currently traded symbols.
                    # verify_tickers_exist returns list of verified symbol strings
                    verified_symbols = verify_tickers_exist(signal.get('tickers', []))
                    # Filter parsed tickers (objects) to only verified ones
                    kept = [t for t in signal.get('tickers', []) if isinstance(t, dict) and t.get('symbol') in verified_symbols]
                    # If signal had simple list form, convert verified symbols to medium conviction
                    if not kept and verified_symbols:
                        kept = [{'symbol': s, 'conviction': 'medium'} for s in verified_symbols]
                    signal['tickers'] = kept
                    signal['ticker_profiles'] = [lookup_ticker_profile(s) for s in verified_symbols]

                    # Source attribution and confidence normalization.
                    source_hint = classify_source_origin(article)
                    signal_source = signal.get('source_attribution', '')
                    signal['source_attribution'] = signal_source or source_hint
                    # For normalization pass, pass list of verified symbol strings
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
                    })

                    if not signal.get('tickers'):
                        print('  no tickers found, skipping')
                        r.xack(STREAM_KEY, GROUP, msg_id)
                        continue

                    sid = save_signal(DATABASE_URL, signal)
                    if sid:
                        publish_signal(r, OUT_STREAM, signal, sid)
                        print(f'  saved signal {sid} -> {signal.get("tickers")}')

                    r.xack(STREAM_KEY, GROUP, msg_id)

    except KeyboardInterrupt:
        print('Worker stopped')
        return 0
    except Exception as e:
        print('Worker error:', e)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())