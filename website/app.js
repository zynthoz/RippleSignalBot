// ARGUS AI - Web Dashboard App

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
let currentPage = 1;
const pageSize = 10;
let isTopologyFullscreen = false;
let topologyViewMode = 'topology';
let activeTopologySignal = null;
const API_BASE_URL = String(window.API_BASE_URL || '').trim().replace(/\/$/, '');

function apiUrl(path) {
    const normalizedPath = String(path || '');
    if (!API_BASE_URL) return normalizedPath;
    return `${API_BASE_URL}${normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`}`;
}

function apiFetch(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('ngrok-skip-browser-warning', 'true');
    return fetch(apiUrl(path), {
        ...options,
        headers,
    });
}

// Auth & User state
let currentUser = null;
let sessionToken = localStorage.getItem('mp_session_token') || null;
let notifPollInterval = null;

function authHeaders() {
    return sessionToken ? { 'Authorization': 'Bearer ' + sessionToken, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
}

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

    const looksLikeTicker = (value) => {
        const text = String(value || '').trim().toUpperCase();
        return Boolean(text) && text.length <= 5 && /^[A-Z]+$/.test(text);
    };

    if (typeof node === 'string') {
        const label = node.trim();
        if (!label) return null;
        return {
            id: label.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
            label,
            ticker: looksLikeTicker(label) ? label.toUpperCase() : '',
            kind: looksLikeTicker(label) ? 'ticker' : 'theme',
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

    const ticker = String(node.ticker || node.symbol || '').trim().toUpperCase();
    const kind = String(node.kind || node.type || '').trim().toLowerCase() || (ticker || looksLikeTicker(label) ? 'ticker' : 'theme');

    return {
        id: String(node.id || label.toLowerCase().replace(/[^a-z0-9]+/g, '-')),
        label,
        ticker,
        kind: ticker ? kind : (kind === 'ticker' && !looksLikeTicker(label) ? 'theme' : kind),
        direction: rawDirection,
        conviction: String(node.conviction || node.weight || 'medium').toLowerCase(),
        relationship: String(node.relationship || node.link || fallbackRelationship || '').trim(),
        why_it_matters: String(node.why_it_matters || node.details || node.reason || node.impact || '').trim(),
        exposure_pct: String(node.exposure_pct || '').trim(),
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
            .map((item) => {
                // Ensure item is properly parsed if it came as a stringified dict
                let parsed = item;
                if (typeof item === 'string' && item.startswith('{')) {
                    try {
                        // Try to parse as JSON first
                        parsed = JSON.parse(item);
                    } catch {
                        // If that fails, keep original
                    }
                }
                return normalizeGraphNode(parsed, label, tone);
            })
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
    
    // Tickers
    const tickers = normalizeTickerList(signal.tickers);
    const tickerHtml = tickers.length > 0 
        ? tickers.map(t => `<span class="font-code font-bold text-body-strong">${escapeHtml(t)}</span>`).join(', ')
        : `<span class="font-code text-muted">N/A</span>`;

    // Confidence
    const confVal = parseInt(signal.confidence, 10) || 0;
    let confColor = 'error';
    if (confVal >= 80) confColor = 'secondary';
    else if (confVal >= 60) confColor = 'accent-violet';

    const age = timeAgo(signal.created_at);
    const reasoningExcerpt = escapeHtml((signal.source_headline || signal.reasoning || '').substring(0, 55)) + '...';

    const isActive = signal.id === activeSignalId;
    const activeClasses = isActive ? `bg-surface-card-elevated border-l-${color}` : 'bg-transparent border-l-transparent';
    const icon = isBull ? 'trending_up' : isBear ? 'trending_down' : 'horizontal_rule';
    const opacityClass = isActive ? 'opacity-100' : 'opacity-90';

    return `
    <div class="${activeClasses} border-l-[2px] border-y border-r border-hairline p-3 cursor-pointer hover:bg-surface-card-elevated hover:border-l-${color} transition-all group rounded-none mb-2 last:mb-0" onclick="loadSignalDetails('${signal.id}')" data-id="${signal.id}">
        <div class="flex justify-between items-center mb-1.5">
            <div class="flex items-center gap-1.5">
                <span class="material-symbols-outlined text-[14px] text-${color}">${icon}</span>
                <span class="text-[10px] font-code text-${color} uppercase tracking-wider">${signal.direction}</span>
            </div>
            <span class="font-code text-muted text-[10px]">${age}</span>
        </div>
        <div class="text-[13px] leading-snug mb-2 font-body">
            ${tickerHtml} <span class="text-muted mx-1">:</span> <span class="text-body-strong">${escapeHtml(signal.source_headline || 'Event Detected')}</span>
        </div>
        <div class="flex justify-between items-end">
            <div class="font-body-compact text-muted text-[11px] leading-snug ${opacityClass} group-hover:opacity-100 transition-opacity max-w-[80%] truncate">${reasoningExcerpt}</div>
            <span class="font-code text-[12px] text-${confColor}">${confVal}%</span>
        </div>
    </div>`;
}

function renderInlineTickers(signal) {
    const tickers = parseMaybeJson(signal.tickers, []);
    if (!Array.isArray(tickers) || tickers.length === 0) return '';
    
    const positivelyAffected = new Set(normalizeTextList(signal.positively_affected).map(s => s.toUpperCase()));
    const negativelyAffected = new Set(normalizeTextList(signal.negatively_affected).map(s => s.toUpperCase()));

    const pills = tickers.map(t => {
        let sym, impact;
        if (typeof t === 'object' && t !== null) {
            sym = String(t.symbol || t.ticker || '').toUpperCase();
            impact = String(t.impact || t.direction || '').toLowerCase();
        } else {
            sym = String(t).toUpperCase();
            impact = '';
        }
        if (!sym) return '';

        if (!impact || impact === 'neutral') {
            if (positivelyAffected.has(sym)) impact = 'positive';
            else if (negativelyAffected.has(sym)) impact = 'negative';
            else if (signal.direction === 'BULLISH') impact = 'positive';
            else if (signal.direction === 'BEARISH') impact = 'negative';
            else impact = 'neutral';
        }

        const isPositive = impact === 'positive' || impact === 'bullish';
        const isNegative = impact === 'negative' || impact === 'bearish';
        const pillColor = isPositive ? 'secondary' : isNegative ? 'error' : 'primary-fixed-dim';
        const pillBg = isPositive ? 'bg-secondary/10' : isNegative ? 'bg-error/10' : 'bg-primary-fixed-dim/10';
        const pillIcon = isPositive ? 'trending_up' : isNegative ? 'trending_down' : 'horizontal_rule';

        return `<div class="flex items-center gap-1.5 px-2.5 py-1 rounded-sm border border-${pillColor}/30 ${pillBg} text-${pillColor}">
            <span class="material-symbols-outlined text-[14px]">${pillIcon}</span>
            <span class="font-code font-bold text-[12px] uppercase tracking-wider">${escapeHtml(sym)}</span>
        </div>`;
    }).filter(Boolean);

    return `<div class="flex flex-wrap justify-center gap-2 mb-8">${pills.join('')}</div>`;
}

function formatReasoning(text) {
    if (!text) return '<p class="text-on-surface-variant/50 italic">No reasoning provided.</p>';
    
    let paragraphs = text.split(/\n\n+/);
    if (paragraphs.length === 1) {
        if (text.length > 200) {
            const matches = text.match(/[^.!?]+[.!?]+/g);
            if (matches && matches.length > 2) {
                paragraphs = [];
                for(let i=0; i<matches.length; i+=2) {
                    paragraphs.push((matches[i] + (matches[i+1]||'')).trim());
                }
            }
        }
    }
    
    if (paragraphs.length >= 3) {
        return `
            <div class="mb-3">
                <div class="text-xs text-primary font-medium mb-1">The Catalyst</div>
                <div class="text-[13px] leading-relaxed text-on-surface-variant">${escapeHtml(paragraphs[0])}</div>
            </div>
            <div class="mb-3">
                <div class="text-xs text-primary font-medium mb-1">Market Mechanism</div>
                <div class="text-[13px] leading-relaxed text-on-surface-variant">${escapeHtml(paragraphs[1])}</div>
            </div>
            <div>
                <div class="text-xs text-primary font-medium mb-1">Expected Outcome</div>
                <div class="text-[13px] leading-relaxed text-on-surface-variant">${escapeHtml(paragraphs.slice(2).join(' '))}</div>
            </div>
        `;
    }
    
    return paragraphs.map(p => `<p class="text-[13px] leading-relaxed text-on-surface-variant mb-2 last:mb-0">${escapeHtml(p)}</p>`).join('');
}

function renderContagionSection(signal) {
    // Parse contagion data
    let contagionPath = [];
    if (signal.contagion_path) {
        if (typeof signal.contagion_path === 'string') {
            try { contagionPath = JSON.parse(signal.contagion_path); } catch(e){}
        } else if (Array.isArray(signal.contagion_path)) {
            contagionPath = signal.contagion_path;
        }
    }

    const chokepoint = String(signal.chokepoint || '').trim();
    const vulnType = String(signal.vulnerability_type || '').trim().toLowerCase();

    // Don't render if no contagion data
    if (!contagionPath.length && !chokepoint && (!vulnType || vulnType === 'none')) return '';

    const vulnLabels = {
        supply_disruption: 'SUPPLY DISRUPTION',
        demand_shift: 'DEMAND SHIFT',
        regulatory_shock: 'REGULATORY SHOCK',
        infrastructure_failure: 'INFRASTRUCTURE FAILURE',
        geopolitical_contagion: 'GEOPOLITICAL CONTAGION',
    };
    const vulnColors = {
        supply_disruption: '#ff6b35',
        demand_shift: '#fbbf24',
        regulatory_shock: '#a855f7',
        infrastructure_failure: '#ff4d4d',
        geopolitical_contagion: '#e879f9',
    };

    const vulnLabel = vulnLabels[vulnType] || '';
    const vulnColor = vulnColors[vulnType] || '#8d99ae';

    const depTypeGlyphs = {
        chokepoint: '⬡',
        supplier: '▼',
        customer: '▲',
        substitute: '⟳',
    };
    const depTypeColors = {
        chokepoint: '#ff6b35',
        supplier: '#e879f9',
        customer: '#fbbf24',
        substitute: '#34d399',
    };

    let pathHtml = '';
    if (chokepoint) {
        pathHtml += `<div class="flex items-start gap-2 mb-2">
            <span style="color:#ff6b35;" class="text-[14px] mt-px">⬡</span>
            <div>
                <div class="text-body-strong text-[12px] font-code font-semibold">${escapeHtml(chokepoint)}</div>
                <div class="text-[10px] text-muted font-code tracking-wider uppercase">CHOKEPOINT</div>
            </div>
        </div>`;
    }

    contagionPath.forEach((entry, idx) => {
        if (!entry || typeof entry !== 'object') return;
        const ticker = String(entry.ticker || '').trim();
        const depType = String(entry.dependency_type || '').toLowerCase();
        const exposure = String(entry.exposure_pct || '').trim();
        const mechanism = String(entry.mechanism || '').trim();
        const glyph = depTypeGlyphs[depType] || '●';
        const color = depTypeColors[depType] || '#8d99ae';
        const depLabel = depType.replace(/_/g, ' ').toUpperCase();

        pathHtml += `<div class="flex items-start gap-2 ${idx > 0 ? 'mt-1' : ''} pl-4 border-l border-hairline-strong ml-[6px]">
            <span style="color:${color};" class="text-[12px] mt-px -ml-[10px]">${glyph}</span>
            <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                    <span class="text-body-strong text-[12px] font-code font-semibold">${escapeHtml(ticker || '—')}</span>
                    ${exposure ? `<span class="bg-surface-card-elevated border border-hairline-strong px-1.5 py-0.5 rounded text-[9px] font-code font-bold" style="color:${color}">${escapeHtml(exposure)}</span>` : ''}
                    <span class="text-[9px] text-muted font-code tracking-wider">${escapeHtml(depLabel)}</span>
                </div>
                ${mechanism ? `<div class="text-[11px] text-body font-code leading-snug mt-0.5 opacity-80">${escapeHtml(mechanism)}</div>` : ''}
            </div>
        </div>`;
    });

    return `
        <div class="flex flex-col mb-6">
            <div class="flex items-center gap-2 mb-3">
                <div class="text-[10px] text-muted font-code tracking-widest uppercase">CONTAGION PATH</div>
                ${vulnLabel ? `<span class="text-[9px] font-code font-bold tracking-wider px-1.5 py-0.5 rounded-sm border" style="color:${vulnColor}; border-color:${vulnColor}40; background:${vulnColor}10;">${vulnLabel}</span>` : ''}
            </div>
            <div class="flex flex-col border border-hairline-strong bg-transparent p-4 gap-1">
                ${pathHtml || '<div class="text-[11px] text-muted font-code">No supply chain dependencies detected for this signal.</div>'}
            </div>
        </div>
    `;
}

function renderPerformanceSection(signal) {
    let perfData = [];
    if (signal.performance) {
        if (typeof signal.performance === 'string') {
            try { perfData = JSON.parse(signal.performance); } catch(e){}
        } else if (Array.isArray(signal.performance)) {
            perfData = signal.performance;
        }
    }
    
    perfData = perfData.filter(p => p && p.ticker);
    if (perfData.length === 0) return '';
    
    const rowsHtml = perfData.map(p => {
        const isCorrect = p.direction_correct;
        const icon = isCorrect === true ? '<span class="text-secondary font-bold">✓</span>' : isCorrect === false ? '<span class="text-error font-bold">✗</span>' : '<span class="text-muted font-bold">-</span>';
        const returnSign = p.return_pct > 0 ? '+' : '';
        const returnColor = p.return_pct > 0 ? 'secondary' : p.return_pct < 0 ? 'error' : 'muted';
        const entry = parseFloat(p.entry_price || 0).toFixed(2);
        const check = parseFloat(p.check_price || 0).toFixed(2);
        const retPct = parseFloat(p.return_pct || 0).toFixed(2);
        
        return `
            <div class="flex items-center justify-between py-2 border-b border-hairline-strong last:border-0">
                <div class="flex items-center gap-2">
                    <span class="font-code font-bold text-[13px] text-body-strong">${escapeHtml(p.ticker)}</span>
                    <span class="text-[10px] text-muted bg-transparent border border-hairline-strong px-1.5 py-0.5 rounded-sm uppercase tracking-wider font-code">${escapeHtml(p.check_interval)}</span>
                </div>
                <div class="flex items-center gap-3 text-[12px] font-code">
                    <span class="text-muted" title="Entry Price">E: $${entry}</span>
                    <span class="text-muted" title="Check Price">C: $${check}</span>
                    <span class="text-${returnColor} font-bold min-w-[50px] text-right">${returnSign}${retPct}%</span>
                    <div class="w-4 text-center ml-1 text-[10px]">${icon}</div>
                </div>
            </div>
        `;
    }).join('');

    return `
            <!-- Performance -->
            <div class="flex flex-col mb-6">
                <div class="text-[10px] text-muted font-code tracking-widest mb-1 uppercase">PERFORMANCE</div>
                <div class="text-[10px] text-muted/70 mb-2 italic font-code">Based on price at article publish date</div>
                <div class="border border-hairline-strong bg-transparent p-2 px-3">
                    ${rowsHtml}
                </div>
            </div>
    `;
}

function renderAnalysisNode(signal) {
    const isBull = signal.direction === 'BULLISH';
    const isBear = signal.direction === 'BEARISH';
    const color = isBull ? 'secondary' : isBear ? 'error' : 'primary-fixed-dim';
    const tickerList = normalizeTickerList(signal.tickers);
    const primaryTicker = (tickerList[0] || '').replace(/'/g, '');
    
    const catalystChain = normalizeTextList(signal.catalyst_chain);
    
    let catalystHtml = '';
    if (catalystChain.length > 0) {
        catalystHtml = catalystChain.map((step, idx) => {
            const isFirst = idx === 0;
            const opacity = isFirst ? '100' : Math.max(50, 90 - (idx * 15));
            const ringColor = isFirst ? `ring-2 ring-${color}/50` : 'ring-1 ring-hairline-strong';
            const dotColor = isFirst ? `bg-${color}` : 'bg-hairline-strong';
            const textColor = isFirst ? 'text-body-strong font-semibold' : 'text-body';
            
            return `
            <div class="flex items-start gap-3">
                <span class="material-symbols-outlined text-[14px] text-muted mt-0.5">schema</span>
                <div class="font-code text-[11px] text-body-strong leading-relaxed">${escapeHtml(step)}</div>
            </div>
            ${idx < catalystChain.length - 1 ? `<div class="text-muted ml-1 text-[12px] font-code py-1">↓</div>` : ''}`;
        }).join('');
    } else {
        catalystHtml = `<div class="text-muted text-xs italic pb-4">No causal chain data available.</div>`;
    }

    let domain = '';
    try {
        domain = signal.source_url ? new URL(signal.source_url).hostname.replace('www.','') : '';
    } catch (e) {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=32` : '';

    const confVal = parseInt(signal.confidence, 10) || 0;
    const isOverconfident = confVal >= 95;
    let horizonText = escapeHtml(signal.time_horizon || 'Unknown');
    if (horizonText.toLowerCase().includes('short')) horizonText += ' <span class="text-muted text-xs font-normal">(1-4 weeks)</span>';
    else if (horizonText.toLowerCase().includes('medium')) horizonText += ' <span class="text-muted text-xs font-normal">(1-6 months)</span>';
    else if (horizonText.toLowerCase().includes('long')) horizonText += ' <span class="text-muted text-xs font-normal">(6+ months)</span>';

    return `
    <div class="px-cell-padding-x border-b border-hairline bg-surface-card flex justify-between items-center shrink-0 w-full" style="height: 40px;">
        <div class="flex items-center gap-2 cursor-pointer hover:text-body-strong text-muted transition-colors" onclick="clearAnalysisNode()" title="Back to default view">
            <span class="material-symbols-outlined text-[16px]">close</span>
            <h2 class="font-code text-[11px] tracking-widest uppercase text-muted">Analysis Node</h2>
        </div>
        <div class="flex items-center gap-2">
            <button onclick="openWatchlistForSignal('${escapeHtml(primaryTicker)}', '${escapeHtml(signal.direction || '')}', ${confVal})" class="bg-transparent hover:text-primary text-muted p-1 transition-colors" title="Set Alert">
                <span class="material-symbols-outlined text-[16px]">add_alert</span>
            </button>
        </div>
    </div>
    
    <div class="flex-1 overflow-y-auto flex flex-col bg-canvas-deep relative">
        <div class="p-5 flex-1 flex flex-col">
            <!-- Hero Section -->
            <div class="flex flex-col items-center justify-center mt-6 mb-8 gap-2">
                <div class="w-16 h-16 rounded-full border border-${color} flex items-center justify-center text-${color} bg-${color}/10 mb-2 shadow-[0_0_15px_rgba(var(--${color}-rgb,0,0,0),0.2)]">
                    <span class="material-symbols-outlined text-3xl">${isBull ? 'trending_up' : isBear ? 'trending_down' : 'horizontal_rule'}</span>
                </div>
                <div class="text-2xl font-bold font-code tracking-widest text-body-strong">${primaryTicker}</div>
                <div class="text-[10px] font-code text-${color} tracking-widest uppercase">STRONG ${signal.direction}</div>
            </div>

            <!-- Inline Tickers -->
            ${renderInlineTickers(signal)}

            <!-- Catalyst News -->
            <div class="flex flex-col mb-6">
                <div class="bg-transparent border border-hairline-strong p-3 hover:border-hairline transition-colors group relative overflow-hidden">
                    <div class="flex items-center gap-2 mb-2">
                        ${faviconUrl ? `<img src="${faviconUrl}" class="w-3 h-3 grayscale opacity-70 group-hover:grayscale-0 group-hover:opacity-100 transition-all" alt="source"/>` : `<span class="material-symbols-outlined text-[12px] text-muted">newspaper</span>`}
                        <span class="font-code text-[10px] text-muted group-hover:text-primary transition-colors uppercase">${escapeHtml(signal.source_name || domain || 'News Source')}</span>
                        <span class="text-muted/30 text-[10px]">•</span>
                        <span class="font-code text-[10px] text-muted/70">${timeAgo(signal.created_at)}</span>
                    </div>
                    <div class="text-[13px] font-body text-body-strong leading-snug mb-3">${escapeHtml(signal.source_headline || 'Unknown News Source')}</div>
                    ${signal.source_url ? `<a href="${escapeHtml(signal.source_url)}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-primary text-[10px] font-code hover:text-primary-glow transition-colors w-fit"><span class="material-symbols-outlined text-[12px]">open_in_new</span> READ ARTICLE</a>` : ''}
                </div>
            </div>

            <!-- Metrics Grid -->
            <div class="grid grid-cols-2 gap-0 mb-6 border border-hairline-strong bg-canvas-deep">
                <div class="p-3 border-r border-hairline-strong">
                    <div class="text-[10px] text-muted font-code tracking-widest mb-2 uppercase">CONFIDENCE</div>
                    <div class="font-code text-xl text-${color}">${confVal}%</div>
                </div>
                <div class="p-3">
                    <div class="text-[10px] text-muted font-code tracking-widest mb-2 uppercase">IMPACT HORIZON</div>
                    <div class="font-code text-sm text-body-strong uppercase">${horizonText}</div>
                </div>
            </div>

            <!-- Causal Chain -->
            <div class="flex flex-col mb-6">
                <div class="text-[10px] text-muted font-code tracking-widest mb-3 uppercase">CAUSAL CHAIN</div>
                <div class="flex flex-col border border-hairline-strong bg-transparent p-4">
                    ${catalystHtml}
                </div>
            </div>

            ${renderContagionSection(signal)}

            ${renderPerformanceSection(signal)}

            <!-- AI Reasoning -->
            <div class="flex flex-col mb-20">
                <div class="text-[10px] text-muted font-code tracking-widest mb-3 uppercase">AI REASONING</div>
                <div class="font-code text-[11px] leading-relaxed text-body text-justify">
                    ${formatReasoning(signal.reasoning)}
                </div>
            </div>
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

function syncTopologyFullscreenButton() {
    const btn = document.getElementById('topology-fullscreen-btn');
    if (!btn) return;

    const icon = isTopologyFullscreen ? 'fullscreen_exit' : 'fullscreen';
    const title = isTopologyFullscreen ? 'Exit Full Screen' : 'Full Screen';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.innerHTML = `<span class="material-symbols-outlined text-[18px]">${icon}</span>`;
}

function refreshTopologyLayout() {
    if (!activeTopologySignal) return;
    renderCenterGraph(activeTopologySignal);
}

function setTopologyFullscreen(enabled) {
    if (!centerPanel || !signalFeedContainer || !analysisNodeContainer) return;

    isTopologyFullscreen = enabled;

    signalFeedContainer.style.display = enabled ? 'none' : '';
    analysisNodeContainer.style.display = enabled ? 'none' : '';

    centerPanel.style.position = enabled ? 'fixed' : '';
    centerPanel.style.top = enabled ? '0' : '';
    centerPanel.style.right = enabled ? '0' : '';
    centerPanel.style.bottom = enabled ? '0' : '';
    centerPanel.style.left = enabled ? '0' : '';
    centerPanel.style.zIndex = enabled ? '100' : '';
    centerPanel.style.width = enabled ? '100vw' : '';
    centerPanel.style.height = enabled ? '100vh' : '';
    centerPanel.style.margin = enabled ? '0' : '';
    centerPanel.style.borderRadius = enabled ? '0' : '';
    centerPanel.style.boxShadow = enabled ? 'none' : '';

    document.body.style.overflow = enabled ? 'hidden' : '';

    syncTopologyFullscreenButton();
    setTimeout(refreshTopologyLayout, 0);
}

function attachTopologyFullscreenButton() {
    const btn = document.getElementById('topology-fullscreen-btn');
    if (!btn) return;

    btn.onclick = (e) => {
        e.stopPropagation();
        setTopologyFullscreen(!isTopologyFullscreen);
    };

    syncTopologyFullscreenButton();
}

function renderCenterGraph(signal) {
    activeTopologySignal = signal || null;

    if (!signal) {
        centerPanel.innerHTML = `
        <div class="px-cell-padding-x border-b border-hairline flex justify-between items-center bg-surface-card shrink-0 w-full z-10" style="height: 40px;">
            <h2 class="font-code text-[11px] uppercase tracking-widest text-muted">Catalyst Topology</h2>
            <button id="topology-fullscreen-btn" class="text-muted p-1 rounded-sm hover:bg-surface-card-elevated transition-colors flex items-center justify-center bg-transparent border-none" title="Full Screen" aria-label="Full Screen">
                <span class="material-symbols-outlined text-[16px]">fullscreen</span>
            </button>
        </div>
        <div class="flex-1 flex flex-col items-center justify-center text-muted p-6 text-center h-full w-full bg-canvas-deep">
            <div class="w-16 h-16 rounded-sm bg-surface-card flex items-center justify-center mb-6 border border-hairline-strong shadow-lg shadow-black/20">
                <span class="material-symbols-outlined text-[32px] text-muted/20">account_tree</span>
            </div>
            <div class="text-[12px] font-code text-body-strong mb-1 uppercase tracking-wider">Awaiting Catalyst</div>
            <div class="text-[11px] font-code text-muted/60 max-w-[280px]">SELECT A SIGNAL TO RENDER TOPOLOGY GRAPH AND CAUSAL NETWORK.</div>
        </div>`;
        attachTopologyFullscreenButton();
        return;
    }

    const topology = buildTopologyModel(signal);

    centerPanel.innerHTML = `<div class="px-cell-padding-x border-b border-hairline bg-surface-card flex justify-between items-center shrink-0 w-full z-10" style="height: 40px;">
            <h2 class="font-code text-[11px] uppercase tracking-widest text-muted">Catalyst Topology</h2>
            <div class="flex items-center gap-1">
                <button id="topology-view-btn" class="text-muted px-2 py-1 rounded-sm hover:bg-surface-card-elevated transition-colors flex items-center justify-center gap-1 bg-transparent border-none" title="Impact View" aria-label="Impact View">
                    <span class="material-symbols-outlined text-[16px]">insights</span>
                    <span class="text-[11px] font-code tracking-widest uppercase">Impact View</span>
                </button>
                <button id="reheat-btn" class="text-muted p-1 rounded-sm hover:bg-surface-card-elevated transition-colors flex items-center justify-center bg-transparent border-none" title="Fit to Screen" aria-label="Fit to Screen">
                    <span class="material-symbols-outlined text-[16px]">center_focus_strong</span>
                </button>
                <button id="topology-fullscreen-btn" class="text-muted p-1 rounded-sm hover:bg-surface-card-elevated transition-colors flex items-center justify-center bg-transparent border-none" title="Full Screen" aria-label="Full Screen">
                    <span class="material-symbols-outlined text-[16px]">fullscreen</span>
                </button>
            </div>
        </div>
        <div id="d3-container" class="flex-1 w-full relative z-0 overflow-hidden outline-none bg-canvas" tabindex="0">
            <div id="d3-tooltip" class="absolute pointer-events-none opacity-0 transition-opacity z-50 text-sm bg-surface-card-elevated border border-hairline rounded-lg p-4 shadow-xl shadow-black/50" style="top: 16px; right: 16px; min-width: 260px; max-width: 320px; color: var(--on-surface);"></div>
            ${renderTopologyLegend()}
            ${topologyViewMode === 'impact' ? '' : `
            <div id="d3-caption" class="absolute bottom-6 left-1/2 -translate-x-1/2 bg-surface-card/60 backdrop-blur-xl text-body-strong px-6 py-3 rounded-full border border-hairline text-sm z-40 pointer-events-none shadow-lg shadow-black/50 leading-relaxed whitespace-nowrap">
                <strong class="font-bold text-primary tracking-widest text-[11px] mr-2">ROOT CAUSE:</strong> <span class="opacity-90">${escapeHtml(topology.root)}</span>
            </div>`}
        </div>`;

    attachTopologyViewButton();
    attachTopologyFullscreenButton();

    setTimeout(() => {
        if (topologyViewMode === 'impact') {
            initImpactGraph(signal, topology);
        } else {
            initD3Graph(signal, topology);
        }
    }, 0);
}

// Concise label extractor: pulls first N meaningful words from a sentence
function shortLabel(text, maxWords = 4) {
    if (!text) return '';
    // Remove common prefixes like "Step N:" or leading articles
    let cleaned = text.replace(/^(step\s*\d+\s*[:.]\s*)/i, '').trim();
    const words = cleaned.split(/\s+/).filter(Boolean);
    if (words.length <= maxWords) return cleaned;
    return words.slice(0, maxWords).join(' ') + '...';
}

function compactImpactLabel(text, maxWords = 7) {
    if (!text) return '';
    // Extract label from object if provided
    const val = (typeof text === 'object' && text !== null) 
        ? (text.label || text.title || text.text || "") 
        : text;
        
    let cleaned = String(val)
        .replace(/^(what\s+breaks|what\s+gets\s+created|mechanism\s*[:.-]\s*)/i, '')
        .replace(/\b(the|a|an|this|that)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const words = cleaned.split(/\s+/).filter(Boolean);
    if (words.length <= maxWords) return cleaned;
    return words.slice(0, maxWords).join(' ') + '...';
}

function compactRiskLabel(text, maxWords = 4) {
    if (!text) return '';

    let cleaned = String(text)
        .replace(/^(thesis\s*risk\s*[:.-]\s*|risk\s*[:.-]\s*)/i, '')
        .replace(/\b(could|may|might|can|will|would|likely|potentially|possibly|potential)\b/gi, '')
        .replace(/\b(the|a|an)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const clause = cleaned.split(/(?:;|:|—|–|\.|\(|\)|,|\bdue to\b|\bbecause\b|\bif\b|\bwhen\b)/i)[0].trim();
    const words = clause.split(/\s+/).filter(Boolean);
    if (words.length <= maxWords && clause.length <= 24) return clause;

    const compact = words.slice(0, maxWords).join(' ');
    if (compact.length <= 24) return compact;

    return words.slice(0, Math.max(2, maxWords - 1)).join(' ');
}

function formatSignedPercent(value) {
    const number = Number.parseFloat(value);
    if (Number.isNaN(number)) return 'N/A';
    const prefix = number > 0 ? '+' : '';
    return `${prefix}${number.toFixed(1)}%`;
}

function getConvictionLevel(value) {
    const normalized = String(value || 'medium').toLowerCase();
    if (normalized.includes('high')) return 'high';
    if (normalized.includes('low')) return 'low';
    return 'medium';
}

function getConvictionGlyph(value) {
    const level = getConvictionLevel(value);
    if (level === 'high') return '●';
    if (level === 'low') return '○';
    return '◐';
}

function getTickerPerformanceRecord(signal, ticker) {
    let perfData = [];
    if (signal?.performance) {
        if (typeof signal.performance === 'string') {
            try { perfData = JSON.parse(signal.performance); } catch (e) {}
        } else if (Array.isArray(signal.performance)) {
            perfData = signal.performance;
        }
    }

    const matches = perfData
        .filter((item) => item && String(item.ticker || '').toUpperCase() === String(ticker || '').toUpperCase())
        .sort((a, b) => {
            const order = { '1month': 3, '1week': 2, '24hr': 1 };
            return (order[b.check_interval] || 0) - (order[a.check_interval] || 0);
        });

    if (!matches.length) return null;
    const selected = matches[0];
    return {
        checkInterval: String(selected.check_interval || 'since publish'),
        returnPct: Number.parseFloat(selected.return_pct || 0),
        label: formatSignedPercent(selected.return_pct),
    };
}

function renderTopologyLegend() {
    if (topologyViewMode === 'impact') {
        return `
            <div class="absolute top-4 left-4 z-40 group">
                <div class="bg-surface-card-elevated/80 backdrop-blur border border-hairline px-3 py-1.5 rounded-full text-muted text-xs flex items-center gap-2 cursor-help shadow-md">
                    <span class="material-symbols-outlined text-[14px]">info</span> Legend
                </div>
                <div class="absolute top-full left-0 mt-2 bg-surface-card border border-hairline p-4 rounded-lg shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all flex flex-col gap-3 min-w-[220px]">
                    <span class="flex items-center text-body-strong text-xs font-code tracking-wider uppercase"><span style="color:#0ea5e9;" class="mr-2 text-[14px]">●</span> Root cause</span>
                    <span class="flex items-center text-body-strong text-xs font-code tracking-wider uppercase"><span style="color:#8d99ae;" class="mr-2 text-[14px]">◆</span> Mechanism</span>
                    <span class="flex items-center text-body-strong text-xs font-code tracking-wider uppercase"><span style="color:#00ff9d;" class="mr-2 text-[14px]">●</span> Winner</span>
                    <span class="flex items-center text-body-strong text-xs font-code tracking-wider uppercase"><span style="color:#ff4d4d;" class="mr-2 text-[14px]">●</span> Loser</span>
                    <span class="flex items-center text-body-strong text-xs font-code tracking-wider uppercase"><span class="mr-2 text-[14px]">●</span> High conviction</span>
                    <span class="flex items-center text-body-strong text-xs font-code tracking-wider uppercase"><span class="mr-2 text-[14px]">◐</span> Medium conviction</span>
                    <span class="flex items-center text-body-strong text-xs font-code tracking-wider uppercase"><span class="mr-2 text-[14px]">○</span> Low conviction</span>
                    <span class="flex items-center text-body-strong text-xs font-code tracking-wider uppercase"><span class="mr-2 text-[10px] bg-surface-card-elevated border border-hairline px-1.5 py-0.5 rounded-sm">+2.4%</span> Performance badge</span>
                </div>
            </div>`;
    }

    return `
        <div class="absolute top-4 left-4 z-40 group">
            <div class="bg-surface-card-elevated/80 backdrop-blur border border-hairline px-3 py-1.5 rounded-full text-muted text-xs flex items-center gap-2 cursor-help shadow-md">
                <span class="material-symbols-outlined text-[14px]">info</span> Legend
            </div>
            <div class="absolute top-full left-0 mt-2 bg-surface-card border border-hairline p-4 rounded-lg shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all flex flex-col gap-3 min-w-[180px]">
                <span class="flex items-center text-body-strong text-xs font-code tracking-wider uppercase"><span style="color:#0ea5e9;" class="mr-2 text-[14px]">●</span> Root Cause</span>
                <span class="flex items-center text-body-strong text-xs font-code tracking-wider uppercase"><span style="color:#fde047;" class="mr-2 text-[14px]">◆</span> Direct Effect</span>
                <span class="flex items-center text-body-strong text-xs font-code tracking-wider uppercase"><span style="color:#a855f7;" class="mr-2 text-[14px]">◆</span> Ripple Effect</span>
                <span class="flex items-center text-body-strong text-xs font-code tracking-wider uppercase"><span style="color:#00ff9d;" class="mr-2 text-[14px]">●</span> Beneficiary</span>
                <span class="flex items-center text-body-strong text-xs font-code tracking-wider uppercase"><span style="color:#ff4d4d;" class="mr-2 text-[14px]">●</span> Headwind</span>
                <span class="flex items-center text-body-strong text-xs font-code tracking-wider uppercase"><span style="color:#ff6b35;" class="mr-2 text-[14px]">⬡</span> Chokepoint</span>
                <span class="flex items-center text-body-strong text-xs font-code tracking-wider uppercase"><span style="color:#e879f9;" class="mr-2 text-[14px]">▼</span> Supplier</span>
                <span class="flex items-center text-body-strong text-xs font-code tracking-wider uppercase"><span style="color:#fbbf24;" class="mr-2 text-[14px]">▲</span> Customer</span>
                <span class="flex items-center text-body-strong text-xs font-code tracking-wider uppercase"><span style="color:#34d399;" class="mr-2 text-[14px]">⟳</span> Substitute</span>
                <span class="flex items-center text-body-strong text-xs font-code tracking-wider uppercase"><span style="color:#f97316;" class="mr-2 text-[16px]">◇</span> Risk</span>
            </div>
        </div>`;
}

function syncTopologyViewButton() {
    const btn = document.getElementById('topology-view-btn');
    if (!btn) return;

    const icon = topologyViewMode === 'impact' ? 'account_tree' : 'insights';
    const label = topologyViewMode === 'impact' ? 'Topology View' : 'Impact View';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.classList.toggle('bg-primary/10', topologyViewMode === 'impact');
    btn.classList.toggle('text-primary', topologyViewMode === 'impact');
    btn.classList.toggle('border', topologyViewMode === 'impact');
    btn.classList.toggle('border-primary/30', topologyViewMode === 'impact');
    btn.innerHTML = `<span class="material-symbols-outlined text-[16px]">${icon}</span><span class="text-[11px] font-code tracking-widest uppercase">${label}</span>`;
}

function setTopologyViewMode(mode) {
    topologyViewMode = mode === 'impact' ? 'impact' : 'topology';
    syncTopologyViewButton();
    refreshTopologyLayout();
}

function attachTopologyViewButton() {
    const btn = document.getElementById('topology-view-btn');
    if (!btn) return;

    btn.onclick = (e) => {
        e.stopPropagation();
        setTopologyViewMode(topologyViewMode === 'impact' ? 'topology' : 'impact');
    };

    syncTopologyViewButton();
}

function normalizeTickerProfiles(value) {
    const list = parseMaybeJson(value, value);
    if (!Array.isArray(list)) return [];

    return list
        .map((item) => {
            if (!item || typeof item !== 'object') return null;
            const symbol = String(item.symbol || item.ticker || '').trim().toUpperCase();
            if (!symbol) return null;
            return {
                symbol,
                company_name: String(item.company_name || item.long_name || item.short_name || item.name || symbol).trim(),
                business_type: String(item.business_type || item.industry || item.sector || item.quote_type || '').trim(),
                sector: String(item.sector || '').trim(),
                industry: String(item.industry || '').trim(),
                quote_type: String(item.quote_type || '').trim(),
            };
        })
        .filter(Boolean);
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
    
    // Inject any tickers found in the relationship graph that the backend might have missed in the primary list
    (topology.branches || []).forEach(branch => {
        (branch.nodes || []).forEach(gnode => {
            if (gnode.ticker && !allTickers.includes(gnode.ticker.toUpperCase())) {
                allTickers.push(gnode.ticker.toUpperCase());
                rawTickerList.push(gnode);
            }
            (gnode.children || []).forEach(child => {
                if (child.ticker && !allTickers.includes(child.ticker.toUpperCase())) {
                    allTickers.push(child.ticker.toUpperCase());
                    rawTickerList.push(child);
                }
            });
        });
    });

    const tickerProfiles = normalizeTickerProfiles(signal.ticker_profiles);

    function tickerMeta(sym) {
        const profile = tickerProfiles.find((t) => t.symbol === sym);
        if (profile) return profile;
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
        radius: 28, color: '#0ea5e9', shape: 'circle',
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
            id, label: txt, group: 'first_order', layer: 1,
            radius: 14, color: '#fde047', shape: 'diamond',
            detail: txt, directionInfo: 'DIRECT EFFECT', conviction: 'high'
        });
        links.push({ source: rootId, target: id, value: 7, color: '#fde047', reason: 'Direct impact', dashed: false });
    });

    // === Layer 2: Second-order effects ===
    const secondOrder = normalizeTextList(signal.second_order_effects);
    const soIds = [];
    secondOrder.forEach((txt, idx) => {
        const id = nid('so');
        soIds.push(id);
        nodes.push({
            id, label: txt, group: 'second_order', layer: 2,
            radius: 10, color: '#a855f7', shape: 'diamond',
            detail: txt, directionInfo: 'RIPPLE EFFECT', conviction: 'medium'
        });
        const parentId = foIds.length > 0 ? foIds[idx % foIds.length] : rootId;
        links.push({ source: parentId, target: id, value: 5, color: '#a855f7', reason: 'Downstream ripple', dashed: false });
    });

    // === Layer 2.5: Supply Chain Contagion Nodes ===
    // Extract chokepoint/supplier/customer/substitute nodes from topology branches
    const contagionKinds = new Set(['chokepoint', 'supplier', 'customer', 'substitute']);
    const contagionIds = [];
    const contagionColors = { chokepoint: '#ff6b35', supplier: '#e879f9', customer: '#fbbf24', substitute: '#34d399' };
    const contagionShapes = { chokepoint: 'hexagon', supplier: 'triangle-down', customer: 'triangle-up', substitute: 'diamond' };
    const contagionLabels = { chokepoint: 'CHOKEPOINT', supplier: 'SUPPLIER DEPENDENCY', customer: 'DOWNSTREAM CUSTOMER', substitute: 'SUBSTITUTE BENEFICIARY' };
    const addedContagionLabels = new Set();
    const tickerParentMap = {};

    (topology.branches || []).forEach((branch) => {
        (branch.nodes || []).forEach((gnode) => {
            const kind = String(gnode.kind || '').toLowerCase();
            const rel = String(gnode.relationship || '').toLowerCase();
            const effectiveKind = contagionKinds.has(kind) ? kind : (contagionKinds.has(rel) ? rel : null);
            if (!effectiveKind) return;
            
            // For the intermediate contagion node, use the dependency type as label
            const contagionLabel = contagionLabels[effectiveKind] || effectiveKind.toUpperCase();
            console.log(`[Topology] Created Contagion Node for ${effectiveKind}:`, contagionLabel, 'from ticker:', gnode.ticker);

            const id = nid('cn');
            contagionIds.push(id);
            const col = contagionColors[effectiveKind] || '#8d99ae';
            const exposurePct = String(gnode.exposure_pct || '').trim();
            const detailParts = [gnode.why_it_matters || gnode.relationship || ''];
            if (exposurePct) detailParts.push(`Exposure: ${exposurePct}`);

            nodes.push({
                id, label: contagionLabel, ticker: '', group: 'contagion', layer: 2,
                radius: effectiveKind === 'chokepoint' ? 18 : 14, color: col,
                shape: contagionShapes[effectiveKind] || 'diamond',
                detail: detailParts.join(' — '), directionInfo: 'SUPPLY CHAIN DEPENDENCY',
                conviction: String(gnode.conviction || 'medium'), contagionKind: effectiveKind,
                exposurePct: exposurePct
            });

            // Connect chokepoints to root, others to root by default unless a chokepoint exists
            let parentId;
            if (effectiveKind === 'chokepoint') {
                parentId = rootId;
            } else {
                const chokepointNode = contagionIds.length > 1 ? contagionIds[0] : null;
                const chokepointIsActual = chokepointNode && nodes.find(n => n.id === chokepointNode && n.contagionKind === 'chokepoint');
                parentId = chokepointIsActual ? chokepointNode : rootId;
            }
            links.push({ source: parentId, target: id, value: 5, color: col, reason: gnode.relationship || effectiveKind + ' link', dashed: false, contagion: true });

            // Ensure the ticker node knows to connect to this contagion node instead of default effects
            if (gnode.ticker) {
                // We map this ticker so it connects directly to our new contagion node
                contagionIds.push(id); // Already pushed above, but this makes sure it's in the pool for Layer 3
                tickerParentMap[gnode.ticker.toUpperCase()] = id;
            }

            // Also process children of this contagion node
            (gnode.children || []).forEach((child) => {
                const childKind = String(child.kind || '').toLowerCase();
                const childRel = String(child.relationship || '').toLowerCase();
                const childEffectiveKind = contagionKinds.has(childKind) ? childKind : (contagionKinds.has(childRel) ? childRel : null);
                if (!childEffectiveKind) return;
                
                const childContagionLabel = contagionLabels[childEffectiveKind] || childEffectiveKind.toUpperCase();

                const childId = nid('cn');
                contagionIds.push(childId);
                const childCol = contagionColors[childEffectiveKind] || '#8d99ae';
                const childExposure = String(child.exposure_pct || '').trim();
                const childDetail = [child.why_it_matters || child.relationship || ''];
                if (childExposure) childDetail.push(`Exposure: ${childExposure}`);

                nodes.push({
                    id: childId, label: childContagionLabel, ticker: '', group: 'contagion', layer: 2,
                    radius: childEffectiveKind === 'chokepoint' ? 18 : 12, color: childCol,
                    shape: contagionShapes[childEffectiveKind] || 'diamond',
                    detail: childDetail.join(' — '), directionInfo: 'SUPPLY CHAIN DEPENDENCY',
                    conviction: String(child.conviction || 'low'), contagionKind: childEffectiveKind,
                    exposurePct: childExposure
                });
                links.push({ source: id, target: childId, value: 4, color: childCol, reason: child.relationship || 'downstream', dashed: false, contagion: true });
                if (child.ticker) {
                    tickerParentMap[child.ticker.toUpperCase()] = childId;
                }
            });
        });
    });

    // === Layer 3: Ticker nodes ===
    const deepestEffects = contagionIds.length > 0 ? contagionIds : soIds.length > 0 ? soIds : foIds.length > 0 ? foIds : [rootId];

    allTickers.forEach((sym, idx) => {
        const impact = tickerImpact(sym);
        const m = tickerMeta(sym);
        const conv = m ? String(m.conviction || 'medium') : 'medium';
        const col = impact === 'positive' ? '#00ff9d' : impact === 'negative' ? '#ff4d4d' : '#8d99ae';
        const id = nid('tk');
        const why = m && m.why_it_matters ? String(m.why_it_matters) : `${impact.toUpperCase()} impact on ${sym}`;
        const company = m ? String(m.company_name || sym).trim() : sym;
        const companyType = m ? String(m.business_type || m.industry || m.sector || m.quote_type || '').trim() : '';

        nodes.push({
            id, label: sym, ticker: sym, companyName: company, companyType: companyType, group: 'ticker', layer: 3,
            radius: 20, color: col, shape: 'circle',
            detail: why, directionInfo: impact.toUpperCase() + ' IMPACT', conviction: conv
        });

        // Connect beneficiaries to second-order effects (they profit from the ripple)
        // Connect headwinds to first-order effects (they are directly hit)
        let parent;
        if (tickerParentMap[sym]) {
            parent = tickerParentMap[sym];
        } else {
            let parentPool;
            if (impact === 'positive') {
                parentPool = soIds.length > 0 ? soIds : foIds.length > 0 ? foIds : [rootId];
            } else if (impact === 'negative') {
                parentPool = foIds.length > 0 ? foIds : soIds.length > 0 ? soIds : [rootId];
            } else {
                parentPool = deepestEffects;
            }
            parent = parentPool[idx % parentPool.length];
        }
        links.push({ source: parent, target: id, value: 4, color: col, reason: impact + ' exposure', dashed: false });
    });

    // === Risks / Invalidators ===
    const risks = normalizeTextList(signal.thesis_risks);
    risks.slice(0, 3).forEach((txt) => {
        const id = nid('risk');
        nodes.push({
            id, label: txt, group: 'risk', layer: 'risk',
            radius: 6, color: '#f97316', shape: 'diamond',
            detail: txt, directionInfo: 'INVALIDATOR', conviction: 'low'
        });
        links.push({ source: rootId, target: id, value: 2, color: '#f97316', reason: 'Thesis risk', dashed: true });
    });

    // === Prune dangling intermediary nodes ===
    // Ensure that 'first_order', 'second_order', and 'contagion' nodes 
    // are ONLY visible if they ultimately connect to a ticker or an explicit leaf node.
    let pruned = true;
    while (pruned) {
        pruned = false;
        const sourceIds = new Set(links.map(l => l.source));
        for (let i = nodes.length - 1; i >= 0; i--) {
            const n = nodes[i];
            if ((n.group === 'first_order' || n.group === 'second_order' || n.group === 'contagion') && !sourceIds.has(n.id)) {
                nodes.splice(i, 1);
                pruned = true;
            }
        }
        if (pruned) {
            const validNodeIds = new Set(nodes.map(n => n.id));
            for (let i = links.length - 1; i >= 0; i--) {
                if (!validNodeIds.has(links[i].source) || !validNodeIds.has(links[i].target)) {
                    links.splice(i, 1);
                }
            }
        }
    }

    // Initialize all nodes near the center with random jitter to prevent them from flying in from (0,0)
    // Jitter ensures dx/dy are never precisely 0 in the custom force layer.
    nodes.forEach(n => { n.x = cx + Math.random() * 2 - 1; n.y = cy + Math.random() * 2 - 1; });

    let nodeLabel, linkLabel;
    const initialTransform = d3.zoomIdentity.translate(cx, cy).scale(0.85).translate(-cx, -cy);

    // ========== D3 Rendering ==========
    d3.select("#d3-container").select("svg").remove();

    const svg = d3.select("#d3-container").append("svg")
        .attr("width", width).attr("height", height);

    const g = svg.append("g");

    svg.on("click", () => { pinnedNode = null; hideTooltip(); resetFocus(); });

    const defs = svg.append("defs");

    // Grid pattern
    const pattern = defs.append("pattern")
        .attr("id", "bg-grid")
        .attr("width", 40)
        .attr("height", 40)
        .attr("patternUnits", "userSpaceOnUse");
    pattern.append("path")
        .attr("d", "M 40 0 L 0 0 0 40")
        .attr("fill", "none")
        .attr("stroke", "#ffffff")
        .attr("stroke-width", "0.5")
        .attr("opacity", "0.15");

    svg.insert("rect", "g")
        .attr("width", "100%")
        .attr("height", "100%")
        .attr("fill", "url(#bg-grid)");

    // Glow filter for root node
    const glow = defs.append("filter").attr("id", "glow").attr("x", "-50%").attr("y", "-50%").attr("width", "200%").attr("height", "200%");
    glow.append("feGaussianBlur").attr("stdDeviation", "4").attr("result", "blur");
    glow.append("feMerge").selectAll("feMergeNode").data(["blur", "SourceGraphic"]).enter().append("feMergeNode").attr("in", d => d);

    // Arrow markers
    ['#0ea5e9', '#00ff9d', '#ff4d4d', '#8d99ae', '#fde047', '#a855f7', '#f97316', '#ff6b35', '#e879f9', '#fbbf24', '#34d399'].forEach(color => {
        defs.append("marker").attr("id", "arr-" + color.replace('#', ''))
            .attr("viewBox", "0 -4 8 8").attr("refX", 18).attr("refY", 0)
            .attr("markerWidth", 5).attr("markerHeight", 5).attr("orient", "auto")
            .append("path").attr("d", "M0,-4L8,0L0,4").attr("fill", color).attr("opacity", 0.5);
    });

    // Layer distance from center
    const layerRadius = { 0: 0, 1: Math.min(width, height) * 0.35, 2: Math.min(width, height) * 0.52, 3: Math.min(width, height) * 0.70, risk: Math.min(width, height) * 0.40 };

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
            if (d.dashed) return 300; 
            if (d.target.group === 'ticker' || d.source.group === 'ticker') return 280;
            return 250 + (d.value || 0) * 15;
        }).strength(0.7))
        .force("charge", d3.forceManyBody().strength(d => d.group === 'root' ? -5000 : d.group === 'risk' ? -2000 : -1500))
        .force("layer", forceLayer(0.12)) 
        .force("collide", d3.forceCollide().radius(d => d.radius + 140).strength(0.8));

    // Links
    const link = g.append("g").selectAll("line").data(links).enter().append("line")
        .attr("stroke", d => d.dashed ? '#ff6b6b44' : d.contagion ? d.color : '#444')
        .attr("stroke-width", d => d.dashed ? 1 : d.contagion ? 2 : Math.max(1.5, d.value * 0.6))
        .attr("stroke-dasharray", d => d.dashed ? "6,4" : d.contagion ? "8,4" : "none")
        .attr("opacity", d => d.dashed ? 0.3 : d.contagion ? 0.7 : 0.6)
        .attr("marker-end", d => "url(#arr-" + d.color.replace('#', '') + ")");

    // Animate contagion link dashes
    link.filter(d => d.contagion).each(function() {
        const el = d3.select(this);
        el.style('animation', 'contagionFlow 1.5s linear infinite');
    });

    // Link labels (relationship reason on hover visibility handled via CSS/JS)
    linkLabel = g.append("g").selectAll("text").data(links).enter().append("text")
        .text(d => d.reason || '')
        .attr("font-size", "9px").attr("fill", "#8b9cb7").attr("text-anchor", "middle")
        .attr("font-family", "JetBrains Mono, monospace").style("pointer-events", "none").attr("opacity", 0)
        .style("paint-order", "stroke")
        .style("stroke", "#060a12")
        .style("stroke-width", "4px")
        .style("stroke-linecap", "round")
        .style("stroke-linejoin", "round");

    // Nodes
    const node = g.append("g").selectAll("g").data(nodes).enter().append("g")
        .call(d3.drag().on("start", dragstarted).on("drag", dragged).on("end", dragended));

    // Draw shapes based on group
    node.each(function(d) {
        const el = d3.select(this);
        if (d.shape === 'hexagon') {
            // Hexagon for chokepoints
            const r = d.radius;
            const hex = Array.from({length: 6}, (_, i) => {
                const angle = (Math.PI / 3) * i - Math.PI / 6;
                return `${r * Math.cos(angle)},${r * Math.sin(angle)}`;
            }).join(' ');
            el.append("polygon")
                .attr("points", hex)
                .attr("fill", d.color).attr("opacity", 0.9)
                .attr("stroke", d.color).attr("stroke-width", 2).attr("stroke-opacity", 0.6);
        } else if (d.shape === 'triangle-down') {
            // Inverted triangle for suppliers (inflow)
            const s = d.radius;
            el.append("path")
                .attr("d", `M${-s},${-s*0.7} L${s},${-s*0.7} L0,${s} Z`)
                .attr("fill", d.color).attr("opacity", 0.9)
                .attr("stroke", d.color).attr("stroke-width", 1.5).attr("stroke-opacity", 0.5);
        } else if (d.shape === 'triangle-up') {
            // Triangle for customers (outflow)
            const s = d.radius;
            el.append("path")
                .attr("d", `M${-s},${s*0.7} L${s},${s*0.7} L0,${-s} Z`)
                .attr("fill", d.color).attr("opacity", 0.9)
                .attr("stroke", d.color).attr("stroke-width", 1.5).attr("stroke-opacity", 0.5);
        } else if (d.shape === 'diamond') {
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
        // Exposure badge for contagion nodes
        if (d.exposurePct) {
            el.append("text")
                .text(d.exposurePct)
                .attr("dy", d.radius + 14)
                .attr("fill", d.color).attr("font-size", "9px")
                .attr("font-weight", "700").attr("font-family", "JetBrains Mono, monospace")
                .attr("text-anchor", "middle").style("pointer-events", "none");
        }
    });

    function wrapSVGText(textSelection, maxWidth) {
        textSelection.each(function(d) {
            const node = d3.select(this);
            const fullText = d.ticker || d.label;
            if (!fullText || d.group === 'root') return;

            const words = fullText.split(/\s+/);
            if (words.length <= 1) return;

            // Pre-calculate lines using a temporary tspan for measurement
            node.text(null);
            let lines = [];
            let currentLine = [];
            let tempTspan = node.append("tspan").attr("visibility", "hidden");

            for (let n = 0; n < words.length; n++) {
                currentLine.push(words[n]);
                tempTspan.text(currentLine.join(" "));
                if (tempTspan.node().getComputedTextLength() > maxWidth && currentLine.length > 1) {
                    currentLine.pop();
                    lines.push(currentLine.join(" "));
                    currentLine = [words[n]];
                }
            }
            lines.push(currentLine.join(" "));
            tempTspan.remove();

            // Render final tspans with consistent alignment
            node.text(null).attr("x", 0);
            const lineHeight = 1.1; // ems
            const baseDy = d.group === 'contagion' ? d.radius + 40 : 4;
            // Shift the entire block up to center it vertically
            const totalOffset = (lines.length - 1) * 0.5 * lineHeight;

            lines.forEach((line, i) => {
                const dyValue = (i === 0) 
                    ? (baseDy / 12 - totalOffset) + "em" 
                    : lineHeight + "em";
                node.append("tspan")
                    .attr("x", 0)
                    .attr("dy", dyValue)
                    .text(line);
            });
        });
    }

    nodeLabel = node.append("text")
        .attr("x", 0)
        .text(d => {
            if (d.group === 'ticker') return d.ticker || d.label;
            if (d.group === 'root') return '';
            return d.label;
        })
        .attr("fill", d => {
            if (d.group === 'root') return '#0ea5e9';
            if (d.group === 'risk') return '#ff4d4d';
            if (d.group === 'ticker') return '#060a12';
            if (d.group === 'contagion') return '#8b9cb7';
            return '#8b9cb7';
        })
        .attr("font-size", d => {
            if (d.group === 'ticker') return "11px";
            if (d.group === 'risk') return "11px";
            if (d.group === 'contagion') return "10px";
            return 13 / initialTransform.k + "px";
        })
        .attr("font-weight", d => (d.group === 'ticker' || d.group === 'contagion') ? "600" : "400")
        .attr("font-family", "JetBrains Mono, monospace").style("pointer-events", "none")
        .attr("opacity", d => (d.group === 'ticker' || d.group === 'contagion') ? 1 : 0)
        .style("paint-order", "stroke")
        .style("stroke", d => d.group === 'ticker' ? "none" : "#060a12")
        .style("stroke-width", d => d.group === 'ticker' ? "0px" : "4px")
        .style("stroke-linecap", "round")
        .style("stroke-linejoin", "round");

    // Apply wrapping
    nodeLabel.call(wrapSVGText, 120);

    function positionTopologyNodeLabels() {
        const labelPadding = 40;

        nodeLabel.each(function(d) {
            const selection = d3.select(this);

            if (d.group === 'ticker' || d.group === 'root' || d.group === 'contagion') {
                selection.attr('dx', 0).attr('text-anchor', 'middle');
                return;
            }

            // Radiate text OUTWARD from center to prevent overlapping inner nodes
            const isLeftHalf = d.x < cx;
            const xPos = isLeftHalf ? -(d.radius + labelPadding) : d.radius + labelPadding;
            
            selection
                .attr('x', xPos)
                .attr('text-anchor', isLeftHalf ? 'end' : 'start');
            
            // Force all tspans to the same x-origin to prevent indentation artifacts
            selection.selectAll("tspan").attr("x", xPos);
        });
    }

    // Tooltip & interaction
    const tooltip = d3.select("#d3-tooltip");
    let pinnedNode = null;

    function positionTopologyTooltip(event) {
        // Consistently anchor tooltip to top-right of the container
        tooltip
            .style('left', 'auto')
            .style('right', '16px')
            .style('top', '16px')
            .style('bottom', 'auto');
    }

    function focusNode(d) {
        const connected = new Set([d.id]);
        links.forEach(l => {
            const sid = typeof l.source === 'object' ? l.source.id : l.source;
            const tid = typeof l.target === 'object' ? l.target.id : l.target;
            if (sid === d.id) connected.add(tid);
            if (tid === d.id) connected.add(sid);
        });
        
        // Dim un-connected nodes
        node.transition().duration(200).style("opacity", o => connected.has(o.id) ? 1 : 0.12);

        // Reveal labels for connected nodes
        nodeLabel.transition().duration(200).attr("opacity", o => connected.has(o.id) ? 1 : 0);

        // Dim un-connected links
        link.transition().duration(200).style("opacity", o => {
            const sid = typeof o.source === 'object' ? o.source.id : o.source;
            const tid = typeof o.target === 'object' ? o.target.id : o.target;
            return (sid === d.id || tid === d.id) ? 0.9 : 0.04;
        });

        // Reveal connected link labels
        linkLabel.transition().duration(200).attr("opacity", o => {
            if (d.group === 'root') return 0; // Prevent massive overlap in center
            const sid = typeof o.source === 'object' ? o.source.id : o.source;
            const tid = typeof o.target === 'object' ? o.target.id : o.target;
            return (sid === d.id || tid === d.id) ? 1 : 0;
        });
    }

    function resetFocus() {
        node.transition().duration(200).style("opacity", 1);
        // Hide effect/risk labels again, keep ticker and contagion labels
        nodeLabel.transition().duration(200).attr("opacity", d => (d.group === 'ticker' || d.group === 'contagion') ? 1 : 0);
        link.transition().duration(200).style("opacity", 0.7);
        linkLabel.transition().duration(200).attr("opacity", 0);
    }

    function showTooltip(d, event) {
        let groupLabel = { root: 'ROOT CAUSE', first_order: 'DIRECT EFFECT', second_order: 'RIPPLE EFFECT', ticker: 'TICKER', risk: 'THESIS RISK', contagion: 'SUPPLY CHAIN' }[d.group] || d.group;
        if (d.group === 'ticker' && d.companyType) {
            groupLabel = d.companyType.toUpperCase();
        }
        if (d.group === 'contagion' && d.directionInfo) {
            groupLabel = d.directionInfo;
        }

        const tickerDescriptor = d.group === 'ticker'
            ? [d.companyName, d.companyType].filter(Boolean).join(' · ')
            : '';

        tooltip.transition().duration(200).style("opacity", 1);
        
        let content = `<div class="text-[10px] font-label-caps tracking-widest uppercase mb-2" style="color:${d.color};">${escapeHtml(groupLabel)}</div>`;
        
        if (d.ticker) {
            content += `<div class="font-display-ticker text-lg text-body-strong mb-0.5">${escapeHtml(d.ticker)}</div>`;
            if (tickerDescriptor) {
                content += `<div class="text-xs text-muted mb-3">${escapeHtml(tickerDescriptor)}</div>`;
            }
            content += `<div class="flex items-center gap-2 mb-3">`;
            if (d.directionInfo) {
                content += `<span class="inline-block bg-surface-card-elevated border border-hairline-strong px-2 py-0.5 rounded text-[10px] font-medium" style="color:${d.color}">${d.directionInfo}</span>`;
            }
            if (d.conviction) {
                content += `<span class="text-[10px] text-muted font-medium">${d.conviction.toUpperCase()} CONVICTION</span>`;
            }
            content += `</div>`;
        } else if (d.group !== 'root') {
            if (d.conviction) {
                content += `<div class="mb-2"><span class="text-[10px] text-muted font-medium tracking-wide">${d.conviction.toUpperCase()} CONVICTION</span></div>`;
            }
        }

        content += `<div class="text-[13px] font-body-compact text-body-strong leading-relaxed opacity-90">${escapeHtml(d.detail)}</div>`;

        tooltip.html(content);
        positionTopologyTooltip(event || { clientX: 16, clientY: 16 });
    }

    function hideTooltip() { tooltip.transition().duration(200).style("opacity", 0); }

    node.on("mouseover", (event, d) => { if (pinnedNode && pinnedNode.id !== d.id) return; focusNode(d); if (!pinnedNode) showTooltip(d, event); })
        .on("mousemove", (event) => { positionTopologyTooltip(event); })
        .on("mouseout", () => { if (pinnedNode) return; resetFocus(); hideTooltip(); })
        .on("click", (event, d) => { event.stopPropagation(); pinnedNode = d; focusNode(d); showTooltip(d, event); });

    const fitBtn = document.getElementById('reheat-btn');
    if (fitBtn) {
        fitBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            refreshTopologyLayout();
        });
    }

    // === Zoom Behavior ===
    const zoom = d3.zoom().scaleExtent([0.2, 4]).on("zoom", (event) => {
        g.attr("transform", event.transform);
        // Maintain readable sizes ONLY for descriptions, keep tickers fixed relative to nodes
        const k = event.transform.k;
        nodeLabel.attr("font-size", d => {
            if (d.group === 'ticker') return "11px";
            return 13 / k + "px";
        });
        linkLabel.attr("font-size", 10 / k + "px");
    });

    svg.call(zoom).call(zoom.transform, initialTransform)
       .on("dblclick.zoom", () => {
           svg.transition().duration(750).call(zoom.transform, initialTransform);
       });

    // Bounding constraints
    function constrainNodes() {
        nodes.forEach(d => {
            const r = d.radius || 10;
            d.x = Math.max(40 + r, Math.min(width - 40 - r, d.x));
            d.y = Math.max(60 + r, Math.min(height - 90 - r, d.y)); // 90px bottom padding for the root cause pill
        });
    }

    // Fast-forward the simulation so it is neatly laid out and uniform without overlapping on first load
    simulation.stop();
    for (let i = 0, n = Math.ceil(Math.log(simulation.alphaMin()) / Math.log(1 - simulation.alphaDecay())); i < n; ++i) {
        simulation.tick();
        constrainNodes();
    }

    // Set initial static positions immediately
    constrainNodes();
    positionTopologyNodeLabels();
    link.attr("x1", d => d.source.x).attr("y1", d => d.source.y).attr("x2", d => d.target.x).attr("y2", d => d.target.y);
    linkLabel.attr("x", d => d.source.x + (d.target.x - d.source.x) * 0.75).attr("y", d => d.source.y + (d.target.y - d.source.y) * 0.75);
    node.attr("transform", d => `translate(${d.x},${d.y})`);

    simulation.on("tick", () => {
        constrainNodes();
        positionTopologyNodeLabels();
        link.attr("x1", d => d.source.x).attr("y1", d => d.source.y).attr("x2", d => d.target.x).attr("y2", d => d.target.y);
        linkLabel.attr("x", d => d.source.x + (d.target.x - d.source.x) * 0.75).attr("y", d => d.source.y + (d.target.y - d.source.y) * 0.75);
        node.attr("transform", d => `translate(${d.x},${d.y})`);
    });

    function dragstarted(event, d) { if (!event.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; }
    function dragged(event, d) { d.fx = event.x; d.fy = event.y; }
    function dragended(event, d) { if (!event.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }

    const resizeObserver = new ResizeObserver(entries => {
        for (let entry of entries) {
            const nw = entry.contentRect.width, nh = entry.contentRect.height;
            svg.attr("width", nw).attr("height", nh);
            positionTopologyNodeLabels();
            simulation.force("layer", forceLayer(0.12));
            simulation.alpha(0.3).restart();
        }
    });
    resizeObserver.observe(container);
}

function initImpactGraph(signal, topology) {
    const container = document.getElementById('d3-container');
    const width = container.clientWidth;
    const height = container.clientHeight;
    const cx = width / 2;

    const rootY = Math.max(90, height * 0.14);
    const mechanismY = Math.max(240, height * 0.42);
    const tickerCenterY = Math.max(mechanismY + 140, Math.min(height - 120, height * 0.75));
    const leftX = Math.max(180, width * 0.28);
    const rightX = Math.min(width - 180, width * 0.72);

    const rootLabel = compactImpactLabel(signal.root_cause || topology.root || 'Market catalyst', 6);
    const firstOrder = normalizeTextList(signal.first_order_effects).filter(Boolean);
    const secondOrder = normalizeTextList(signal.second_order_effects).filter(Boolean);
    const mechanismCandidates = [...firstOrder, ...secondOrder].filter(Boolean);
    const mechanismLabels = [];
    const mechanismDetails = [];
    for (const candidate of mechanismCandidates) {
        const label = compactImpactLabel(candidate, 8); // Increased slightly for AI labels
        const detail = (typeof candidate === 'object' && candidate !== null) 
            ? (candidate.details || candidate.why_it_matters || candidate.label || "") 
            : String(candidate);
            
        if (label && !mechanismLabels.includes(label)) {
            mechanismLabels.push(label);
            mechanismDetails.push(detail);
        }
        if (mechanismLabels.length >= 2) break;
    }
    if (mechanismLabels.length === 0) {
        mechanismLabels.push(compactImpactLabel(signal.market_consensus_divergence || topology.root || 'Immediate market pressure', 5));
    }
    if (mechanismLabels.length === 1) {
        mechanismLabels.push(compactImpactLabel(signal.second_order_effects?.[0] || signal.market_consensus_divergence || 'Next market reaction', 5));
    }

    const positiveSet = new Set(normalizeTextList(signal.positively_affected).map((s) => s.toUpperCase()));
    const negativeSet = new Set(normalizeTextList(signal.negatively_affected).map((s) => s.toUpperCase()));
    const allTickers = normalizeTickerList(signal.tickers);
    const rawTickerList = parseMaybeJson(signal.tickers, []);
    const tickerProfiles = normalizeTickerProfiles(signal.ticker_profiles);
    const textMeasureCanvas = document.createElement('canvas');
    const textMeasureContext = textMeasureCanvas.getContext('2d');

    function measureTextWidth(text, fontSize, fontWeight = 400) {
        if (!textMeasureContext) return String(text || '').length * fontSize * 0.55;
        textMeasureContext.font = `${fontWeight} ${fontSize}px JetBrains Mono, monospace`;
        return textMeasureContext.measureText(String(text || '')).width;
    }

    function wrapTextLines(text, maxWidth, fontSize, fontWeight = 400, maxLines = 3) {
        const content = String(text || '').trim();
        if (!content) return [];

        const words = content.split(/\s+/).filter(Boolean);
        if (words.length === 0) return [];

        const lines = [];
        let currentLine = '';

        words.forEach((word) => {
            const testLine = currentLine ? `${currentLine} ${word}` : word;
            if (measureTextWidth(testLine, fontSize, fontWeight) <= maxWidth) {
                currentLine = testLine;
                return;
            }

            if (currentLine) lines.push(currentLine);
            currentLine = word;
        });

        if (currentLine) lines.push(currentLine);

        while (lines.length > maxLines) {
            const spill = lines.pop();
            lines[lines.length - 1] = `${lines[lines.length - 1]} ${spill}`.trim();
        }

        return lines;
    }

    function renderWrappedLines(selection, lines, lineHeight = 1.1) {
        selection.text(null);
        lines.forEach((line, index) => {
            selection.append('tspan')
                .attr('x', 0)
                .attr('dy', index === 0 ? '0' : `${lineHeight}em`)
                .text(line);
        });
    }

    function tickerMeta(sym) {
        const profile = tickerProfiles.find((item) => item.symbol === sym);
        if (profile) return profile;
        if (!Array.isArray(rawTickerList)) return null;
        return rawTickerList.find((item) => typeof item === 'object' && item && String(item.symbol || item.ticker || '').toUpperCase() === sym) || null;
    }

    function tickerImpact(sym) {
        const meta = tickerMeta(sym);
        const impact = meta ? String(meta.impact || meta.direction || '').toLowerCase() : '';
        if (impact === 'positive' || impact === 'bullish' || positiveSet.has(sym)) return 'positive';
        if (impact === 'negative' || impact === 'bearish' || negativeSet.has(sym)) return 'negative';
        return 'neutral';
    }

    function findGraphTickerNode(topologyData, sym) {
        const target = String(sym || '').trim().toUpperCase();
        if (!target || !topologyData || !Array.isArray(topologyData.branches)) return null;

        const walk = (node) => {
            if (!node || typeof node !== 'object') return null;
            const nodeTicker = String(node.ticker || '').trim().toUpperCase();
            const nodeLabel = String(node.label || '').trim().toUpperCase();
            if (nodeTicker === target || nodeLabel === target) return node;
            for (const child of (node.children || [])) {
                const found = walk(child);
                if (found) return found;
            }
            return null;
        };

        for (const branch of topologyData.branches) {
            for (const node of (branch.nodes || [])) {
                const found = walk(node);
                if (found) return found;
            }
        }

        return null;
    }

    function describeCompanyType(rawType) {
        const value = String(rawType || '').trim();
        if (!value) return 'company';

        const lower = value.toLowerCase();
        if (lower.includes('software') || lower.includes('saas') || lower.includes('cloud')) return 'software platform';
        if (lower.includes('semiconductor') || lower.includes('chip')) return 'chip supplier';
        if (lower.includes('retail') || lower.includes('consumer')) return 'consumer business';
        if (lower.includes('bank') || lower.includes('financial')) return 'financial business';
        if (lower.includes('health') || lower.includes('biotech') || lower.includes('pharma')) return 'healthcare name';
        if (lower.includes('industrial') || lower.includes('manufacturing')) return 'industrial operator';
        if (lower.includes('media') || lower.includes('advertising')) return 'media business';
        return value;
    }

    function friendlyImpactText(sym, direction, why, companyType, mechanismText) {
        const mechanism = compactImpactLabel(mechanismText || why || '', 8);
        const companyPhrase = describeCompanyType(companyType);

        if (direction === 'positive') {
            return mechanism
                ? `As a ${companyPhrase}, ${sym} can benefit because ${mechanism.toLowerCase()} tends to support demand, pricing, or margins.`
                : `As a ${companyPhrase}, ${sym} can benefit from this setup.`;
        }

        if (direction === 'negative') {
            return mechanism
                ? `As a ${companyPhrase}, ${sym} can get pressured because ${mechanism.toLowerCase()} tends to hurt demand, pricing, or margins.`
                : `As a ${companyPhrase}, ${sym} can get pressured by this setup.`;
        }

        return mechanism
            ? `${sym} is exposed because ${mechanism.toLowerCase()} can spill through the same industry chain.`
            : `${sym} is tied to the same event.`;
    }

    function convictionSpec(level) {
        const normalized = getConvictionLevel(level);
        if (normalized === 'high') return { width: 3, dash: false, glyph: '●', alpha: 1 };
        if (normalized === 'low') return { width: 1, dash: true, glyph: '○', alpha: 0.85 };
        return { width: 2, dash: false, glyph: '◐', alpha: 0.95 };
    }

    function buildMechanismCard(label, detail, x) {
        const titleLines = wrapTextLines(label, 210, 12, 500, 2);
        const titleWidth = Math.max(...titleLines.map((line) => measureTextWidth(line, 12, 500)), 0);
        const width = Math.max(210, Math.min(300, Math.ceil(titleWidth + 44)));
        const height = Math.max(84, 70 + Math.max(0, titleLines.length - 1) * 14);
        return {
            id: null,
            kind: 'mechanism',
            label,
            detail,
            x,
            y: mechanismY,
            radius: 0,
            width,
            height,
            color: '#8d99ae',
            fill: '#131923',
            stroke: '#8d99ae',
            titleLines,
        };
    }

    const mechanismNodes = mechanismLabels.slice(0, 2).map((label, index) => {
        const x = index === 0 ? cx - Math.min(240, width * 0.2) : cx + Math.min(240, width * 0.2);
        return {
            ...buildMechanismCard(label, mechanismDetails[index] || label, x),
            id: `mech_${index}`,
        };
    });

    const tickerNodes = allTickers.map((sym) => {
        const meta = tickerMeta(sym);
        const direction = tickerImpact(sym);
        const conviction = getConvictionLevel(meta ? meta.conviction || 'medium' : 'medium');
        const perf = getTickerPerformanceRecord(signal, sym);
        const company = compactImpactLabel(String(meta?.company_name || meta?.name || sym).trim(), 4) || sym;
        const companyType = String(meta?.business_type || meta?.industry || meta?.sector || meta?.quote_type || '').trim();
        const graphNode = findGraphTickerNode(topology, sym);
        const modelWhy = compactImpactLabel(String(graphNode?.why_it_matters || graphNode?.relationship || '').trim(), 16);
        const fallbackReason = friendlyImpactText(sym, direction, meta ? meta.why_it_matters : '', companyType, mechanismLabels[direction === 'negative' ? 0 : 1] || mechanismLabels[0]);
        const reason = modelWhy || fallbackReason;
        const badgeWidth = 78;
        const badgeMargin = 14;
        const titleWidth = measureTextWidth(sym, 19, 700);
        const companyLines = wrapTextLines(company, 176, 8, 400, 2);
        const reasonLines = wrapTextLines(reason, 176, 8, 400, 3);
        const measuredWidth = Math.max(
            titleWidth,
            badgeWidth,
            ...companyLines.map((line) => measureTextWidth(line, 8, 400)),
            ...reasonLines.map((line) => measureTextWidth(line, 8, 400))
        );
        const width = Math.max(212, Math.min(290, Math.ceil(measuredWidth + 44)));
        const height = Math.max(132, 84 + (companyLines.length * 10) + (reasonLines.length * 10) + 18);
        return {
            id: `ticker_${sym}`,
            kind: 'ticker',
            ticker: sym,
            companyName: company,
            companyType,
            reason,
            modelReason: modelWhy,
            direction,
            conviction,
            performance: perf,
            label: sym,
            detail: reason,
            width,
            height,
            badgeWidth,
            badgeMargin,
            companyLines,
            reasonLines,
            color: direction === 'positive' ? '#00ff9d' : direction === 'negative' ? '#ff4d4d' : '#8d99ae',
            fill: direction === 'positive' ? '#0f2119' : direction === 'negative' ? '#251214' : '#111827',
            stroke: direction === 'positive' ? '#00ff9d' : direction === 'negative' ? '#ff4d4d' : '#8d99ae',
        };
    });

    const winners = tickerNodes.filter((node) => node.direction !== 'negative');
    const losers = tickerNodes.filter((node) => node.direction === 'negative');

    function spreadCluster(nodes, x, centerY) {
        if (!nodes.length) return [];
        const minY = Math.max(mechanismY + 92, height * 0.57);
        const maxY = Math.min(height - 94, height * 0.88);
        const cardHeight = Math.max(...nodes.map((node) => node.height || 0), 0);
        const spacing = nodes.length > 1
            ? Math.min(220, Math.max(cardHeight + 30, (maxY - minY) / (nodes.length - 1)))
            : 0;
        const totalHeight = spacing * Math.max(0, nodes.length - 1);
        const startY = Math.min(maxY, Math.max(minY, centerY - totalHeight / 2));
        return nodes.map((node, index) => ({ ...node, x, y: startY + (index * spacing) }));
    }

    const positionedWinners = spreadCluster(winners, leftX, tickerCenterY);
    const positionedLosers = spreadCluster(losers, rightX, tickerCenterY);
    const allNodes = [
        {
            id: 'root',
            kind: 'root',
            label: rootLabel,
            detail: signal.market_consensus_divergence || topology.root || signal.root_cause || 'Initial catalyst',
            x: cx,
            y: rootY,
            radius: Math.min(82, Math.max(64, Math.min(width, height) * 0.13)),
            color: '#0ea5e9',
            fill: '#0c2232',
            stroke: '#0ea5e9',
        },
        ...mechanismNodes,
        ...positionedWinners,
        ...positionedLosers,
    ];

    const nodeById = new Map(allNodes.map((node) => [node.id, node]));
    const links = [];

    mechanismNodes.forEach((mechanism, index) => {
        links.push({
            id: `root-${mechanism.id}`,
            source: nodeById.get('root'),
            target: mechanism,
            color: '#8d99ae',
            reason: index === 0
                ? `This event first changes how the market sees the business.`
                : `This event also creates a second market reaction.`,
            width: 3,
            dash: false,
            bias: mechanism.x < cx ? -1 : 1,
        });
    });

    const winnerSource = mechanismNodes[1] || mechanismNodes[0];
    const loserSource = mechanismNodes[0] || mechanismNodes[1];

    [...positionedWinners, ...positionedLosers].forEach((node) => {
        const source = node.direction === 'negative' ? loserSource : winnerSource;
        const style = convictionSpec(node.conviction);
        links.push({
            id: `${source.id}-${node.id}`,
            source,
            target: node,
            color: node.direction === 'negative' ? '#ff4d4d' : '#00ff9d',
            reason: node.direction === 'negative'
                ? `This company is pressured because ${compactImpactLabel(source.detail || source.label, 10).toLowerCase()} hits its business model.`
                : `This company benefits because ${compactImpactLabel(source.detail || source.label, 10).toLowerCase()} improves its business model.`,
            width: style.width,
            dash: style.dash,
            bias: node.direction === 'negative' ? 1 : -1,
        });
    });

    d3.select('#d3-container').select('svg').remove();

    const svg = d3.select('#d3-container').append('svg')
        .attr('width', width)
        .attr('height', height);

    const g = svg.append('g');
    const defs = svg.append('defs');

    defs.append('style').text(`
        @keyframes impactRootPulse {
            0%, 100% { transform: scale(1); opacity: 0.96; }
            50% { transform: scale(1.03); opacity: 1; }
        }
        .impact-root-pulse {
            transform-box: fill-box;
            transform-origin: center;
            animation: impactRootPulse 4s ease-in-out infinite;
        }
        text {
            overflow: hidden;
            text-overflow: ellipsis;
            word-wrap: break-word;
        }
        tspan {
            display: block;
        }
    `);

    const glow = defs.append('filter').attr('id', 'impact-glow').attr('x', '-50%').attr('y', '-50%').attr('width', '200%').attr('height', '200%');
    glow.append('feGaussianBlur').attr('stdDeviation', '5').attr('result', 'blur');
    glow.append('feMerge').selectAll('feMergeNode').data(['blur', 'SourceGraphic']).enter().append('feMergeNode').attr('in', d => d);

    [
        ['impact-arr-neutral', '#8d99ae'],
        ['impact-arr-positive', '#00ff9d'],
        ['impact-arr-negative', '#ff4d4d'],
    ].forEach(([id, color]) => {
        defs.append('marker')
            .attr('id', id)
            .attr('viewBox', '0 -4 8 8')
            .attr('refX', 18)
            .attr('refY', 0)
            .attr('markerWidth', 5)
            .attr('markerHeight', 5)
            .attr('orient', 'auto')
            .append('path')
            .attr('d', 'M0,-4L8,0L0,4')
            .attr('fill', color)
            .attr('opacity', 0.75);
    });

    const zoom = d3.zoom().scaleExtent([0.4, 2.5]).on('zoom', (event) => {
        g.attr('transform', event.transform);
    });

    svg.call(zoom);

    const linkLayer = g.append('g').attr('class', 'impact-links');
    const nodeLayer = g.append('g').attr('class', 'impact-nodes');
    const tooltip = d3.select('#d3-tooltip');
    let pinnedNode = null;
    let node;

    function curvePath(link) {
        const source = typeof link.source === 'object' ? link.source : nodeById.get(link.source);
        const target = typeof link.target === 'object' ? link.target : nodeById.get(link.target);
        if (!source || !target) return '';
        const bias = link.bias || (target.x < source.x ? -1 : 1);
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const curveX = Math.min(160, Math.abs(dx) * 0.35);
        const curveY = Math.min(90, Math.abs(dy) * 0.25);
        const c1x = source.x + (dx * 0.28) + (bias * curveX);
        const c1y = source.y + (dy * 0.25) - curveY;
        const c2x = target.x - (dx * 0.28) + (bias * curveX * 0.6);
        const c2y = target.y - (dy * 0.22) + curveY;
        return `M ${source.x} ${source.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${target.x} ${target.y}`;
    }

    const link = linkLayer.selectAll('path').data(links).enter().append('path')
        .attr('fill', 'none')
        .attr('stroke', d => d.color)
        .attr('stroke-width', d => d.width)
        .attr('stroke-dasharray', d => d.dash ? '6,4' : 'none')
        .attr('stroke-linecap', 'round')
        .attr('opacity', d => d.dash ? 0.55 : 0.8)
        .attr('marker-end', d => {
            if (d.color === '#00ff9d') return 'url(#impact-arr-positive)';
            if (d.color === '#ff4d4d') return 'url(#impact-arr-negative)';
            return 'url(#impact-arr-neutral)';
        })
        .attr('d', curvePath);

    function positionImpactTooltip(event) {
        // Consistently anchor tooltip to top-right of the container
        tooltip
            .style('left', 'auto')
            .style('right', '16px')
            .style('top', '16px')
            .style('bottom', 'auto');
    }

    const linkHover = linkLayer.selectAll('path.link-hover').data(links).enter().append('path')
        .attr('class', 'link-hover')
        .attr('fill', 'none')
        .attr('stroke', 'transparent')
        .attr('stroke-width', 20)
        .attr('d', curvePath)
        .style('pointer-events', 'stroke')
        .on('mouseenter', (event, d) => {
            tooltip.transition().duration(160).style('opacity', 1);
            tooltip.html(`<div class="text-[10px] font-label-caps tracking-widest uppercase mb-2" style="color:${escapeHtml(d.color)};">Connection</div><div class="text-[13px] leading-relaxed text-body-strong">${escapeHtml(d.reason)}</div>`);
            positionImpactTooltip(event);
        })
        .on('mousemove', (event) => {
            positionImpactTooltip(event);
        })
        .on('mouseleave', () => {
            if (!pinnedNode) {
                tooltip.transition().duration(160).style('opacity', 0);
            }
        });

    function nodeTransform(node) {
        const scale = node.scale || 1;
        return `translate(${node.x},${node.y}) scale(${scale})`;
    }

    function updateNodeTransforms() {
        node.attr('transform', nodeTransform);
    }

    function clearFocus() {
        allNodes.forEach((node) => { node.scale = 1; });
        node.transition().duration(180).style('opacity', 1);
        updateNodeTransforms();
        link.transition().duration(180).style('opacity', d => d.dash ? 0.55 : 0.8);
        link.attr('stroke-width', d => d.width);
        tooltip.transition().duration(160).style('opacity', 0);
    }

    function focusNode(selected) {
        const connected = new Set([selected.id]);
        links.forEach((linkItem) => {
            const sourceId = typeof linkItem.source === 'object' ? linkItem.source.id : linkItem.source;
            const targetId = typeof linkItem.target === 'object' ? linkItem.target.id : linkItem.target;
            if (sourceId === selected.id) connected.add(targetId);
            if (targetId === selected.id) connected.add(sourceId);
        });

        allNodes.forEach((nodeItem) => {
            nodeItem.scale = nodeItem.id === selected.id ? 1.06 : 1;
        });

        node.transition().duration(180).style('opacity', (item) => connected.has(item.id) ? 1 : 0.2);
        link.transition().duration(180).style('opacity', (item) => {
            const sourceId = typeof item.source === 'object' ? item.source.id : item.source;
            const targetId = typeof item.target === 'object' ? item.target.id : item.target;
            return (sourceId === selected.id || targetId === selected.id) ? 0.95 : 0.08;
        });
        updateNodeTransforms();
        tooltip.transition().duration(160).style('opacity', 1);
    }

    node = nodeLayer.selectAll('g').data(allNodes).enter().append('g')
        .style('cursor', 'pointer')
        .style('transform-box', 'fill-box')
        .style('transform-origin', 'center')
        .attr('transform', nodeTransform);

    node.each(function(nodeData) {
        const el = d3.select(this);
        if (nodeData.kind === 'root') {
            el.append('circle')
                .attr('r', nodeData.radius)
                .attr('fill', nodeData.fill)
                .attr('stroke', nodeData.stroke)
                .attr('stroke-width', 2.5)
                .attr('filter', 'url(#impact-glow)')
                .classed('impact-root-pulse', true);
            el.append('circle')
                .attr('r', nodeData.radius - 10)
                .attr('fill', 'none')
                .attr('stroke', 'rgba(255,255,255,0.14)')
                .attr('stroke-width', 1);
            const rootText = el.append('text')
                .attr('text-anchor', 'middle')
                .attr('dy', '-0.25em')
                .attr('fill', '#d8f0ff')
                .attr('font-size', '13px')
                .attr('font-weight', 700)
                .attr('font-family', 'JetBrains Mono, monospace');
            wrapSvgText(rootText, nodeData.label, nodeData.radius * 1.55, 2, 1.16);
        } else if (nodeData.kind === 'mechanism') {
            el.append('rect')
                .attr('x', -nodeData.width / 2)
                .attr('y', -nodeData.height / 2)
                .attr('width', nodeData.width)
                .attr('height', nodeData.height)
                .attr('rx', 18)
                .attr('fill', nodeData.fill)
                .attr('stroke', nodeData.stroke)
                .attr('stroke-width', 1.5)
                .attr('opacity', 0.95);
            const mechanismText = el.append('text')
                .attr('text-anchor', 'middle')
                .attr('y', -6)
                .attr('fill', '#e4e7ef')
                .attr('font-size', '12px')
                .attr('font-weight', 500)
                .attr('font-family', 'JetBrains Mono, monospace')
                .attr('x', 0);
            renderWrappedLines(mechanismText, nodeData.titleLines || wrapTextLines(nodeData.label, nodeData.width - 30, 12, 500, 2), 1.16);
            el.append('text')
                .attr('text-anchor', 'middle')
                .attr('y', 20)
                .attr('fill', '#8d99ae')
                .attr('font-size', '10px')
                .attr('font-family', 'JetBrains Mono, monospace')
                .text('mechanism');
        } else {
            el.append('rect')
                .attr('x', -nodeData.width / 2)
                .attr('y', -nodeData.height / 2)
                .attr('width', nodeData.width)
                .attr('height', nodeData.height)
                .attr('rx', 18)
                .attr('fill', nodeData.fill)
                .attr('stroke', nodeData.stroke)
                .attr('stroke-width', 1.6)
                .attr('opacity', 0.98);

            const badgeWidth = nodeData.badgeWidth || 78;
            const badgeHeight = 26;
            const badgeMargin = nodeData.badgeMargin || 14;
            const badge = el.append('g').attr('transform', `translate(${nodeData.width / 2 - badgeWidth - badgeMargin}, ${-nodeData.height / 2 + badgeMargin})`);
            badge.append('rect')
                .attr('x', 0)
                .attr('y', 0)
                .attr('width', badgeWidth)
                .attr('height', badgeHeight)
                .attr('rx', 13)
                .attr('fill', nodeData.direction === 'positive' ? 'rgba(0,255,157,0.12)' : nodeData.direction === 'negative' ? 'rgba(255,77,77,0.12)' : 'rgba(141,153,174,0.12)')
                .attr('stroke', nodeData.direction === 'positive' ? '#00ff9d' : nodeData.direction === 'negative' ? '#ff4d4d' : '#8d99ae')
                .attr('stroke-width', 1);
            badge.append('text')
                .attr('text-anchor', 'middle')
                .attr('x', badgeWidth / 2)
                .attr('y', 10)
                .attr('dominant-baseline', 'middle')
                .attr('fill', nodeData.direction === 'positive' ? '#00ff9d' : nodeData.direction === 'negative' ? '#ff4d4d' : '#c5cedd')
                .attr('font-size', '8px')
                .attr('font-weight', 700)
                .attr('font-family', 'JetBrains Mono, monospace')
                .text(nodeData.performance ? nodeData.performance.label : 'N/A');
            badge.append('text')
                .attr('text-anchor', 'middle')
                .attr('x', badgeWidth / 2)
                .attr('y', 18)
                .attr('dominant-baseline', 'middle')
                .attr('fill', '#8d99ae')
                .attr('font-size', '6px')
                .attr('font-family', 'JetBrains Mono, monospace')
                .text('since publish');

            el.append('text')
                .attr('text-anchor', 'middle')
                .attr('y', -6)
                .attr('fill', '#f3f6fb')
                .attr('font-size', '19px')
                .attr('font-weight', 700)
                .attr('font-family', 'JetBrains Mono, monospace')
                .text(nodeData.ticker);

            const companyText = el.append('text')
                .attr('text-anchor', 'middle')
                .attr('y', 8)
                .attr('fill', '#9fb0c8')
                .attr('font-size', '8px')
                .attr('font-family', 'JetBrains Mono, monospace')
                .attr('x', 0);
            renderWrappedLines(companyText, nodeData.companyLines || wrapTextLines(nodeData.companyName, nodeData.width - 44, 8, 400, 2), 1.08);

            const reasonText = el.append('text')
                .attr('text-anchor', 'middle')
                .attr('y', nodeData.companyLines && nodeData.companyLines.length > 1 ? 28 : 24)
                .attr('fill', '#d2d9e4')
                .attr('font-size', '8px')
                .attr('font-family', 'JetBrains Mono, monospace')
                .attr('x', 0);
            renderWrappedLines(reasonText, nodeData.reasonLines || wrapTextLines(compactImpactLabel(nodeData.reason, 10), nodeData.width - 44, 8, 400, 3), 1.08);

            el.append('text')
                .attr('x', -nodeData.width / 2 + 18)
                .attr('y', nodeData.height / 2 - 16)
                .attr('fill', nodeData.direction === 'positive' ? '#00ff9d' : nodeData.direction === 'negative' ? '#ff4d4d' : '#8d99ae')
                .attr('font-size', '11px')
                .attr('font-family', 'JetBrains Mono, monospace')
                .attr('title', `${nodeData.conviction} conviction`)
                .text(getConvictionGlyph(nodeData.conviction));
        }
    });

    node.on('mouseenter', (event, nodeData) => {
        if (pinnedNode && pinnedNode.id !== nodeData.id) return;
        if (nodeData.kind === 'ticker') {
            nodeData.scale = 1.06;
            updateNodeTransforms();
        }
        focusNode(nodeData);
        const title = nodeData.kind === 'ticker' ? `${escapeHtml(nodeData.ticker)} · ${escapeHtml(nodeData.companyName)}` : escapeHtml(nodeData.label);
        const body = nodeData.kind === 'ticker'
            ? `This is a ${nodeData.direction === 'positive' ? 'winner' : nodeData.direction === 'negative' ? 'loser' : 'neutral'} because ${escapeHtml(nodeData.reason)}.`
            : escapeHtml(nodeData.detail || nodeData.label);
        tooltip.html(`<div class="text-[10px] font-label-caps tracking-widest uppercase mb-2" style="color:${nodeData.color};">${nodeData.kind === 'ticker' ? (nodeData.direction === 'positive' ? 'WINNER' : nodeData.direction === 'negative' ? 'LOSER' : 'TICKER') : nodeData.kind.toUpperCase()}</div><div class="font-display-ticker text-lg text-body-strong mb-1">${title}</div><div class="text-[13px] leading-relaxed text-body-strong opacity-90">${body}</div>`);
        positionImpactTooltip(event);
    }).on('mousemove', (event) => {
        positionImpactTooltip(event);
    }).on('mouseleave', (event, nodeData) => {
        if (pinnedNode) return;
        if (nodeData.kind === 'ticker') {
            nodeData.scale = 1;
            updateNodeTransforms();
        }
        clearFocus();
    }).on('click', (event, nodeData) => {
        event.stopPropagation();
        pinnedNode = nodeData;
        focusNode(nodeData);
    });

    svg.on('click', () => {
        pinnedNode = null;
        clearFocus();
    });

    function fitImpactView() {
        svg.transition().duration(550).call(zoom.transform, d3.zoomIdentity);
    }

    const fitBtn = document.getElementById('reheat-btn');
    if (fitBtn) {
        fitBtn.onclick = (event) => {
            event.stopPropagation();
            fitImpactView();
        };
    }

    const resizeObserver = new ResizeObserver(entries => {
        for (const entry of entries) {
            const nextWidth = entry.contentRect.width;
            const nextHeight = entry.contentRect.height;
            svg.attr('width', nextWidth).attr('height', nextHeight);
        }
    });
    resizeObserver.observe(container);

    fitImpactView();
}

function truncate(str, max) { if (!str) return ''; return str.length > max ? str.substring(0, max) + '...' : str; }

function wrapSvgText(textElement, text, maxWidth, maxLines = 2, lineHeight = 1.1) {
    const selection = textElement && textElement.node ? textElement : d3.select(textElement);
    const node = selection.node();
    if (!node) return '';

    const original = String(text || '').trim();
    selection.text('');
    if (!original) return '';

    const words = original.split(/\s+/).filter(Boolean);
    if (words.length === 0) return '';

    const lines = [];
    let currentLine = '';

    const measureText = (value) => {
        selection.text(value);
        return node.getComputedTextLength();
    };

    words.forEach((word) => {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        if (measureText(testLine) <= maxWidth) {
            currentLine = testLine;
            return;
        }

        if (currentLine) {
            lines.push(currentLine);
        }
        currentLine = word;
    });

    if (currentLine) {
        lines.push(currentLine);
    }

    while (lines.length > maxLines) {
        const spill = lines.pop();
        lines[lines.length - 1] = `${lines[lines.length - 1]} ${spill}`.trim();
    }

    selection.text(null);
    lines.forEach((line, index) => {
        selection.append('tspan')
            .attr('x', 0)
            .attr('dy', index === 0 ? '0' : `${lineHeight}em`)
            .text(line);
    });

    return lines.join('\n');
}

// Logic Functions
async function fetchSignals() {
    const startTime = performance.now();
    try {
        const res = await apiFetch('/api/signals?limit=50');
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
    
    // Pagination logic
    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    if (currentPage > totalPages) {
        currentPage = totalPages;
    }
    
    // Update Pagination UI
    const prevBtn = document.getElementById('page-prev');
    const nextBtn = document.getElementById('page-next');
    const pageIndicator = document.getElementById('page-indicator');
    
    if (prevBtn) prevBtn.disabled = currentPage === 1;
    if (nextBtn) nextBtn.disabled = currentPage === totalPages;
    if (pageIndicator) pageIndicator.textContent = `PAGE ${currentPage} OF ${totalPages}`;
    
    // Slice data
    const startIdx = (currentPage - 1) * pageSize;
    const paginated = filtered.slice(startIdx, startIdx + pageSize);
    
    if (paginated.length === 0) {
        signalFeedContainer.innerHTML = `<div class="text-on-surface-variant p-4 text-center text-sm italic">No signals found.</div>`;
        return;
    }
    
    signalFeedContainer.innerHTML = paginated.map(renderSignalCard).join('');
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
    const signal = signals.find(s => s.id === id);
    const color = signal ? (signal.direction === 'BULLISH' ? 'secondary' : signal.direction === 'BEARISH' ? 'error' : 'primary-fixed-dim') : 'primary';

    document.querySelectorAll('#signal-feed > div').forEach(el => {
        el.classList.remove('bg-surface-card-elevated', 'border-l-primary', 'border-l-secondary', 'border-l-error', 'border-l-primary-fixed-dim');
        el.classList.add('bg-transparent', 'border-l-transparent');
        
        if (el.dataset.id === id) {
            el.classList.remove('bg-transparent', 'border-l-transparent');
            el.classList.add('bg-surface-card-elevated', `border-l-${color}`);
        }
    });

    try {
        const res = await apiFetch('/api/signals/' + id);
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
        <div class="px-cell-padding-x border-b border-hairline bg-surface-card flex justify-between items-center shrink-0" style="height: 40px;">
            <h2 class="font-code text-[11px] uppercase tracking-widest text-muted">Analysis Node</h2>
        </div>
        <div class="flex-1 flex flex-col items-center justify-center text-muted p-6 text-center">
            <div class="w-16 h-16 rounded-sm bg-surface-card-elevated flex items-center justify-center mb-4 border border-hairline-strong">
                <span class="material-symbols-outlined text-[24px] text-muted/50">hub</span>
            </div>
            <div class="text-[12px] font-code text-body-strong mb-1 uppercase tracking-wider">No Signal Selected</div>
            <div class="text-[11px] font-code text-muted/60 max-w-[200px]">SELECT A SIGNAL FROM THE FEED TO VIEW ITS CAUSAL CHAIN ANALYSIS.</div>
        </div>
    `;
    activeSignalId = null;
    renderCenterGraph(null);
    document.querySelectorAll('#signal-feed > div').forEach(el => {
        el.classList.remove('bg-surface-card-elevated', 'border-l-primary');
        el.classList.add('bg-surface-card', 'border-l-transparent');
        ['secondary', 'error', 'primary-fixed-dim'].forEach(c => el.classList.remove(`border-l-${c}`));
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
    if (API_BASE_URL) {
        if (window.__signalPollInterval) clearInterval(window.__signalPollInterval);
        window.__signalPollInterval = setInterval(fetchSignals, 15000);
        return;
    }

    const evtSource = new EventSource(apiUrl('/api/events'));
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

    document.getElementById('filter-ALL').addEventListener('click', () => { currentPage = 1; setFilter('ALL'); });
    document.getElementById('filter-BULL').addEventListener('click', () => { currentPage = 1; setFilter('BULLISH'); });
    document.getElementById('filter-BEAR').addEventListener('click', () => { currentPage = 1; setFilter('BEARISH'); });

    document.getElementById('signal-search').addEventListener('input', (e) => {
        searchQuery = e.target.value.toLowerCase();
        currentPage = 1;
        renderSignalFeed();
    });

    document.getElementById('new-signal-pill').addEventListener('click', () => {
        displayedSignals = [...signals];
        unseenSignalsCount = 0;
        currentPage = 1;
        document.getElementById('new-signal-pill').classList.add('hidden');
        renderSignalFeed();
        signalFeedContainer.scrollTop = 0;
    });

    const prevBtn = document.getElementById('page-prev');
    if (prevBtn) {
        prevBtn.addEventListener('click', () => {
            if (currentPage > 1) {
                currentPage--;
                renderSignalFeed();
                signalFeedContainer.scrollTop = 0;
            }
        });
    }

    const nextBtn = document.getElementById('page-next');
    if (nextBtn) {
        nextBtn.addEventListener('click', () => {
            currentPage++;
            renderSignalFeed();
            signalFeedContainer.scrollTop = 0;
        });
    }

    // Initial load
    clearAnalysisNode();
    fetchSignals();
    
    // Start SSE stream
    setupSSE();

    // Restore auth session
    restoreSession();

    // Close popovers on outside click
    document.addEventListener('click', (e) => {
        const authPopover = document.getElementById('auth-popover');
        const notifPopover = document.getElementById('notification-popover');
        const authTrigger = document.getElementById('auth-trigger');
        const notifTrigger = document.getElementById('notif-trigger');

        if (authPopover && !authPopover.classList.contains('hidden') && !authPopover.contains(e.target) && !authTrigger.contains(e.target)) {
            authPopover.classList.add('hidden');
        }
        if (notifPopover && !notifPopover.classList.contains('hidden') && !notifPopover.contains(e.target) && !notifTrigger.contains(e.target)) {
            notifPopover.classList.add('hidden');
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isTopologyFullscreen) {
            setTopologyFullscreen(false);
        }
    });
});

// ============================================================
// Auth Functions
// ============================================================

async function restoreSession() {
    if (!sessionToken) {
        updateAuthUI();
        return;
    }
    try {
        const res = await apiFetch('/api/auth/me', { headers: authHeaders() });
        if (res.ok) {
            const data = await res.json();
            currentUser = data.user;
            updateAuthUI();
            startNotificationPolling();
        } else {
            // Invalid session
            sessionToken = null;
            localStorage.removeItem('mp_session_token');
            updateAuthUI();
        }
    } catch (e) {
        console.error('Session restore failed:', e);
        updateAuthUI();
    }
}

function updateAuthUI() {
    const authPage = document.getElementById('auth-page');
    const appDashboard = document.getElementById('app-dashboard');
    const userView = document.getElementById('auth-user-view');
    const authIcon = document.getElementById('auth-icon');

    if (currentUser) {
        // Logged in: show dashboard, hide auth page
        authPage.classList.add('hidden');
        appDashboard.classList.remove('hidden');
        
        // Update user profile popover
        if (userView) userView.classList.remove('hidden');
        if (authIcon) {
            authIcon.textContent = 'person';
            authIcon.style.fontVariationSettings = '"FILL" 1';
        }

        document.getElementById('auth-user-name').textContent = currentUser.display_name || currentUser.email;
        document.getElementById('auth-user-email').textContent = currentUser.email;
        document.getElementById('auth-telegram-code').textContent = currentUser.telegram_link_code || '—';
        document.getElementById('auth-telegram-status').textContent = currentUser.telegram_id ? '✓ Linked' : 'Not linked';

        const initials = (currentUser.display_name || currentUser.email || '?').substring(0, 2).toUpperCase();
        document.getElementById('auth-avatar').textContent = initials;
    } else {
        // Not logged in: show auth page, hide dashboard
        if (window.location.pathname !== '/landing.html') {
            window.location.replace('/landing.html');
            return;
        }
        authPage.classList.remove('hidden');
        appDashboard.classList.add('hidden');
        
        // Hide user profile popover content just in case
        if (userView) userView.classList.add('hidden');
        if (authIcon) {
            authIcon.textContent = 'person';
            authIcon.style.fontVariationSettings = '"FILL" 0';
        }
        document.getElementById('auth-popover').classList.add('hidden');
    }
}

let isRegisterMode = false;
function toggleAuthMode() {
    isRegisterMode = !isRegisterMode;
    const nameContainer = document.getElementById('auth-display-name-container');
    const loginBtn = document.getElementById('auth-login-btn');
    const registerBtn = document.getElementById('auth-register-btn');
    const toggleBtn = document.getElementById('auth-toggle-btn');
    const errorEl = document.getElementById('auth-error');
    
    errorEl.classList.add('hidden');

    if (isRegisterMode) {
        nameContainer.classList.remove('hidden');
        loginBtn.classList.add('hidden');
        registerBtn.classList.remove('hidden');
        toggleBtn.textContent = 'Already have an account? Log In';
    } else {
        nameContainer.classList.add('hidden');
        loginBtn.classList.remove('hidden');
        registerBtn.classList.add('hidden');
        toggleBtn.textContent = "Don't have an account? Register";
    }
}

function toggleAuthPopover() {
    if (!currentUser) return;
    const popover = document.getElementById('auth-popover');
    document.getElementById('notification-popover').classList.add('hidden');
    popover.classList.toggle('hidden');
}

async function authRegister() {
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    const displayName = document.getElementById('auth-display-name').value.trim();
    const errorEl = document.getElementById('auth-error');
    errorEl.classList.add('hidden');

    try {
        const res = await apiFetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, display_name: displayName })
        });
        const data = await res.json();
        if (!res.ok) {
            errorEl.textContent = data.error;
            errorEl.classList.remove('hidden');
            return;
        }
        sessionToken = data.session_token;
        localStorage.setItem('mp_session_token', sessionToken);
        currentUser = data.user;
        updateAuthUI();
        startNotificationPolling();
    } catch (e) {
        errorEl.textContent = 'Network error';
        errorEl.classList.remove('hidden');
    }
}

