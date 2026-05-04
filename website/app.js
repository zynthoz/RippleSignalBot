// MarketPulse AI - Web Dashboard App

let signals = [];
let activeFilter = 'ALL';
let latencyDisplay;
let signalFeedContainer;
let analysisNodeContainer;
let footerStats;
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
    if (!tickers || tickers.length === 0) return 'N/A';
    return escapeHtml(tickers.join(' · '));
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

    return `
    <div class="bg-surface border border-outline-variant border-l-4 border-l-${color} p-2 cursor-pointer hover:bg-surface-variant transition-colors group" onclick="loadSignalDetails('${signal.id}')" data-id="${signal.id}">
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

function renderAnalysisNode(signal) {
    const isBull = signal.direction === 'BULLISH';
    const isBear = signal.direction === 'BEARISH';
    const color = isBull ? 'secondary' : isBear ? 'error' : 'primary-fixed-dim';
    const icon = isBull ? 'trending_up' : isBear ? 'trending_down' : 'horizontal_rule';
    
    // Process JSONB arrays safely
    const catalystChain = typeof signal.catalyst_chain === 'string' ? JSON.parse(signal.catalyst_chain || '[]') : (signal.catalyst_chain || []);
    
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
        <div class="flex flex-col gap-2">
            <div class="font-label-caps text-label-caps text-on-surface-variant">AI REASONING</div>
            <p class="font-body-compact text-body-compact text-on-surface text-xs leading-relaxed text-justify opacity-80">
                ${escapeHtml(signal.reasoning || 'No reasoning provided.')}
            </p>
        </div>
        
        <!-- Investment Thesis -->
        ${signal.investment_thesis ? `
        <div class="flex flex-col gap-2">
            <div class="font-label-caps text-label-caps text-on-surface-variant">INVESTMENT THESIS</div>
            <p class="font-body-compact text-body-compact text-primary text-xs leading-relaxed text-justify">
                ${escapeHtml(signal.investment_thesis)}
            </p>
        </div>` : ''}

        <button onclick="executeHedge(this)" class="w-full mt-auto bg-primary/10 border border-primary text-primary font-label-caps text-label-caps py-3 rounded-sm hover:bg-primary/20 transition-colors">
            EXECUTE HEDGE SCRIPT
        </button>
    </div>
    `;
}

function renderCenterGraph(signal) {
    if (!signal) {
        centerPanel.innerHTML = `
            <div class="flex-1 flex items-center justify-center text-on-surface-variant font-body-compact opacity-50">
                Select a signal to view catalyst chain graph
            </div>
        `;
        return;
    }
    
    const isBull = signal.direction === 'BULLISH';
    const color = isBull ? 'secondary' : signal.direction === 'BEARISH' ? 'error' : 'primary-fixed-dim';
    
    // In a real app, this would be a D3 or Canvas node graph. We'll simulate it with styled HTML.
    centerPanel.innerHTML = `
        <div class="px-cell-padding-x py-cell-padding-y border-b border-outline-variant bg-surface-container-low flex justify-between items-center">
            <h2 class="font-headline-sm text-headline-sm text-on-surface">Catalyst Topology</h2>
        </div>
        <div class="flex-1 overflow-hidden p-8 flex items-center justify-center bg-surface-dim relative">
            <div class="absolute inset-0 opacity-10 pointer-events-none" style="background-image: radial-gradient(circle at center, #ffffff 1px, transparent 1px); background-size: 24px 24px;"></div>
            
            <div class="flex flex-col items-center gap-6 relative z-10 w-full max-w-md">
                <div class="w-full bg-surface-container border border-outline-variant p-4 rounded-sm shadow-lg text-center relative">
                    <div class="font-label-caps text-label-caps text-on-surface-variant mb-1">ROOT CAUSE</div>
                    <div class="text-on-surface text-sm">${escapeHtml(signal.root_cause || 'News Event Detected')}</div>
                    <div class="absolute -bottom-6 left-1/2 w-0.5 h-6 bg-outline-variant"></div>
                    <div class="absolute -bottom-6 left-1/2 w-3 h-3 rounded-full bg-outline-variant transform -translate-x-1.5 translate-y-4"></div>
                </div>
                
                <div class="w-full bg-surface border border-${color} border-l-4 p-4 rounded-sm shadow-lg shadow-${color}/10 mt-4 text-center">
                    <div class="font-label-caps text-label-caps text-${color} mb-1">MARKET IMPACT</div>
                    <div class="font-display-ticker text-${color} text-xl">${formatTicker(signal.tickers)}</div>
                    <div class="text-on-surface-variant text-xs mt-2">${escapeHtml(signal.market_consensus_divergence || '')}</div>
                </div>
            </div>
        </div>
    `;
}

// Logic Functions
async function fetchSignals() {
    const startTime = performance.now();
    try {
        const res = await fetch('/api/signals?limit=50');
        if (res.ok) {
            signals = await res.json();
            const latency = Math.round(performance.now() - startTime);
            latencyDisplay.textContent = latency + 'ms';
            renderSignalFeed();
            updateFilterCounts();
        }
    } catch (e) {
        console.error("Failed to fetch signals", e);
        signalFeedContainer.innerHTML = `<div class="text-error p-4 text-center text-sm">Pipeline Offline</div>`;
    }
}

async function fetchStats() {
    try {
        const res = await fetch('/api/stats');
        if (res.ok) {
            const stats = await res.json();
            footerStats.textContent = `SYS_HEALTH: OPTIMAL | SIGNALS_TODAY: ${stats.signals_today || 0} | USERS: ${stats.subscribed_users || 0} | TOTAL_SIGNALS: ${stats.total_signals || 0}`;
        }
    } catch(e) {
        console.error("Failed to fetch stats", e);
    }
}

function renderSignalFeed() {
    let filtered = signals;
    if (activeFilter !== 'ALL') {
        filtered = signals.filter(s => s.direction === activeFilter);
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
    // Highlight active card
    document.querySelectorAll('#signal-feed > div').forEach(el => {
        el.classList.remove('bg-surface-variant');
        if (el.dataset.id === id) el.classList.add('bg-surface-variant');
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
    renderCenterGraph(null);
    document.querySelectorAll('#signal-feed > div').forEach(el => el.classList.remove('bg-surface-variant'));
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
                
                // Flash green dot indicator
                newSignalIndicator.classList.add('animate-pulse');
                setTimeout(() => newSignalIndicator.classList.remove('animate-pulse'), 3000);
                
                renderSignalFeed();
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
    latencyDisplay = document.getElementById('latency-display');
    signalFeedContainer = document.getElementById('signal-feed');
    analysisNodeContainer = document.getElementById('analysis-node');
    footerStats = document.getElementById('footer-stats');
    centerPanel = document.getElementById('center-panel');
    newSignalIndicator = document.getElementById('new-signal-indicator');

    document.getElementById('filter-ALL').addEventListener('click', () => setFilter('ALL'));
    document.getElementById('filter-BULL').addEventListener('click', () => setFilter('BULLISH'));
    document.getElementById('filter-BEAR').addEventListener('click', () => setFilter('BEARISH'));

    // Initial load
    clearAnalysisNode();
    fetchSignals();
    fetchStats();
    
    // Polling fallback / periodic updates
    setInterval(fetchStats, 30000); // Stats every 30s
    
    // Start SSE stream
    setupSSE();
});
