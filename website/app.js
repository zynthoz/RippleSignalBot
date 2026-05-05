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

    return {
        id: String(node.id || label.toLowerCase().replace(/[^a-z0-9]+/g, '-')),
        label,
        ticker: String(node.ticker || node.symbol || '').trim().toUpperCase(),
        kind: String(node.kind || node.type || (node.ticker || node.symbol ? 'ticker' : 'theme')),
        direction: String(node.direction || fallbackTone || 'neutral').toLowerCase(),
        conviction: String(node.conviction || node.weight || 'medium').toLowerCase(),
        relationship: String(node.relationship || node.link || fallbackRelationship || '').trim(),
        why_it_matters: String(node.why_it_matters || node.reason || node.impact || '').trim(),
        children: Array.isArray(node.children)
            ? node.children.map((child) => normalizeGraphNode(child, `${label} follow-through`, fallbackTone)).filter(Boolean)
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
        const nodes = normalizeTextList(items).map((item) => normalizeGraphNode(item, label, tone)).filter(Boolean);
        if (nodes.length > 0) {
            branches.push({
                label,
                tone,
                nodes,
            });
        }
    };

    pushBranch('Primary tickers', signal.tickers || [], signal.direction === 'BULLISH' ? 'positive' : signal.direction === 'BEARISH' ? 'negative' : 'neutral');
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
    const graph = parseMaybeJson(signal.relationship_graph, null);
    if (graph && typeof graph === 'object' && Array.isArray(graph.branches)) {
        return {
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
    }

    return buildFallbackGraph(signal);
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
            <div id="d3-tooltip" class="absolute pointer-events-none opacity-0 transition-opacity z-50 text-sm" style="top: 16px; left: 16px; background: rgba(0,0,0,0.8); border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; padding: 12px; min-width: 250px; color: #fff;"></div>
            <div id="d3-caption" class="absolute bottom-4 left-4 right-4 bg-black/60 text-white/90 p-4 rounded-lg border border-white/10 text-sm font-sans backdrop-blur-sm z-40 pointer-events-none">
                <strong style="color: #4a90e2;">ROOT CAUSE:</strong> ${escapeHtml(topology.root)}
            </div>
        </div>`;

    setTimeout(() => { initD3Graph(signal, topology); }, 0);
}

function initD3Graph(signal, topology) {
    const container = document.getElementById('d3-container');
    const width = container.clientWidth;
    const height = container.clientHeight;

    const nodes = [];
    const links = [];

    const rootId = 'root';
    nodes.push({ id: rootId, label: 'ROOT CAUSE', group: 'root', radius: 18, color: '#4a90e2', detail: signal.market_consensus_divergence || 'Initial Catalyst', conviction: 'high' });

    topology.branches.forEach((branch) => {
        if (branch.nodes) {
            branch.nodes.forEach((leaf) => {
                const leafId = 'leaf_' + Math.random().toString(36).substr(2, 9);
                const leafColor = getStyleColor(leaf.direction || branch.tone);
                const impact = parseFloat(leaf.impact_score) || 5;

                nodes.push({
                    id: leafId, label: leaf.company_name || leaf.ticker || leaf.focus || 'Entity', ticker: leaf.ticker,
                    group: 'leaf', radius: 8 + (impact), color: leafColor, detail: leaf.why_it_matters || leaf.focus || 'Exposed entity',
                    directionInfo: (leaf.direction || branch.tone).toUpperCase(), conviction: leaf.conviction || 'medium'
                });

                links.push({ source: rootId, target: leafId, value: impact, color: leafColor, reason: branch.label || 'Impact Transmission' });
            });
        }
    });

    d3.select("#d3-container").select("svg").remove();

    const zoom = d3.zoom().scaleExtent([0.1, 4]).on("zoom", (event) => g.attr("transform", event.transform));

    const svg = d3.select("#d3-container").append("svg").attr("width", width).attr("height", height).call(zoom).on("dblclick.zoom", () => {
        svg.transition().duration(750).call(zoom.transform, d3.zoomIdentity.translate(width/2, height/2).scale(1).translate(-width/2, -height/2));
    });

    svg.on("click", () => { pinnedNode = null; hideTooltip(); resetFocus(); });

    const defs = svg.append("defs");
    ['#4a90e2', '#a3ffb4', '#ff7a7a', '#8d99ae'].forEach(color => {
         defs.append("marker").attr("id", "arrow-" + color.replace('#', '')).attr("viewBox", "0 -5 10 10").attr("refX", 20).attr("refY", 0).attr("markerWidth", 5).attr("markerHeight", 5).attr("orient", "auto").append("path").attr("d", "M0,-5L10,0L0,5").attr("fill", "#666").attr("opacity", 0.8);
    });

    const g = svg.append("g");

    const simulation = d3.forceSimulation(nodes).force("link", d3.forceLink(links).id(d => d.id).distance(150)).force("charge", d3.forceManyBody().strength(-800)).force("center", d3.forceCenter(width / 2, height / 2)).force("collide", d3.forceCollide().radius(d => d.radius + 30));

    const link = g.append("g").attr("class", "links").selectAll("line").data(links).enter().append("line").attr("stroke", "#444").attr("stroke-width", 1.5).attr("opacity", 0.8).attr("marker-end", d => "url(#arrow-" + d.color.replace('#', '') + ")");

    const node = g.append("g").attr("class", "nodes").selectAll("g").data(nodes).enter().append("g").call(d3.drag().on("start", dragstarted).on("drag", dragged).on("end", dragended));

    const circles = node.append("circle").attr("r", d => d.radius).attr("fill", d => d.color);

    const texts = node.append("text").text(d => d.ticker || d.label).attr("dx", d => d.radius + 6).attr("dy", 4).attr("fill", "#bbb").attr("font-size", "11px").attr("font-family", "sans-serif").style("pointer-events", "none");

    const tooltip = d3.select("#d3-tooltip");
    let pinnedNode = null;

    function focusNode(d) {
        const connectedNodes = new Set(); connectedNodes.add(d.id); links.forEach(l => { if (l.source.id === d.id) connectedNodes.add(l.target.id); if (l.target.id === d.id) connectedNodes.add(l.source.id); });
        node.transition().duration(200).style("opacity", o => connectedNodes.has(o.id) ? 1 : 0.2);
        link.transition().duration(200).style("opacity", o => (o.source.id === d.id || o.target.id === d.id) ? 0.8 : 0.1).attr("stroke", o => (o.source.id === d.id || o.target.id === d.id) ? "#888" : "#222");
    }
    function resetFocus() { node.transition().duration(200).style("opacity", 1); link.transition().duration(200).style("opacity", 0.8).attr("stroke", "#444"); }

    node.on("mouseover", (event, d) => { if (pinnedNode && pinnedNode.id !== d.id) return; focusNode(d); }).on("mouseout", () => { if (pinnedNode) return; resetFocus(); }).on("click", (event, d) => { event.stopPropagation(); pinnedNode = d; focusNode(d); tooltip.transition().duration(200).style("opacity", 1); tooltip.html(`${d.ticker ? `<div style="font-weight:bold; font-size:16px;">${escapeHtml(d.ticker)}</div>` : ''}<div style="margin-bottom:8px;">${escapeHtml(d.label)}</div>${d.directionInfo ? `<span style="background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px; font-size: 10px; color:${d.color}">${d.directionInfo} IMPACT</span>` : ''}<div style="margin-top:8px; font-size:12px; color:#ccc;">${escapeHtml(d.detail)}</div>`); });

    function hideTooltip() { tooltip.transition().duration(200).style("opacity", 0); }
    document.getElementById('reheat-btn').addEventListener('click', (e) => { e.stopPropagation(); simulation.alpha(1).restart(); });
    
    simulation.on("tick", () => { 
        link.attr("x1", d => d.source.x).attr("y1", d => d.source.y).attr("x2", d => d.target.x).attr("y2", d => d.target.y);
        node.attr("transform", d => `translate(${d.x},${d.y})`); 
    });
    
    function dragstarted(event, d) { if (!event.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; }
    function dragged(event, d) { d.fx = event.x; d.fy = event.y; }
    function dragended(event, d) { if (!event.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }
    const resizeObserver = new ResizeObserver(entries => { for (let entry of entries) { const newW = entry.contentRect.width; const newH = entry.contentRect.height; svg.attr("width", newW).attr("height", newH); simulation.force("center", d3.forceCenter(newW / 2, newH / 2)); simulation.alpha(0.3).restart(); } }); resizeObserver.observe(container);
}

function truncate(str, max) { if (!str) return ''; return str.length > max ? str.substring(0, max) + '...' : str; }


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