async function authLogin() {
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    const errorEl = document.getElementById('auth-error');
    errorEl.classList.add('hidden');

    try {
        const res = await apiFetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        const data = await res.json();
        if (!res.ok) {
            errorEl.textContent = data.error;
            errorEl.classList.remove('hidden');
            return;
        }
        sessionToken = data.session_token;
        localStorage.setItem('mp_session_token', sessionToken);
        currentUser = data.user;
        updateAuthUI();
        startNotificationPolling();
    } catch (e) {
        errorEl.textContent = 'Network error';
        errorEl.classList.remove('hidden');
    }
}

async function authLogout() {
    try {
        await apiFetch('/api/auth/logout', { method: 'POST', headers: authHeaders() });
    } catch (e) {}
    sessionToken = null;
    currentUser = null;
    localStorage.removeItem('mp_session_token');
    updateAuthUI();
    if (notifPollInterval) { clearInterval(notifPollInterval); notifPollInterval = null; }
    document.getElementById('notif-badge').classList.add('hidden');
    document.getElementById('auth-popover').classList.add('hidden');
}

// ============================================================
// Notification Functions
// ============================================================

function toggleNotificationPopover() {
    const popover = document.getElementById('notification-popover');
    document.getElementById('auth-popover').classList.add('hidden');
    popover.classList.toggle('hidden');
    if (!popover.classList.contains('hidden') && currentUser) {
        fetchNotifications();
    }
}

