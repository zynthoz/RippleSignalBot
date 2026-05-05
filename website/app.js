// MarketPulse AI - Web Dashboard App

let signals = [];
let displayedSignals = [];
let unseenSignalsCount = 0;
let activeFilter = 'ALL';
let searchQuery = '';
let activeSignalId = null;
let signalFeedContainer;
let analysisNodeContainer;
let centerPanel;
let newSignalIndicator;

// Formatting Utilities
function escapeHtml(value) {
    if (!value) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function parseMaybeJson(value, fallback) {
    if (value == null) return fallback;
    if (Array.isArray(value) || typeof value === 'object') return value;
    if (typeof value !== 'string') return fallback;
    try {
        return JSON.parse(value);
    } catch (e) {
        return fallback;
    }
}

function normalizeTickerList(value) {
    const list = parseMaybeJson(value, value);
    if (!Array.isArray(list)) return [];

    return list
        .map((item) => {
            if (typeof item === 'string') return item.trim().toUpperCase();
            if (item && typeof item === 'object') {
                return String(item.ticker || item.symbol || item.label || item.name || '').trim().toUpperCase();
            }
            return '';
        })
        .filter(Boolean);
}

function normalizeTextList(value) {
    const list = parseMaybeJson(value, value);
    if (!Array.isArray(list)) return [];

    return list
        .map((item) => {
            if (typeof item === 'string') return item.trim();
            if (item && typeof item === 'object') {
                return String(item.label || item.ticker || item.symbol || item.name || item.title || item.reason || item.why_it_matters || '').trim();
            }
            return '';
        })
        .filter(Boolean);
}

function normalizeGraphNode(node, fallbackRelationship = 'related exposure', fallbackTone = 'neutral') {
    if (!node) return null;

    if (typeof node === 'string') {
        const label = node.trim();
        if (!label) return null;
        return {
            id: label.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
            label,
            ticker: label.length <= 5 ? label.toUpperCase() : '',
            kind: 'theme',
            direction: fallbackTone,
            conviction: 'medium',
            relationship: fallbackRelationship,
            why_it_matters: '',
            children: [],
        };
    }

    if (typeof node !== 'object') return null;

    const label = String(node.label || node.ticker || node.symbol || node.name || node.title || node.reason || node.why_it_matters || '').trim();
    if (!label) return null;

    // Derive direction from 'direction' or 'impact' fields (Gemini returns impact per ticker).
    const rawDirection = String(node.direction || node.impact || fallbackTone || 'neutral').toLowerCase();

    return {
        id: String(node.id || label.toLowerCase().replace(/[^a-z0-9]+/g, '-')),
        label,
        ticker: String(node.ticker || node.symbol || '').trim().toUpperCase(),
        kind: String(node.kind || node.type || (node.ticker || node.symbol ? 'ticker' : 'theme')),
        direction: rawDirection,
        conviction: String(node.conviction || node.weight || 'medium').toLowerCase(),
        relationship: String(node.relationship || node.link || fallbackRelationship || '').trim(),
        why_it_matters: String(node.why_it_matters || node.reason || node.impact || '').trim(),
        children: Array.isArray(node.children)
            ? node.children.map((child) => normalizeGraphNode(child, `${label} follow-through`, rawDirection)).filter(Boolean)
            : [],
    };
}

function toneToColor(tone) {
    if (tone === 'positive' || tone === 'bullish') return 'secondary';
    if (tone === 'negative' || tone === 'bearish') return 'error';
    return 'primary-fixed-dim';
}

function buildFallbackGraph(signal) {
    const branches = [];
    const pushBranch = (label, items, tone) => {
        // For ticker items that are objects (from Gemini), preserve per-item impact/direction.
        const rawItems = parseMaybeJson(items, items);
        const nodes = (Array.isArray(rawItems) ? rawItems : [])
            .map((item) => normalizeGraphNode(item, label, tone))
            .filter(Boolean);
        if (nodes.length > 0) {
            branches.push({
                label,
                tone,
                nodes,
            });
        }
    };

    // Derive branch tone from signal direction; per-ticker impact overrides inside normalizeGraphNode.
    const primaryTone = signal.direction === 'BULLISH' ? 'positive' : signal.direction === 'BEARISH' ? 'negative' : signal.direction === 'MIXED' ? 'mixed' : 'neutral';
    pushBranch('Primary tickers', signal.tickers || [], primaryTone);
    pushBranch('Direct effects', signal.first_order_effects || [], 'neutral');
    pushBranch('Secondary effects', signal.second_order_effects || [], 'neutral');
    pushBranch('Beneficiaries', signal.positively_affected || [], 'positive');
    pushBranch('Headwinds', signal.negatively_affected || [], 'negative');
    pushBranch('Invalidators', signal.thesis_risks || [], 'neutral');

    const contextItems = [signal.market_consensus_divergence, signal.geography, signal.source_attribution].filter(Boolean);
    pushBranch('Context', contextItems, 'neutral');

    return {
        root: signal.root_cause || 'News Event Detected',
        branches,
    };
}

function buildTopologyModel(signal) {
    let topology;

    const graph = parseMaybeJson(signal.relationship_graph, null);
    if (graph && typeof graph === 'object' && Array.isArray(graph.branches)) {
        topology = {
            root: String(graph.root || signal.root_cause || 'News Event Detected').trim(),
            branches: graph.branches
                .map((branch) => {
                    if (!branch || typeof branch !== 'object') return null;
                    const nodes = Array.isArray(branch.nodes)
                        ? branch.nodes.map((node) => normalizeGraphNode(node, branch.label || 'related exposure', branch.tone || 'neutral')).filter(Boolean)
                        : [];
                    if (!nodes.length) return null;
                    return {
                        label: String(branch.label || 'Relationship branch').trim(),
                        tone: String(branch.tone || 'neutral').toLowerCase(),
                        nodes,
                    };
                })
                .filter(Boolean),
        };
    } else {
        topology = buildFallbackGraph(signal);
    }

    // --- Reconciliation pass ---
    // Ensure every ticker from the signal data appears in the topology graph.
    // Collect all ticker symbols already present in any branch.
    const presentTickers = new Set();
    topology.branches.forEach((branch) => {
        (branch.nodes || []).forEach((node) => {
            if (node.ticker) presentTickers.add(node.ticker.toUpperCase());
            // Also check children
            (node.children || []).forEach((child) => {
                if (child.ticker) presentTickers.add(child.ticker.toUpperCase());
            });
        });
    });

    // Build sets for impact classification
    const positiveSet = new Set(
        normalizeTextList(signal.positively_affected).map(s => s.toUpperCase())
    );
    const negativeSet = new Set(
        normalizeTextList(signal.negatively_affected).map(s => s.toUpperCase())
    );

    // Gather all tickers from the signal that should be shown
    const allSignalTickers = normalizeTickerList(signal.tickers);

    // Determine overall signal tone
    const sigDir = String(signal.direction || 'NEUTRAL').toUpperCase();
    const defaultTone = sigDir === 'BULLISH' ? 'positive' : sigDir === 'BEARISH' ? 'negative' : sigDir === 'MIXED' ? 'mixed' : 'neutral';

    // Find missing tickers
    const missingPrimary = [];
    const missingBeneficiaries = [];
    const missingHeadwinds = [];

    allSignalTickers.forEach((sym) => {
        if (presentTickers.has(sym)) return;

        // Look up per-ticker info from signal.tickers
        const rawTickers = parseMaybeJson(signal.tickers, []);
        let tickerMeta = null;
        if (Array.isArray(rawTickers)) {
            tickerMeta = rawTickers.find(
                (t) => typeof t === 'object' && t && String(t.symbol || t.ticker || '').toUpperCase() === sym
            );
        }

        const impact = tickerMeta ? String(tickerMeta.impact || tickerMeta.direction || '').toLowerCase() : '';
        const conviction = tickerMeta ? String(tickerMeta.conviction || 'medium').toLowerCase() : 'medium';

        let direction;
        if (impact === 'positive' || impact === 'bullish' || positiveSet.has(sym)) {
            direction = 'positive';
        } else if (impact === 'negative' || impact === 'bearish' || negativeSet.has(sym)) {
            direction = 'negative';
        } else {
            direction = defaultTone;
        }

        const node = {
            id: sym.toLowerCase(),
            label: sym,
            ticker: sym,
            kind: 'ticker',
            direction: direction,
            conviction: conviction,
            relationship: 'Identified ticker',
            why_it_matters: tickerMeta && tickerMeta.why_it_matters ? String(tickerMeta.why_it_matters) : '',
            children: [],
        };

        if (direction === 'positive') {
            missingBeneficiaries.push(node);
        } else if (direction === 'negative') {
            missingHeadwinds.push(node);
        } else {
            missingPrimary.push(node);
        }
    });

    // Also check positively_affected and negatively_affected for tickers not yet in the graph
    positiveSet.forEach((sym) => {
        if (presentTickers.has(sym) || missingPrimary.some(n => n.ticker === sym) || missingBeneficiaries.some(n => n.ticker === sym)) return;
        missingBeneficiaries.push({
            id: sym.toLowerCase() + '-beneficiary',
            label: sym,
            ticker: sym,
            kind: 'ticker',
            direction: 'positive',
            conviction: 'medium',
            relationship: 'Positively affected',
            why_it_matters: '',
            children: [],
        });
    });

    negativeSet.forEach((sym) => {
        if (presentTickers.has(sym) || missingPrimary.some(n => n.ticker === sym) || missingHeadwinds.some(n => n.ticker === sym)) return;
        missingHeadwinds.push({
            id: sym.toLowerCase() + '-headwind',
            label: sym,
            ticker: sym,
            kind: 'ticker',
            direction: 'negative',
            conviction: 'medium',
            relationship: 'Negatively affected',
            why_it_matters: '',
            children: [],
        });
    });

    // Inject missing nodes into existing branches or create new ones
    function findOrCreateBranch(label, tone) {
        let branch = topology.branches.find(
            (b) => b.label.toLowerCase() === label.toLowerCase()
        );
        if (!branch) {
            branch = { label, tone, nodes: [] };
            topology.branches.push(branch);
        }
        return branch;
    }

    if (missingPrimary.length > 0) {
        const branch = findOrCreateBranch('Primary tickers', defaultTone);
        branch.nodes.push(...missingPrimary);
    }
    if (missingBeneficiaries.length > 0) {
        const branch = findOrCreateBranch('Beneficiaries', 'positive');
        branch.nodes.push(...missingBeneficiaries);
    }
    if (missingHeadwinds.length > 0) {
        const branch = findOrCreateBranch('Headwinds', 'negative');
        branch.nodes.push(...missingHeadwinds);
    }

    return topology;
}

function timeAgo(dateString) {
    const date = new Date(dateString);
    const seconds = Math.floor((new Date() - date) / 1000);
    
    let interval = seconds / 31536000;
    if (interval > 1) return Math.floor(interval) + "y ago";
    interval = seconds / 2592000;
    if (interval > 1) return Math.floor(interval) + "mo ago";
    interval = seconds / 86400;
    if (interval > 1) return Math.floor(interval) + "d ago";
    interval = seconds / 3600;
    if (interval > 1) return Math.floor(interval) + "h ago";
    interval = seconds / 60;
    if (interval > 1) return Math.floor(interval) + "m ago";
    return seconds < 30 ? "Just now" : Math.floor(seconds) + "s ago";
}

function formatTicker(tickers) {
    const symbols = normalizeTickerList(tickers);
    if (symbols.length === 0) return 'N/A';
    return escapeHtml(symbols.join(' · '));
}

// Templates
function renderSignalCard(signal) {
    const isBull = signal.direction === 'BULLISH';
    const isBear = signal.direction === 'BEARISH';
    const color = isBull ? 'secondary' : isBear ? 'error' : 'primary-fixed-dim';
    const icon = isBull ? 'trending_up' : isBear ? 'trending_down' : 'horizontal_rule';
    const label = signal.direction;
    const ticker = formatTicker(signal.tickers);
    const conf = signal.confidence ?? 'N/A';
    const age = timeAgo(signal.created_at);
    const reasoningExcerpt = escapeHtml((signal.source_headline || signal.reasoning || '').substring(0, 40)) + '...';

    const isActive = signal.id === activeSignalId;
    const activeClasses = isActive ? 'bg-surface-variant ring-1 ring-primary' : 'bg-surface';

    return `
    <div class="${activeClasses} border border-outline-variant border-l-4 border-l-${color} p-2 cursor-pointer hover:bg-surface-variant transition-colors group" onclick="loadSignalDetails('${signal.id}')" data-id="${signal.id}">
        <div class="flex justify-between items-start mb-2">
            <div class="flex items-center gap-1 text-${color} font-label-caps text-label-caps">
                <span class="material-symbols-outlined text-[12px]">${icon}</span> ${label}
            </div>
            <span class="font-data-tabular text-data-tabular text-on-surface-variant text-[10px]">${age}</span>
        </div>
        <div class="font-data-tabular text-data-tabular text-on-surface text-sm mb-1 group-hover:text-primary transition-colors">${ticker}</div>
        <div class="flex justify-between items-end">
            <span class="font-body-compact text-body-compact text-on-surface-variant text-[11px]">${reasoningExcerpt}</span>
            <span class="font-data-tabular text-data-tabular text-${color} font-bold">${conf}%</span>
        </div>
    </div>`;
}

function renderTickerSignals(signal) {
    const tickers = parseMaybeJson(signal.tickers, []);
    if (!Array.isArray(tickers) || tickers.length === 0) return '';

    const positivelyAffected = new Set(
        normalizeTextList(signal.positively_affected).map(s => s.toUpperCase())
    );
    const negativelyAffected = new Set(
        normalizeTextList(signal.negatively_affected).map(s => s.toUpperCase())
    );

    const tickerRows = tickers.map((t) => {
        let sym, conviction, impact;
        if (typeof t === 'object' && t !== null) {
            sym = String(t.symbol || t.ticker || '').toUpperCase();
            conviction = String(t.conviction || 'medium').toLowerCase();
            impact = String(t.impact || t.direction || '').toLowerCase();
        } else {
            sym = String(t).toUpperCase();
            conviction = 'medium';
            impact = '';
        }
        if (!sym) return '';

        // Derive impact from positively/negatively affected lists if not set per-ticker.
        if (!impact || impact === 'neutral') {
            if (positivelyAffected.has(sym)) impact = 'positive';
            else if (negativelyAffected.has(sym)) impact = 'negative';
            else if (signal.direction === 'BULLISH') impact = 'positive';
            else if (signal.direction === 'BEARISH') impact = 'negative';
            else impact = 'neutral';
        }

        const isPositive = impact === 'positive' || impact === 'bullish';
        const isNegative = impact === 'negative' || impact === 'bearish';
        const impactColor = isPositive ? 'secondary' : isNegative ? 'error' : 'primary-fixed-dim';
        const impactIcon = isPositive ? 'trending_up' : isNegative ? 'trending_down' : 'horizontal_rule';
        const impactLabel = isPositive ? 'BULLISH' : isNegative ? 'BEARISH' : 'NEUTRAL';

        const convColor = conviction === 'high' ? 'text-secondary' : conviction === 'low' ? 'text-on-surface-variant opacity-60' : 'text-on-surface-variant';

        return `
            <div class="flex items-center justify-between py-1.5 px-2 bg-surface-container rounded-sm">
                <div class="flex items-center gap-2">
                    <span class="material-symbols-outlined text-[16px] text-${impactColor}">${impactIcon}</span>
                    <span class="font-data-tabular text-data-tabular text-on-surface text-sm font-bold">${escapeHtml(sym)}</span>
                </div>
                <div class="flex items-center gap-2">
                    <span class="font-label-caps text-label-caps ${convColor} text-[9px]">${escapeHtml(conviction.toUpperCase())}</span>
                    <span class="font-label-caps text-label-caps text-${impactColor} text-[9px] bg-${impactColor}/10 px-1.5 py-0.5 rounded-sm">${impactLabel}</span>
                </div>
            </div>`;
    }).filter(Boolean);

    if (tickerRows.length === 0) return '';

    return `
        <div class="flex flex-col gap-2">
            <div class="font-label-caps text-label-caps text-on-surface-variant">TICKER SIGNALS</div>
            <div class="flex flex-col gap-1">
                ${tickerRows.join('')}
            </div>
        </div>`;
}

function renderAnalysisNode(signal) {
    const isBull = signal.direction === 'BULLISH';
    const isBear = signal.direction === 'BEARISH';
    const color = isBull ? 'secondary' : isBear ? 'error' : 'primary-fixed-dim';
    const icon = isBull ? 'trending_up' : isBear ? 'trending_down' : 'horizontal_rule';
    
    // Process JSONB arrays safely
    const catalystChain = normalizeTextList(signal.catalyst_chain);
    
    let catalystHtml = '';
    if (catalystChain.length > 0) {
        catalystHtml = catalystChain.map((step, idx) => `
            <div class="flex items-center gap-2">
                <span class="material-symbols-outlined text-[16px] text-outline">article</span>
                <span class="font-body-compact text-body-compact text-on-surface text-xs">${escapeHtml(step)}</span>
            </div>
            ${idx < catalystChain.length - 1 ? `
            <div class="flex ml-2 border-l border-outline-variant pl-4 py-1">
                <span class="material-symbols-outlined text-[16px] text-outline self-center">arrow_downward</span>
            </div>` : ''}
        `).join('');
    } else {
        catalystHtml = `<span class="text-on-surface-variant text-xs italic">No causal chain data available.</span>`;
    }

    return `
    <div class="px-cell-padding-x py-cell-padding-y border-b border-outline-variant bg-surface-container-low flex justify-between items-center">
        <h2 class="font-headline-sm text-headline-sm text-on-surface">Analysis Node</h2>
        <span class="material-symbols-outlined text-outline cursor-pointer hover:text-on-surface" onclick="clearAnalysisNode()">close</span>
    </div>
    <div class="flex-1 overflow-y-auto p-4 flex flex-col gap-6 bg-surface-dim">
        <!-- Header Status -->
        <div class="flex flex-col items-center text-center">
            <div class="w-16 h-16 rounded-full border-2 border-${color} flex items-center justify-center shadow-[0_0_16px_rgba(var(--${color}-rgb, 0,0,0),0.2)] mb-3">
                <span class="material-symbols-outlined text-[32px] text-${color}">${icon}</span>
            </div>
            <div class="font-display-ticker text-display-ticker text-on-surface">${formatTicker(signal.tickers)}</div>
            <div class="font-label-caps text-label-caps text-${color} tracking-widest mt-1">${signal.direction}</div>
        </div>

        <!-- Per-Ticker Signals -->
        ${renderTickerSignals(signal)}

        <!-- News Details -->
        <div class="flex flex-col gap-2">
            <div class="font-label-caps text-label-caps text-on-surface-variant">CATALYST NEWS</div>
            <div class="bg-surface-container p-3 border border-outline-variant rounded-sm flex flex-col gap-2">
                ${signal.source_name ? `<div class="text-xs font-label-caps text-primary">${escapeHtml(signal.source_name)}</div>` : ''}
                <div class="text-sm font-headline-sm text-on-surface">${escapeHtml(signal.source_headline || 'Unknown News Source')}</div>
                ${signal.source_url ? `<a href="${escapeHtml(signal.source_url)}" target="_blank" rel="noopener noreferrer" class="text-xs text-primary hover:underline flex items-center gap-1 mt-1"><span class="material-symbols-outlined text-[14px]">open_in_new</span> View Source Article</a>` : ''}
            </div>
        </div>

        <!-- Metrics Grid -->
        <div class="grid grid-cols-2 gap-panel-gap">
            <div class="bg-surface-container-low p-2 border border-outline-variant rounded-sm">
                <div class="font-label-caps text-label-caps text-on-surface-variant mb-1">CONFIDENCE</div>
                <div class="font-data-tabular text-data-tabular text-${color} text-lg">${signal.confidence ?? 'N/A'}%</div>
            </div>
            <div class="bg-surface-container-low p-2 border border-outline-variant rounded-sm">
                <div class="font-label-caps text-label-caps text-on-surface-variant mb-1">IMPACT HORIZON</div>
                <div class="font-data-tabular text-data-tabular text-on-surface text-lg">${escapeHtml(signal.time_horizon || 'Unknown')}</div>
            </div>
        </div>

        <!-- Causal Chain -->
        <div class="flex flex-col gap-2">
            <div class="font-label-caps text-label-caps text-on-surface-variant">CAUSAL CHAIN</div>
            <div class="bg-surface-container p-3 border border-outline-variant rounded-sm flex flex-col">
                ${catalystHtml}
            </div>
        </div>

        <!-- AI Reasoning -->
        <div class="flex flex-col gap-2 mb-4">
            <div class="font-label-caps text-label-caps text-on-surface-variant">AI REASONING</div>
            <p class="font-body-compact text-body-compact text-on-surface text-xs leading-relaxed text-justify opacity-80">
                ${escapeHtml(signal.reasoning || 'No reasoning provided.')}
            </p>
        </div>
    </div>
    `;
}

function getStyleColor(tone) {
    const t = String(tone).toLowerCase();
    if (t.includes('bull') || t.includes('positive') || t.includes('beneficiary')) return '#a3ffb4'; // Vibrant light green
    if (t.includes('bear') || t.includes('negative') || t.includes('hit')) return '#ff7a7a'; // Vibrant light red
    if (t.includes('mixed')) return '#ffcf56'; // Amber for mixed signals
    return '#8d99ae'; // Cool grey
}

function renderCenterGraph(signal) {
    if (!signal) {
        centerPanel.innerHTML = `<div class="flex-1 flex items-center justify-center text-on-surface-variant font-body-compact opacity-50">Select a signal to view catalyst chain graph</div>`;
        return;
    }

    const topology = buildTopologyModel(signal);

    centerPanel.innerHTML = `<div class="px-cell-padding-x py-cell-padding-y border-b border-outline-variant bg-surface-container-low flex justify-between items-center z-10 relative">
            <h2 class="font-headline-sm text-headline-sm text-on-surface">Catalyst Topology</h2>
            <button id="reheat-btn" class="text-on-surface-variant p-1 rounded hover:bg-surface-bright transition-colors flex items-center justify-center bg-transparent border-none" title="Reset Layout">
                <span class="material-symbols-outlined text-[18px]">refresh</span>
            </button>
        </div>
        <div id="d3-container" class="flex-1 w-full relative z-0 overflow-hidden outline-none bg-[#1e1e1e]" tabindex="0">
            <div id="d3-tooltip" class="absolute pointer-events-none opacity-0 transition-opacity z-50 text-sm" style="top: 16px; right: 16px; background: rgba(0,0,0,0.85); border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 12px; min-width: 260px; max-width: 320px; color: #fff;"></div>
            <div id="d3-legend" class="absolute top-3 left-3 z-40 pointer-events-none flex flex-wrap gap-x-3 gap-y-1" style="font-size:10px; font-family:sans-serif; color:#999;">
                <span><span style="color:#4a90e2;">●</span> Root Cause</span>
                <span><span style="color:#ffcf56;">◆</span> Direct Effect</span>
                <span><span style="color:#6cb4d9;">◆</span> Ripple Effect</span>
                <span><span style="color:#a3ffb4;">●</span> Beneficiary</span>
                <span><span style="color:#ff7a7a;">●</span> Headwind</span>
                <span><span style="color:#ff6b6b;">◇</span> Risk</span>
            </div>
            <div id="d3-caption" class="absolute bottom-4 left-4 right-4 bg-black/60 text-white/90 p-4 rounded-lg border border-white/10 text-sm font-sans backdrop-blur-sm z-40 pointer-events-none">
                <strong style="color: #4a90e2;">ROOT CAUSE:</strong> ${escapeHtml(topology.root)}
            </div>
        </div>`;

    setTimeout(() => { initD3Graph(signal, topology); }, 0);
}

// Concise label extractor: pulls first N meaningful words from a sentence
function shortLabel(text, maxWords = 4) {
    if (!text) return '';
    // Remove common prefixes like "Step N:" or leading articles
    let cleaned = text.replace(/^(step\s*\d+\s*[:.]\s*)/i, '').trim();
    const words = cleaned.split(/\s+/).filter(Boolean);
    if (words.length <= maxWords) return cleaned;
    return words.slice(0, maxWords).join(' ');
}

// Well-known ticker → company name lookup
const TICKER_COMPANIES = {
    AAPL:'Apple',MSFT:'Microsoft',GOOGL:'Alphabet',GOOG:'Alphabet',AMZN:'Amazon',META:'Meta Platforms',
    NVDA:'NVIDIA',TSLA:'Tesla',AMD:'AMD',INTC:'Intel',AVGO:'Broadcom',QCOM:'Qualcomm',TXN:'Texas Instruments',
    AMAT:'Applied Materials',LRCX:'Lam Research',KLAC:'KLA Corp',ASML:'ASML',MU:'Micron',
    CRM:'Salesforce',ORCL:'Oracle',ADBE:'Adobe',NOW:'ServiceNow',SNOW:'Snowflake',PLTR:'Palantir',
    JPM:'JPMorgan Chase',BAC:'Bank of America',GS:'Goldman Sachs',MS:'Morgan Stanley',WFC:'Wells Fargo',C:'Citigroup',
    V:'Visa',MA:'Mastercard',PYPL:'PayPal',SQ:'Block',COIN:'Coinbase',
    NFLX:'Netflix',DIS:'Disney',CMCSA:'Comcast',SNAP:'Snap',CRWD:'CrowdStrike',
    XOM:'ExxonMobil',CVX:'Chevron',OXY:'Occidental',SLB:'Schlumberger',COP:'ConocoPhillips',
    BA:'Boeing',LMT:'Lockheed Martin',RTX:'RTX/Raytheon',GD:'General Dynamics',NOC:'Northrop Grumman',
    GE:'GE Aerospace',HON:'Honeywell',CAT:'Caterpillar',DE:'John Deere',MMM:'3M',
    UNH:'UnitedHealth',JNJ:'Johnson & Johnson',PFE:'Pfizer',LLY:'Eli Lilly',ABBV:'AbbVie',MRK:'Merck',
    GEHC:'GE HealthCare',ABT:'Abbott Labs',TMO:'Thermo Fisher',ISRG:'Intuitive Surgical',
    WMT:'Walmart',COST:'Costco',TGT:'Target',HD:'Home Depot',LOW:"Lowe's",AMGN:'Amgen',
    KO:'Coca-Cola',PEP:'PepsiCo',MCD:"McDonald's",SBUX:'Starbucks',NKE:'Nike',
    APD:'Air Products',LIN:'Linde',ECL:'Ecolab',SHW:'Sherwin-Williams',DD:'DuPont',
    NEE:'NextEra Energy',VST:'Vistra',CEG:'Constellation Energy',ETR:'Entergy',SO:'Southern Company',
    SPY:'S&P 500 ETF',QQQ:'Nasdaq 100 ETF',XLK:'Tech Select ETF',XLE:'Energy Select ETF',
    XLF:'Financial Select ETF',XLV:'Health Care ETF',XLI:'Industrial Select ETF',ITA:'US Aerospace & Defense ETF',
    UAL:'United Airlines',DAL:'Delta Air Lines',LUV:'Southwest Airlines',AAL:'American Airlines',
    JBLU:'JetBlue',DLTR:'Dollar Tree',RH:'RH/Restoration Hardware',LVMUY:'LVMH',
    F:'Ford',GM:'General Motors',RIVN:'Rivian',LCID:'Lucid',
    SLV:'Silver ETF',GLD:'Gold ETF',USO:'Oil ETF',XLP:'Consumer Staples ETF',
    MRK:'Merck',GILD:'Gilead Sciences',BIIB:'Biogen',REGN:'Regeneron',MRNA:'Moderna',
};

function getCompanyName(sym) {
    return TICKER_COMPANIES[sym.toUpperCase()] || '';
}

function initD3Graph(signal, topology) {
    const container = document.getElementById('d3-container');
    const width = container.clientWidth;
    const height = container.clientHeight;
    const cx = width / 2, cy = height / 2;

    const nodes = [];
    const links = [];
    let _nid = 0;
    const nid = (pfx) => `${pfx}_${_nid++}`;

    // --- Classify tickers ---
    const positiveSet = new Set(normalizeTextList(signal.positively_affected).map(s => s.toUpperCase()));
    const negativeSet = new Set(normalizeTextList(signal.negatively_affected).map(s => s.toUpperCase()));
    const allTickers = normalizeTickerList(signal.tickers);
    const rawTickerList = parseMaybeJson(signal.tickers, []);

    function tickerMeta(sym) {
        if (!Array.isArray(rawTickerList)) return null;
        return rawTickerList.find(t => typeof t === 'object' && t && String(t.symbol || t.ticker || '').toUpperCase() === sym) || null;
    }

    function tickerImpact(sym) {
        const m = tickerMeta(sym);
        const imp = m ? String(m.impact || m.direction || '').toLowerCase() : '';
        if (imp === 'positive' || imp === 'bullish' || positiveSet.has(sym)) return 'positive';
        if (imp === 'negative' || imp === 'bearish' || negativeSet.has(sym)) return 'negative';
        return 'neutral';
    }

    // === Layer 0: ROOT CAUSE ===
    const rootId = 'root';
    nodes.push({
        id: rootId, label: 'ROOT CAUSE', group: 'root', layer: 0,
        radius: 28, color: '#4a90e2', shape: 'circle',
        detail: signal.market_consensus_divergence || topology.root || 'Initial Catalyst',
        directionInfo: '', conviction: 'high'
    });

    // === Layer 1: First-order effects ===
    const firstOrder = normalizeTextList(signal.first_order_effects);
    const foIds = [];
    firstOrder.forEach((txt) => {
        const id = nid('fo');
        foIds.push(id);
        nodes.push({
            id, label: shortLabel(txt), group: 'first_order', layer: 1,
            radius: 14, color: '#ffcf56', shape: 'diamond',
            detail: txt, directionInfo: 'DIRECT EFFECT', conviction: 'high'
        });
        links.push({ source: rootId, target: id, value: 7, color: '#ffcf56', reason: 'Direct impact', dashed: false });
    });

    // === Layer 2: Second-order effects ===
    const secondOrder = normalizeTextList(signal.second_order_effects);
    const soIds = [];
    secondOrder.forEach((txt, idx) => {
        const id = nid('so');
        soIds.push(id);
        nodes.push({
            id, label: shortLabel(txt), group: 'second_order', layer: 2,
            radius: 10, color: '#6cb4d9', shape: 'diamond',
            detail: txt, directionInfo: 'RIPPLE EFFECT', conviction: 'medium'
        });
        const parentId = foIds.length > 0 ? foIds[idx % foIds.length] : rootId;
        links.push({ source: parentId, target: id, value: 5, color: '#6cb4d9', reason: 'Downstream ripple', dashed: false });
    });

    // === Layer 3: Ticker nodes ===
    const deepestEffects = soIds.length > 0 ? soIds : foIds.length > 0 ? foIds : [rootId];

    allTickers.forEach((sym, idx) => {
        const impact = tickerImpact(sym);
        const m = tickerMeta(sym);
        const conv = m ? String(m.conviction || 'medium') : 'medium';
        const col = impact === 'positive' ? '#a3ffb4' : impact === 'negative' ? '#ff7a7a' : '#8d99ae';
        const id = nid('tk');
        const why = m && m.why_it_matters ? String(m.why_it_matters) : `${impact.toUpperCase()} impact on ${sym}`;
        const company = getCompanyName(sym);

        nodes.push({
            id, label: sym, ticker: sym, companyName: company, group: 'ticker', layer: 3,
            radius: 20, color: col, shape: 'circle',
            detail: why, directionInfo: impact.toUpperCase() + ' IMPACT', conviction: conv
        });

        // Connect beneficiaries to second-order effects (they profit from the ripple)
        // Connect headwinds to first-order effects (they are directly hit)
        let parentPool;
        if (impact === 'positive') {
            parentPool = soIds.length > 0 ? soIds : foIds.length > 0 ? foIds : [rootId];
        } else if (impact === 'negative') {
            parentPool = foIds.length > 0 ? foIds : soIds.length > 0 ? soIds : [rootId];
        } else {
            parentPool = deepestEffects;
        }
        const parent = parentPool[idx % parentPool.length];
        links.push({ source: parent, target: id, value: 4, color: col, reason: impact + ' exposure', dashed: false });
    });

    // === Risks / Invalidators ===
    const risks = normalizeTextList(signal.thesis_risks);
    risks.slice(0, 3).forEach((txt) => {
        const id = nid('risk');
        nodes.push({
            id, label: shortLabel(txt), group: 'risk', layer: 'risk',
            radius: 6, color: '#ff6b6b', shape: 'diamond',
            detail: txt, directionInfo: 'INVALIDATOR', conviction: 'low'
        });
        links.push({ source: rootId, target: id, value: 2, color: '#ff6b6b', reason: 'Thesis risk', dashed: true });
    });

    // Initialize all nodes near the center with random jitter to prevent them from flying in from (0,0)
    // Jitter ensures dx/dy are never precisely 0 in the custom force layer.
    nodes.forEach(n => { n.x = cx + Math.random() * 2 - 1; n.y = cy + Math.random() * 2 - 1; });

    // ========== D3 Rendering ==========
    d3.select("#d3-container").select("svg").remove();

    const zoom = d3.zoom().scaleExtent([0.2, 4]).on("zoom", (event) => g.attr("transform", event.transform));
    // Start slightly zoomed out (0.85) to ensure nodes aren't cut off at the edges
    const initialTransform = d3.zoomIdentity.translate(cx, cy).scale(0.85).translate(-cx, -cy);

    const svg = d3.select("#d3-container").append("svg")
        .attr("width", width).attr("height", height).call(zoom);

    const g = svg.append("g");

    // Now that `g` exists, apply the initial zoom transform to center the view
    svg.call(zoom.transform, initialTransform)
        .on("dblclick.zoom", () => {
            svg.transition().duration(750).call(zoom.transform, initialTransform);
        });

    svg.on("click", () => { pinnedNode = null; hideTooltip(); resetFocus(); });

    const defs = svg.append("defs");
    // Glow filter for root node
    const glow = defs.append("filter").attr("id", "glow").attr("x", "-50%").attr("y", "-50%").attr("width", "200%").attr("height", "200%");
    glow.append("feGaussianBlur").attr("stdDeviation", "4").attr("result", "blur");
    glow.append("feMerge").selectAll("feMergeNode").data(["blur", "SourceGraphic"]).enter().append("feMergeNode").attr("in", d => d);

    // Arrow markers
    ['#4a90e2', '#a3ffb4', '#ff7a7a', '#8d99ae', '#ffcf56', '#6cb4d9', '#ff6b6b'].forEach(color => {
        defs.append("marker").attr("id", "arr-" + color.replace('#', ''))
            .attr("viewBox", "0 -4 8 8").attr("refX", 18).attr("refY", 0)
            .attr("markerWidth", 5).attr("markerHeight", 5).attr("orient", "auto")
            .append("path").attr("d", "M0,-4L8,0L0,4").attr("fill", color).attr("opacity", 0.5);
    });

    // Layer distance from center
    const layerRadius = { 0: 0, 1: Math.min(width, height) * 0.16, 2: Math.min(width, height) * 0.28, 3: Math.min(width, height) * 0.40, risk: Math.min(width, height) * 0.24 };

    // Custom radial-layer force
    function forceLayer(strength) {
        let ns;
        function force(alpha) {
            for (const n of ns) {
                const targetR = layerRadius[n.layer] || 0;
                if (targetR === 0) { n.vx += (cx - n.x) * strength * alpha; n.vy += (cy - n.y) * strength * alpha; continue; }
                const dx = n.x - cx, dy = n.y - cy;
                const r = Math.sqrt(dx * dx + dy * dy) || 1;
                const diff = (targetR - r) * strength * alpha;
                n.vx += (dx / r) * diff;
                n.vy += (dy / r) * diff;
            }
        }
        force.initialize = (_nodes) => { ns = _nodes; };
        return force;
    }

    const simulation = d3.forceSimulation(nodes)
        .force("link", d3.forceLink(links).id(d => d.id).distance(d => {
            if (d.dashed) return 80;
            return 70 + (d.value || 0) * 4;
        }).strength(0.7))
        .force("charge", d3.forceManyBody().strength(d => d.group === 'root' ? -900 : d.group === 'risk' ? -150 : -350))
        .force("layer", forceLayer(0.15))
        .force("collide", d3.forceCollide().radius(d => d.radius + 16).strength(0.8));

    // Links
    const link = g.append("g").selectAll("line").data(links).enter().append("line")
        .attr("stroke", d => d.dashed ? '#ff6b6b44' : '#444')
        .attr("stroke-width", d => d.dashed ? 1 : Math.max(1, d.value * 0.3))
        .attr("stroke-dasharray", d => d.dashed ? "6,4" : "none")
        .attr("opacity", 0.7)
        .attr("marker-end", d => "url(#arr-" + d.color.replace('#', '') + ")");

    // Link labels (relationship reason on hover visibility handled via CSS)
    const linkLabel = g.append("g").selectAll("text").data(links).enter().append("text")
        .text(d => d.reason || '')
        .attr("font-size", "8px").attr("fill", "#555").attr("text-anchor", "middle")
        .attr("font-family", "sans-serif").style("pointer-events", "none").attr("opacity", 0);

    // Nodes
    const node = g.append("g").selectAll("g").data(nodes).enter().append("g")
        .call(d3.drag().on("start", dragstarted).on("drag", dragged).on("end", dragended));

    // Draw shapes based on group
    node.each(function(d) {
        const el = d3.select(this);
        if (d.shape === 'diamond') {
            const s = d.radius;
            el.append("path")
                .attr("d", `M0,${-s} L${s},0 L0,${s} L${-s},0 Z`)
                .attr("fill", d.color).attr("opacity", 0.9)
                .attr("stroke", d.color).attr("stroke-width", 1).attr("stroke-opacity", 0.4);
        } else {
            el.append("circle")
                .attr("r", d.radius).attr("fill", d.color)
                .attr("filter", d.group === 'root' ? "url(#glow)" : null)
                .attr("opacity", d.group === 'root' ? 1 : 0.85);
        }
    });

    // Labels — tickers always visible; effect/risk labels hidden until hover
    const nodeLabel = node.append("text")
        .text(d => {
            if (d.group === 'ticker') return d.ticker || d.label;
            if (d.group === 'root') return '';
            return truncate(d.label, 28);
        })
        .attr("dx", d => d.radius + 5).attr("dy", 4)
        .attr("fill", d => d.group === 'root' ? '#4a90e2' : d.group === 'risk' ? '#ff6b6b99' : d.group === 'ticker' ? '#ddd' : '#999')
        .attr("font-size", d => d.group === 'ticker' ? "12px" : "9px")
        .attr("font-weight", d => d.group === 'ticker' ? "600" : "400")
        .attr("font-family", "sans-serif").style("pointer-events", "none")
        .attr("opacity", d => (d.group === 'ticker') ? 1 : 0);

    // Tooltip & interaction
    const tooltip = d3.select("#d3-tooltip");
    let pinnedNode = null;

    function focusNode(d) {
        const connected = new Set([d.id]);
        links.forEach(l => {
            const sid = typeof l.source === 'object' ? l.source.id : l.source;
            const tid = typeof l.target === 'object' ? l.target.id : l.target;
            if (sid === d.id) connected.add(tid);
            if (tid === d.id) connected.add(sid);
        });
        node.transition().duration(200).style("opacity", o => connected.has(o.id) ? 1 : 0.12);
        // Reveal labels for connected nodes
        nodeLabel.transition().duration(200).attr("opacity", o => connected.has(o.id) ? 1 : 0);
        link.transition().duration(200).style("opacity", o => {
            const sid = typeof o.source === 'object' ? o.source.id : o.source;
            const tid = typeof o.target === 'object' ? o.target.id : o.target;
            return (sid === d.id || tid === d.id) ? 0.9 : 0.04;
        });
        linkLabel.transition().duration(200).attr("opacity", o => {
            const sid = typeof o.source === 'object' ? o.source.id : o.source;
            const tid = typeof o.target === 'object' ? o.target.id : o.target;
            return (sid === d.id || tid === d.id) ? 1 : 0;
        });
    }

    function resetFocus() {
        node.transition().duration(200).style("opacity", 1);
        // Hide effect/risk labels again, keep ticker labels
        nodeLabel.transition().duration(200).attr("opacity", d => d.group === 'ticker' ? 1 : 0);
        link.transition().duration(200).style("opacity", 0.7);
        linkLabel.transition().duration(200).attr("opacity", 0);
    }

    function showTooltip(d) {
        const groupLabel = { root: 'ROOT CAUSE', first_order: 'DIRECT EFFECT', second_order: 'RIPPLE EFFECT', ticker: 'TICKER', risk: 'THESIS RISK' }[d.group] || d.group;
        tooltip.transition().duration(200).style("opacity", 1);
        tooltip.html(
            `<div style="font-size:9px;letter-spacing:0.08em;color:${d.color};margin-bottom:4px;">${groupLabel}</div>` +
            (d.ticker ? `<div style="font-weight:bold;font-size:18px;margin-bottom:1px;">${escapeHtml(d.ticker)}</div>` : '') +
            (d.companyName ? `<div style="font-size:11px;color:#aaa;margin-bottom:6px;">${escapeHtml(d.companyName)}</div>` : '') +
            (!d.ticker ? `<div style="margin-bottom:6px;font-size:13px;font-weight:600;color:#eee;">${escapeHtml(d.label)}</div>` : '') +
            (d.directionInfo ? `<span style="background:rgba(255,255,255,0.08);padding:2px 8px;border-radius:4px;font-size:10px;color:${d.color}">${d.directionInfo}</span> ` : '') +
            (d.conviction ? `<span style="font-size:10px;color:#888;">${d.conviction.toUpperCase()} conviction</span>` : '') +
            `<div style="margin-top:8px;font-size:11px;color:#bbb;line-height:1.4;">${escapeHtml(d.detail)}</div>`
        );
    }

    function hideTooltip() { tooltip.transition().duration(200).style("opacity", 0); }

    node.on("mouseover", (event, d) => { if (pinnedNode && pinnedNode.id !== d.id) return; focusNode(d); if (!pinnedNode) showTooltip(d); })
        .on("mouseout", () => { if (pinnedNode) return; resetFocus(); hideTooltip(); })
        .on("click", (event, d) => { event.stopPropagation(); pinnedNode = d; focusNode(d); showTooltip(d); });

    document.getElementById('reheat-btn').addEventListener('click', (e) => { e.stopPropagation(); simulation.alpha(1).restart(); });

    simulation.on("tick", () => {
        link.attr("x1", d => d.source.x).attr("y1", d => d.source.y).attr("x2", d => d.target.x).attr("y2", d => d.target.y);
        linkLabel.attr("x", d => (d.source.x + d.target.x) / 2).attr("y", d => (d.source.y + d.target.y) / 2);
        node.attr("transform", d => `translate(${d.x},${d.y})`);
    });

    function dragstarted(event, d) { if (!event.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; }
    function dragged(event, d) { d.fx = event.x; d.fy = event.y; }
    function dragended(event, d) { if (!event.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }

    const resizeObserver = new ResizeObserver(entries => {
        for (let entry of entries) {
            const nw = entry.contentRect.width, nh = entry.contentRect.height;
            svg.attr("width", nw).attr("height", nh);
            simulation.force("layer", forceLayer(0.12));
            simulation.alpha(0.3).restart();
        }
    });
    resizeObserver.observe(container);
}

function truncate(str, max) { if (!str) return ''; return str.length > max ? str.substring(0, max) + '...' : str; }


// Logic Functions
async function fetchSignals() {
    const startTime = performance.now();
    try {
        const res = await fetch('/api/signals?limit=50');
        if (res.ok) {
            signals = await res.json();
            displayedSignals = [...signals];
            renderSignalFeed();
            updateFilterCounts();
        }
    } catch (e) {
        console.error("Failed to fetch signals", e);
        signalFeedContainer.innerHTML = `<div class="text-error p-4 text-center text-sm">Pipeline Offline</div>`;
    }
}


function renderSignalFeed() {
    let filtered = displayedSignals;
    if (activeFilter !== 'ALL') {
        filtered = filtered.filter(s => s.direction === activeFilter);
    }
    
    if (searchQuery) {
        filtered = filtered.filter(s => {
            const t = (s.tickers ? JSON.stringify(s.tickers) : '').toLowerCase();
            const r = (s.reasoning || s.source_headline || '').toLowerCase();
            return t.includes(searchQuery) || r.includes(searchQuery);
        });
    }
    
    if (filtered.length === 0) {
        signalFeedContainer.innerHTML = `<div class="text-on-surface-variant p-4 text-center text-sm italic">No signals found.</div>`;
        return;
    }
    
    signalFeedContainer.innerHTML = filtered.map(renderSignalCard).join('');
}

function updateFilterCounts() {
    const counts = {
        ALL: signals.length,
        BULL: signals.filter(s => s.direction === 'BULLISH').length,
        BEAR: signals.filter(s => s.direction === 'BEARISH').length
    };
    
    document.getElementById('filter-ALL').textContent = `ALL (${counts.ALL})`;
    document.getElementById('filter-BULL').textContent = `BULL (${counts.BULL})`;
    document.getElementById('filter-BEAR').textContent = `BEAR (${counts.BEAR})`;
}

function setFilter(filter) {
    activeFilter = filter;
    ['ALL', 'BULL', 'BEAR'].forEach(f => {
        const btn = document.getElementById('filter-' + f);
        if (f === filter) {
            btn.classList.add('bg-primary', 'text-on-primary', 'border-primary');
            btn.classList.remove('text-on-surface-variant', 'border-outline-variant');
        } else {
            btn.classList.remove('bg-primary', 'text-on-primary', 'border-primary');
            btn.classList.add('text-on-surface-variant', 'border-outline-variant');
        }
    });
    renderSignalFeed();
}

async function loadSignalDetails(id) {
    activeSignalId = id;
    // Highlight active card
    document.querySelectorAll('#signal-feed > div').forEach(el => {
        el.classList.remove('bg-surface-variant', 'ring-1', 'ring-primary');
        el.classList.add('bg-surface');
        if (el.dataset.id === id) {
            el.classList.remove('bg-surface');
            el.classList.add('bg-surface-variant', 'ring-1', 'ring-primary');
        }
    });

    try {
        const res = await fetch('/api/signals/' + id);
        if (res.ok) {
            const signal = await res.json();
            analysisNodeContainer.innerHTML = renderAnalysisNode(signal);
            renderCenterGraph(signal);
        }
    } catch(e) {
        console.error("Failed to load signal details", e);
    }
}

function clearAnalysisNode() {
    analysisNodeContainer.innerHTML = `
        <div class="px-cell-padding-x py-cell-padding-y border-b border-outline-variant bg-surface-container-low flex justify-between items-center">
            <h2 class="font-headline-sm text-headline-sm text-on-surface">Analysis Node</h2>
        </div>
        <div class="flex-1 flex items-center justify-center text-on-surface-variant text-sm p-4 text-center opacity-50">
            Select a signal from the feed to view full causal analysis.
        </div>
    `;
    activeSignalId = null;
    renderCenterGraph(null);
    document.querySelectorAll('#signal-feed > div').forEach(el => {
        el.classList.remove('bg-surface-variant', 'ring-1', 'ring-primary');
        el.classList.add('bg-surface');
    });
}

function executeHedge(btn) {
    btn.textContent = "EXECUTED";
    btn.classList.remove('bg-primary/10', 'text-primary');
    btn.classList.add('bg-secondary', 'text-on-secondary');
    setTimeout(() => {
        btn.textContent = "EXECUTE HEDGE SCRIPT";
        btn.classList.add('bg-primary/10', 'text-primary');
        btn.classList.remove('bg-secondary', 'text-on-secondary');
    }, 2000);
}

function setupSSE() {
    const evtSource = new EventSource('/api/events');
    evtSource.onmessage = (e) => {
        try {
            const signal = JSON.parse(e.data);
            
            // Avoid duplicates
            if (!signals.find(s => s.id === signal.id)) {
                signals.unshift(signal); // Prepend to array
                
                // Show pill instead of forcing scroll jump
                unseenSignalsCount++;
                const pill = document.getElementById('new-signal-pill');
                document.getElementById('new-signal-count').textContent = unseenSignalsCount;
                pill.classList.remove('hidden');
                
                updateFilterCounts();
            }
        } catch(err) {
            console.error("Error processing SSE", err);
        }
    };
    
    evtSource.onerror = (err) => {
        console.error("SSE Error", err);
        // EventSource auto-reconnects
    };
}

// Initialization
document.addEventListener('DOMContentLoaded', () => {
    signalFeedContainer = document.getElementById('signal-feed');
    analysisNodeContainer = document.getElementById('analysis-node');
    centerPanel = document.getElementById('center-panel');
    newSignalIndicator = document.getElementById('new-signal-indicator');

    document.getElementById('filter-ALL').addEventListener('click', () => setFilter('ALL'));
    document.getElementById('filter-BULL').addEventListener('click', () => setFilter('BULLISH'));
    document.getElementById('filter-BEAR').addEventListener('click', () => setFilter('BEARISH'));

    document.getElementById('signal-search').addEventListener('input', (e) => {
        searchQuery = e.target.value.toLowerCase();
        renderSignalFeed();
    });

    document.getElementById('new-signal-pill').addEventListener('click', () => {
        displayedSignals = [...signals];
        unseenSignalsCount = 0;
        document.getElementById('new-signal-pill').classList.add('hidden');
        renderSignalFeed();
        signalFeedContainer.scrollTop = 0;
    });

    // Initial load
    clearAnalysisNode();
    fetchSignals();
    
    // Start SSE stream
    setupSSE();
});
