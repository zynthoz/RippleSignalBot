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
let currentPage = 1;
const pageSize = 10;

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
    
    // Tickers
    const tickers = normalizeTickerList(signal.tickers);
    const tickerHtml = tickers.length > 0 
        ? `<div class="flex gap-1.5 flex-wrap">` + tickers.map(t => `<span class="bg-surface-card-elevated border border-hairline-strong text-body-strong text-[11px] font-data-tabular px-2 py-0.5 rounded shadow-sm">${escapeHtml(t)}</span>`).join('') + `</div>`
        : `<span class="text-muted text-[11px] font-data-tabular">N/A</span>`;

    // Confidence
    const confVal = parseInt(signal.confidence, 10) || 0;
    let confColor = 'error';
    if (confVal >= 80) confColor = 'secondary';
    else if (confVal >= 60) confColor = 'accent-violet';

    const age = timeAgo(signal.created_at);
    const reasoningExcerpt = escapeHtml((signal.source_headline || signal.reasoning || '').substring(0, 55)) + '...';

    const isActive = signal.id === activeSignalId;
    const activeClasses = isActive ? 'bg-surface-card-elevated border-l-primary' : 'bg-surface-card border-l-transparent';

    return `
    <div class="${activeClasses} border-l-[3px] border-y border-r border-hairline p-3 cursor-pointer hover:bg-surface-card-elevated hover:border-l-${color} transition-all group rounded-md" onclick="loadSignalDetails('${signal.id}')" data-id="${signal.id}">
        <div class="flex justify-between items-start mb-2">
            ${tickerHtml}
            <span class="font-data-tabular text-muted/50 text-[9px] mt-0.5">${age}</span>
        </div>
        <div class="font-body-compact text-body-strong text-[13px] leading-snug mb-3 opacity-90 group-hover:opacity-100 transition-opacity">${reasoningExcerpt}</div>
        <div class="flex justify-between items-end">
            <div class="flex items-center gap-1.5">
                <div class="w-1.5 h-1.5 rounded-full bg-${color}"></div>
                <span class="text-[10px] font-label-caps text-muted uppercase tracking-widest">${signal.direction}</span>
            </div>
            <div class="flex items-center gap-1.5">
                <span class="font-data-tabular text-[11px] text-${confColor} font-bold">${confVal}%</span>
                <div class="w-10 bg-hairline-strong h-1 rounded-full overflow-hidden">
                    <div class="bg-${confColor} h-full rounded-full" style="width: ${confVal}%"></div>
                </div>
            </div>
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

        return `<div class="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-${pillColor}/30 ${pillBg} text-${pillColor}">
            <span class="material-symbols-outlined text-[14px]">${pillIcon}</span>
            <span class="font-data-tabular font-bold text-sm">${escapeHtml(sym)}</span>
        </div>`;
    }).filter(Boolean);

    return `<div class="flex flex-wrap justify-center gap-2 mb-6">${pills.join('')}</div>`;
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
            <div class="relative pl-6 pb-4">
                ${idx < catalystChain.length - 1 ? `<div class="absolute left-2 top-6 bottom-0 w-[2px] bg-gradient-to-b from-hairline-strong to-transparent"></div>` : ''}
                
                <div class="absolute left-0 top-1.5 w-4 h-4 rounded-full bg-surface-card flex items-center justify-center ${ringColor} z-10">
                    <div class="w-2 h-2 rounded-full ${dotColor}"></div>
                </div>
                
                <div class="opacity-[${opacity}%] transition-opacity">
                    ${isFirst ? `<div class="text-[10px] text-${color} font-label-caps mb-0.5 tracking-widest">ROOT EVENT</div>` : ''}
                    <div class="font-body-compact text-[13px] ${textColor} leading-relaxed">${escapeHtml(step)}</div>
                </div>
            </div>`;
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
    <div class="px-cell-padding-x border-b border-hairline bg-surface-card flex justify-between items-center shrink-0 w-full" style="height: 48px;">
        <div class="flex items-center gap-2 cursor-pointer hover:text-body-strong text-muted transition-colors" onclick="clearAnalysisNode()" title="Back to default view">
            <span class="material-symbols-outlined text-[18px]">arrow_back</span>
            <h2 class="font-headline-sm text-[11px] font-label-caps tracking-widest uppercase">ANALYSIS NODE</h2>
        </div>
        <div class="flex items-center gap-2">
            <button class="bg-surface-card hover:bg-surface-card-elevated text-muted border border-hairline-strong p-1.5 rounded transition-colors" title="Save Signal">
                <span class="material-symbols-outlined text-[16px]">bookmark</span>
            </button>
            <button class="bg-surface-card hover:bg-surface-card-elevated text-muted border border-hairline-strong p-1.5 rounded transition-colors" title="Set Alert">
                <span class="material-symbols-outlined text-[16px]">notifications</span>
            </button>
        </div>
    </div>
    
    <div class="flex-1 overflow-y-auto flex flex-col bg-canvas-deep relative">
        <div class="p-5 flex-1 flex flex-col">
            <!-- Direction Anchor -->
            <div class="flex justify-center mt-2 mb-4">
                <div class="bg-${color}/10 border border-${color}/20 text-${color} px-4 py-1.5 rounded-full font-label-caps text-[11px] tracking-widest uppercase shadow-[0_0_10px_rgba(var(--${color}-rgb,0,0,0),0.1)] flex items-center gap-2">
                    <div class="w-2 h-2 rounded-full bg-${color}"></div>
                    ${signal.direction}
                </div>
            </div>

            <!-- Inline Tickers -->
            ${renderInlineTickers(signal)}

            <!-- Catalyst News -->
            <div class="flex flex-col mb-6">
                <div class="text-[11px] text-muted font-label-caps tracking-widest mb-3 uppercase px-1">CATALYST NEWS</div>
                <div class="bg-surface-card border border-hairline rounded-lg p-4 hover:border-hairline-strong transition-colors group relative overflow-hidden">
                    <div class="flex items-center gap-2 mb-2">
                        ${faviconUrl ? `<img src="${faviconUrl}" class="w-4 h-4 rounded-sm bg-white/10 p-0.5" alt="source"/>` : `<span class="material-symbols-outlined text-[16px] text-muted">newspaper</span>`}
                        <span class="font-label-caps text-xs text-muted group-hover:text-primary transition-colors">${escapeHtml(signal.source_name || domain || 'News Source')}</span>
                        <span class="text-muted/30 text-xs">•</span>
                        <span class="font-data-tabular text-[10px] text-muted/70">${timeAgo(signal.created_at)}</span>
                    </div>
                    <div class="text-[15px] font-headline-sm text-body-strong leading-snug mb-3">${escapeHtml(signal.source_headline || 'Unknown News Source')}</div>
                    ${signal.source_url ? `<a href="${escapeHtml(signal.source_url)}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors w-fit"><span class="material-symbols-outlined text-[14px]">open_in_new</span> Read Article</a>` : ''}
                </div>
            </div>

            <!-- Metrics Grid -->
            <div class="grid grid-cols-2 gap-3 mb-6">
                <div class="bg-surface-card border border-hairline rounded-lg p-3">
                    <div class="text-[11px] text-muted font-label-caps tracking-widest mb-3 uppercase px-1 flex items-center justify-between">
                        CONFIDENCE
                        ${isOverconfident ? `<span class="material-symbols-outlined text-[14px] text-error" title="High confidence warning">warning</span>` : ''}
                    </div>
                    <div class="flex items-end gap-2 mb-3">
                        <div class="font-display-ticker text-2xl text-${color} leading-none">${confVal}%</div>
                    </div>
                    <div class="w-full bg-hairline h-1.5 rounded-full overflow-hidden">
                        <div class="bg-${color} h-full rounded-full" style="width: ${confVal}%"></div>
                    </div>
                </div>
                <div class="bg-surface-card border border-hairline rounded-lg p-3">
                    <div class="text-[11px] text-muted font-label-caps tracking-widest mb-3 uppercase px-1">IMPACT HORIZON</div>
                    <div class="font-headline-sm text-[15px] text-body-strong capitalize mt-1 leading-tight">${horizonText}</div>
                </div>
            </div>

            <!-- Causal Chain -->
            <div class="flex flex-col mb-6">
                <div class="text-[11px] text-muted font-label-caps tracking-widest mb-3 uppercase px-1">CAUSAL CHAIN</div>
                <div class="bg-surface-card border border-hairline rounded-lg p-4 pb-0">
                    ${catalystHtml}
                </div>
            </div>

            <!-- AI Reasoning -->
            <div class="flex flex-col mb-20">
                <div class="text-[11px] text-muted font-label-caps tracking-widest mb-3 uppercase px-1">AI REASONING</div>
                <div class="bg-surface-card border border-hairline rounded-lg p-4">
                    ${formatReasoning(signal.reasoning)}
                </div>
            </div>
        </div>

        <!-- Sticky Actions -->
        <div class="sticky bottom-0 left-0 right-0 p-4 bg-surface-card border-t border-hairline flex gap-2 z-20 shadow-[0_-4px_16px_rgba(0,0,0,0.4)]">
            <button class="flex-1 bg-primary text-on-primary font-label-caps text-[11px] py-3 rounded-md hover:bg-primary-active transition-colors flex items-center justify-center gap-1.5 shadow-lg shadow-primary/20 tracking-wider">
                <span class="material-symbols-outlined text-[16px]">bookmark_add</span> SAVE SIGNAL
            </button>
            <button onclick="openWatchlistForSignal('${escapeHtml(primaryTicker)}', '${escapeHtml(signal.direction || '')}', ${confVal})"
                class="flex-1 bg-surface-card-elevated border border-hairline-strong text-body-strong font-label-caps text-[11px] py-3 rounded-md hover:bg-hairline transition-colors flex items-center justify-center gap-1.5 tracking-wider">
                <span class="material-symbols-outlined text-[16px]">add_alert</span> SET ALERT
            </button>
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
        centerPanel.innerHTML = `
        <div class="px-cell-padding-x border-b border-hairline flex justify-between items-center bg-surface-card shrink-0 w-full z-10" style="height: 48px;">
            <h2 class="font-headline-sm text-[11px] font-label-caps uppercase tracking-widest text-muted">Catalyst Topology</h2>
        </div>
        <div class="flex-1 flex flex-col items-center justify-center text-muted p-6 text-center h-full w-full bg-canvas-deep">
            <div class="w-20 h-20 rounded-full bg-surface-card flex items-center justify-center mb-4 border border-hairline shadow-inner">
                <span class="material-symbols-outlined text-[32px] text-muted/30">account_tree</span>
            </div>
            <div class="text-[14px] font-medium text-body-strong mb-1">Awaiting Catalyst</div>
            <div class="text-[12px] max-w-[250px]">Select a signal to render the topology graph and causal network.</div>
        </div>`;
        return;
    }

    const topology = buildTopologyModel(signal);

    centerPanel.innerHTML = `<div class="px-cell-padding-x border-b border-hairline bg-surface-card flex justify-between items-center shrink-0 w-full z-10" style="height: 48px;">
            <h2 class="font-headline-sm text-[11px] font-label-caps uppercase tracking-widest text-muted">Catalyst Topology</h2>
            <button id="reheat-btn" class="text-muted p-1 rounded hover:bg-surface-card-elevated transition-colors flex items-center justify-center bg-transparent border-none" title="Reset Layout">
                <span class="material-symbols-outlined text-[18px]">refresh</span>
            </button>
        </div>
        <div id="d3-container" class="flex-1 w-full relative z-0 overflow-hidden outline-none bg-canvas" tabindex="0">
            <div id="d3-tooltip" class="absolute pointer-events-none opacity-0 transition-opacity z-50 text-sm bg-surface-card-elevated border border-hairline rounded-lg p-4 shadow-xl shadow-black/50" style="top: 16px; right: 16px; min-width: 260px; max-width: 320px; color: var(--on-surface);"></div>
            
            <div class="absolute top-4 left-4 z-40 group">
                <div class="bg-surface-card-elevated/80 backdrop-blur border border-hairline px-3 py-1.5 rounded-full text-muted text-xs flex items-center gap-2 cursor-help shadow-md">
                    <span class="material-symbols-outlined text-[14px]">info</span> Legend
                </div>
                <div class="absolute top-full left-0 mt-2 bg-surface-card border border-hairline p-4 rounded-lg shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all flex flex-col gap-3 min-w-[160px]">
                    <span class="flex items-center text-body-strong text-xs"><span style="color:#4a90e2;" class="mr-2 text-[14px]">●</span> Root Cause</span>
                    <span class="flex items-center text-body-strong text-xs"><span style="color:#ffcf56;" class="mr-2 text-[14px]">◆</span> Direct Effect</span>
                    <span class="flex items-center text-body-strong text-xs"><span style="color:#6cb4d9;" class="mr-2 text-[14px]">◆</span> Ripple Effect</span>
                    <span class="flex items-center text-body-strong text-xs"><span style="color:#a3ffb4;" class="mr-2 text-[14px]">●</span> Beneficiary</span>
                    <span class="flex items-center text-body-strong text-xs"><span style="color:#ff7a7a;" class="mr-2 text-[14px]">●</span> Headwind</span>
                    <span class="flex items-center text-body-strong text-xs"><span style="color:#ff6b6b;" class="mr-2 text-[16px]">◇</span> Risk</span>
                </div>
            </div>

            <div id="d3-caption" class="absolute bottom-6 left-1/2 -translate-x-1/2 bg-surface-card/60 backdrop-blur-xl text-body-strong px-6 py-3 rounded-full border border-hairline text-sm z-40 pointer-events-none shadow-lg shadow-black/50 leading-relaxed whitespace-nowrap">
                <strong class="font-bold text-primary tracking-widest text-[11px] mr-2">ROOT CAUSE:</strong> <span class="opacity-90">${escapeHtml(topology.root)}</span>
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
        const company = m ? String(m.company_name || sym).trim() : sym;
        const companyType = m ? String(m.business_type || m.industry || m.sector || m.quote_type || '').trim() : '';

        nodes.push({
            id, label: sym, ticker: sym, companyName: company, companyType: companyType, group: 'ticker', layer: 3,
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
    ['#4a90e2', '#a3ffb4', '#ff7a7a', '#8d99ae', '#ffcf56', '#6cb4d9', '#ff6b6b'].forEach(color => {
        defs.append("marker").attr("id", "arr-" + color.replace('#', ''))
            .attr("viewBox", "0 -4 8 8").attr("refX", 18).attr("refY", 0)
            .attr("markerWidth", 5).attr("markerHeight", 5).attr("orient", "auto")
            .append("path").attr("d", "M0,-4L8,0L0,4").attr("fill", color).attr("opacity", 0.5);
    });

    // Layer distance from center
    const layerRadius = { 0: 0, 1: Math.min(width, height) * 0.22, 2: Math.min(width, height) * 0.38, 3: Math.min(width, height) * 0.55, risk: Math.min(width, height) * 0.32 };

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
            if (d.dashed) return 120;
            return 100 + (d.value || 0) * 8;
        }).strength(0.6))
        .force("charge", d3.forceManyBody().strength(d => d.group === 'root' ? -1500 : d.group === 'risk' ? -250 : -600))
        .force("layer", forceLayer(0.18))
        .force("collide", d3.forceCollide().radius(d => d.radius + 20).strength(0.9));

    // Links
    const link = g.append("g").selectAll("line").data(links).enter().append("line")
        .attr("stroke", d => d.dashed ? '#ff6b6b44' : '#444')
        .attr("stroke-width", d => d.dashed ? 1 : Math.max(1.5, d.value * 0.6))
        .attr("stroke-dasharray", d => d.dashed ? "6,4" : "none")
        .attr("opacity", d => d.dashed ? 0.3 : 0.6)
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
        .attr("dx", d => d.group === 'ticker' ? 0 : d.radius + 5)
        .attr("dy", 4)
        .attr("text-anchor", d => d.group === 'ticker' ? "middle" : "start")
        .attr("fill", d => d.group === 'root' ? '#4a90e2' : d.group === 'risk' ? '#ff6b6b99' : d.group === 'ticker' ? '#222' : '#999')
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
        let groupLabel = { root: 'ROOT CAUSE', first_order: 'DIRECT EFFECT', second_order: 'RIPPLE EFFECT', ticker: 'TICKER', risk: 'THESIS RISK' }[d.group] || d.group;
        if (d.group === 'ticker' && d.companyType) {
            groupLabel = d.companyType.toUpperCase();
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
    }

    function hideTooltip() { tooltip.transition().duration(200).style("opacity", 0); }

    node.on("mouseover", (event, d) => { if (pinnedNode && pinnedNode.id !== d.id) return; focusNode(d); if (!pinnedNode) showTooltip(d); })
        .on("mouseout", () => { if (pinnedNode) return; resetFocus(); hideTooltip(); })
        .on("click", (event, d) => { event.stopPropagation(); pinnedNode = d; focusNode(d); showTooltip(d); });

    document.getElementById('reheat-btn').addEventListener('click', (e) => { e.stopPropagation(); simulation.alpha(1).restart(); });

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
    link.attr("x1", d => d.source.x).attr("y1", d => d.source.y).attr("x2", d => d.target.x).attr("y2", d => d.target.y);
    linkLabel.attr("x", d => (d.source.x + d.target.x) / 2).attr("y", d => (d.source.y + d.target.y) / 2);
    node.attr("transform", d => `translate(${d.x},${d.y})`);

    simulation.on("tick", () => {
        constrainNodes();
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
    document.querySelectorAll('#signal-feed > div').forEach(el => {
        el.classList.remove('bg-surface-card-elevated', 'border-l-primary');
        el.classList.add('bg-surface-card', 'border-l-transparent');
        
        // Remove individual direction colors if any were added by hover
        ['secondary', 'error', 'primary-fixed-dim'].forEach(c => el.classList.remove(`border-l-${c}`));
        
        if (el.dataset.id === id) {
            el.classList.remove('bg-surface-card', 'border-l-transparent');
            el.classList.add('bg-surface-card-elevated', 'border-l-primary');
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
        <div class="px-cell-padding-x border-b border-hairline bg-surface-card flex justify-between items-center shrink-0" style="height: 48px;">
            <h2 class="font-headline-sm text-[11px] font-label-caps uppercase tracking-widest text-muted">Analysis Node</h2>
        </div>
        <div class="flex-1 flex flex-col items-center justify-center text-muted p-6 text-center">
            <div class="w-16 h-16 rounded-full bg-surface-card-elevated flex items-center justify-center mb-4 border border-hairline">
                <span class="material-symbols-outlined text-[24px] text-muted/50">hub</span>
            </div>
            <div class="text-[13px] font-medium text-body-strong mb-1">No Signal Selected</div>
            <div class="text-[11px] max-w-[200px]">Select a signal from the feed to view its causal chain analysis.</div>
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
        const res = await fetch('/api/auth/me', { headers: authHeaders() });
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
        const res = await fetch('/api/auth/register', {
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
        const res = await fetch('/api/auth/login', {
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
        await fetch('/api/auth/logout', { method: 'POST', headers: authHeaders() });
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
        const res = await fetch('/api/notifications?limit=20', { headers: authHeaders() });
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
        await fetch(`/api/notifications/${notifId}/read`, { method: 'POST', headers: authHeaders() });
    } catch (e) {}
    // Load the signal
    document.getElementById('notification-popover').classList.add('hidden');
    loadSignalDetails(signalId);
    pollNotificationCount();
}

async function markAllNotificationsRead() {
    if (!currentUser) return;
    try {
        await fetch('/api/notifications/read-all', { method: 'POST', headers: authHeaders() });
        fetchNotifications();
        pollNotificationCount();
    } catch (e) {}
}

async function pollNotificationCount() {
    if (!currentUser) return;
    try {
        const res = await fetch('/api/notifications?count=true', { headers: authHeaders() });
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
        const res = await fetch('/api/watchlist', { headers: authHeaders() });
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
        const res = await fetch('/api/watchlist', {
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
        await fetch('/api/watchlist/' + id, { method: 'DELETE', headers: authHeaders() });
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