async function fetchNotifications() {
    if (!currentUser) return;
    try {
        const res = await apiFetch('/api/notifications?limit=20', { headers: authHeaders() });
        if (!res.ok) return;
        const notifications = await res.json();
        renderNotificationList(notifications);
    } catch (e) {
        console.error('Failed to fetch notifications:', e);
    }
}

function renderNotificationList(notifications) {
    const container = document.getElementById('notification-list');
    if (!notifications || notifications.length === 0) {
        container.innerHTML = `<div class="p-6 text-center text-muted text-sm">
            <span class="material-symbols-outlined text-[24px] text-muted/30 block mb-2">notifications_none</span>
            No notifications yet.
        </div>`;
        return;
    }
    container.innerHTML = notifications.map(n => {
        const tickers = Array.isArray(n.tickers) ? n.tickers : (typeof n.tickers === 'string' ? JSON.parse(n.tickers || '[]') : []);
        const tickerStr = tickers.map(t => typeof t === 'string' ? t : (t.symbol || '')).filter(Boolean).join(', ');
        const headline = n.source_headline || n.root_cause || 'Signal matched your watchlist';
        const timeAgoStr = timeAgo(n.created_at);
        const dirColor = n.direction === 'BULLISH' ? 'secondary' : n.direction === 'BEARISH' ? 'error' : 'primary-fixed-dim';
        const unreadDot = !n.read ? `<div class="w-2 h-2 rounded-full bg-primary shrink-0"></div>` : '';

        return `<div class="px-4 py-3 border-b border-hairline hover:bg-surface-card-elevated cursor-pointer transition-colors flex items-start gap-3 ${n.read ? 'opacity-60' : ''}"
            onclick="handleNotificationClick('${n.signal_id}', '${n.id}')">
            ${unreadDot}
            <div class="flex-1 min-w-0">
                <div class="text-[12px] text-body-strong leading-snug mb-1 truncate">${escapeHtml(headline)}</div>
                <div class="flex items-center gap-2">
                    <span class="text-[10px] text-${dirColor} font-label-caps tracking-wider">${n.direction || ''}</span>
                    <span class="text-[10px] text-muted">${escapeHtml(tickerStr)}</span>
                    <span class="text-[10px] text-muted ml-auto">${timeAgoStr}</span>
                </div>
            </div>
        </div>`;
    }).join('');
}

async function handleNotificationClick(signalId, notifId) {
    // Mark as read
    try {
        await apiFetch(`/api/notifications/${notifId}/read`, { method: 'POST', headers: authHeaders() });
    } catch (e) {}
    // Load the signal
    document.getElementById('notification-popover').classList.add('hidden');
    loadSignalDetails(signalId);
    pollNotificationCount();
}

async function markAllNotificationsRead() {
    if (!currentUser) return;
    try {
        await apiFetch('/api/notifications/read-all', { method: 'POST', headers: authHeaders() });
        fetchNotifications();
        pollNotificationCount();
    } catch (e) {}
}

async function pollNotificationCount() {
    if (!currentUser) return;
    try {
        const res = await apiFetch('/api/notifications?count=true', { headers: authHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        const badge = document.getElementById('notif-badge');
        if (data.unread_count > 0) {
            badge.textContent = data.unread_count > 9 ? '9+' : data.unread_count;
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    } catch (e) {}
}

function startNotificationPolling() {
    pollNotificationCount();
    if (notifPollInterval) clearInterval(notifPollInterval);
    notifPollInterval = setInterval(pollNotificationCount, 15000);
}

// ============================================================
// Watchlist Drawer Functions
// ============================================================

let watchlistDrawerOpen = false;

function toggleWatchlistDrawer() {
    const drawer = document.getElementById('watchlist-drawer');
    const backdrop = document.getElementById('watchlist-backdrop');
    watchlistDrawerOpen = !watchlistDrawerOpen;

    if (watchlistDrawerOpen) {
        backdrop.classList.remove('hidden');
        drawer.classList.remove('translate-x-full');
        drawer.classList.add('translate-x-0');
        if (currentUser) fetchWatchlistRules();
        else renderWatchlistNotLoggedIn();
    } else {
        backdrop.classList.add('hidden');
        drawer.classList.add('translate-x-full');
        drawer.classList.remove('translate-x-0');
    }
}

function renderWatchlistNotLoggedIn() {
    document.getElementById('watchlist-items').innerHTML = `
        <div class="flex-1 flex flex-col items-center justify-center text-muted p-6 text-center h-full">
            <span class="material-symbols-outlined text-[32px] text-muted/30 mb-3">lock</span>
            <div class="text-[13px] text-body-strong mb-1">Login Required</div>
            <div class="text-[11px] max-w-[200px]">Create an account to set up watchlist rules and receive personalized alerts.</div>
        </div>`;
}

async function fetchWatchlistRules() {
    if (!currentUser) return renderWatchlistNotLoggedIn();
    try {
        const res = await apiFetch('/api/watchlist', { headers: authHeaders() });
        if (!res.ok) return;
        const rules = await res.json();
        renderWatchlistItems(rules);
    } catch (e) {
        console.error('Failed to fetch watchlist:', e);
    }
}

function renderWatchlistItems(rules) {
    const container = document.getElementById('watchlist-items');
    if (!rules || rules.length === 0) {
        container.innerHTML = `
            <div class="flex-1 flex flex-col items-center justify-center text-muted p-6 text-center">
                <span class="material-symbols-outlined text-[32px] text-muted/30 mb-3">playlist_add</span>
                <div class="text-[13px] text-body-strong mb-1">No Rules Yet</div>
                <div class="text-[11px] max-w-[200px]">Add a watchlist rule below to start receiving personalized signal alerts.</div>
            </div>`;
        return;
    }
    container.innerHTML = rules.map(r => {
        const dirDot = r.direction === 'BULLISH' ? 'bg-secondary' : r.direction === 'BEARISH' ? 'bg-error' : r.direction === 'MIXED' ? 'bg-primary-fixed-dim' : 'bg-muted';
        const dirLabel = r.direction || 'Any';
        const notifIcons = [];
        if (r.notify_telegram) notifIcons.push('<span class="material-symbols-outlined text-[12px]">send</span>');
        if (r.notify_in_app) notifIcons.push('<span class="material-symbols-outlined text-[12px]">notifications</span>');

        return `<div class="bg-surface-card border border-hairline rounded-lg p-3 flex flex-col gap-2">
            <div class="flex items-center justify-between">
                <div class="flex items-center gap-2">
                    <div class="bg-surface-card-elevated border border-hairline-strong rounded px-2 py-0.5 text-body-strong text-xs font-display-ticker">${escapeHtml(r.ticker)}</div>
                    <div class="w-2 h-2 rounded-full ${dirDot}"></div>
                    <span class="text-[10px] text-muted font-label-caps tracking-wider">${escapeHtml(dirLabel)}</span>
                </div>
                <div class="flex items-center gap-1">
                    <span class="text-muted flex items-center gap-0.5 text-[11px]">${notifIcons.join('')}</span>
                    <button class="text-muted hover:text-error p-1 transition-colors" onclick="deleteWatchlistRule('${r.id}')">
                        <span class="material-symbols-outlined text-[14px]">delete</span>
                    </button>
                </div>
            </div>
            <div class="flex items-center gap-3 text-[10px] text-muted">
                <span>Conf: ${r.min_confidence}–${r.max_confidence}%</span>
                ${r.time_horizon ? `<span>Horizon: ${escapeHtml(r.time_horizon)}</span>` : ''}
            </div>
        </div>`;
    }).join('');
}

function toggleWatchlistForm() {
    const form = document.getElementById('watchlist-form');
    form.classList.toggle('hidden');
}

async function createWatchlistRule() {
    if (!currentUser) return;
    const errorEl = document.getElementById('wl-error');
    errorEl.classList.add('hidden');

    const ticker = document.getElementById('wl-ticker').value.trim().toUpperCase();
    if (!ticker) {
        errorEl.textContent = 'Ticker is required';
        errorEl.classList.remove('hidden');
        return;
    }

    const body = {
        ticker,
        direction: document.getElementById('wl-direction').value || null,
        min_confidence: parseInt(document.getElementById('wl-min-conf').value, 10) || 0,
        max_confidence: parseInt(document.getElementById('wl-max-conf').value, 10) || 100,
        time_horizon: document.getElementById('wl-horizon').value || null,
        notify_telegram: document.getElementById('wl-notify-telegram').checked,
        notify_in_app: document.getElementById('wl-notify-inapp').checked
    };

    try {
        const res = await apiFetch('/api/watchlist', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok) {
            errorEl.textContent = data.error;
            errorEl.classList.remove('hidden');
            return;
        }
        // Reset form and refresh list
        document.getElementById('wl-ticker').value = '';
        document.getElementById('wl-direction').value = '';
        document.getElementById('wl-min-conf').value = '0';
        document.getElementById('wl-max-conf').value = '100';
        document.getElementById('wl-horizon').value = '';
        document.getElementById('watchlist-form').classList.add('hidden');
        fetchWatchlistRules();
    } catch (e) {
        errorEl.textContent = 'Network error';
        errorEl.classList.remove('hidden');
    }
}

async function deleteWatchlistRule(id) {
    if (!currentUser) return;
    try {
        await apiFetch('/api/watchlist/' + id, { method: 'DELETE', headers: authHeaders() });
        fetchWatchlistRules();
    } catch (e) {
        console.error('Failed to delete watchlist rule:', e);
    }
}

function openWatchlistForSignal(ticker, direction, confidence) {
    if (!currentUser) {
        toggleAuthPopover();
        return;
    }
    // Open drawer and pre-fill form
    if (!watchlistDrawerOpen) toggleWatchlistDrawer();
    document.getElementById('watchlist-form').classList.remove('hidden');
    document.getElementById('wl-ticker').value = ticker || '';
    document.getElementById('wl-direction').value = direction || '';
    document.getElementById('wl-min-conf').value = Math.max(0, (confidence || 0) - 10);
    document.getElementById('wl-max-conf').value = '100';
}
