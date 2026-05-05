const fs = require('fs');
let code = fs.readFileSync('website/app.js', 'utf-8');

const startIndex = code.indexOf('function getMutedColor');
const endIndex = code.indexOf('// Logic Functions');

if (startIndex === -1 || endIndex === -1) {
    console.error("Could not find boundaries");
    process.exit(1);
}

const newGraphCode = `function getStyleColor(tone) {
    const t = String(tone).toLowerCase();
    if (t.includes('bull') || t.includes('positive') || t.includes('beneficiary')) return '#a3ffb4'; // Vibrant light green
    if (t.includes('bear') || t.includes('negative') || t.includes('hit')) return '#ff7a7a'; // Vibrant light red
    return '#8d99ae'; // Cool grey
}

function renderCenterGraph(signal) {
    if (!signal) {
        centerPanel.innerHTML = \`<div class="flex-1 flex items-center justify-center text-on-surface-variant font-body-compact opacity-50">Select a signal to view catalyst chain graph</div>\`;
        return;
    }

    const topology = buildTopologyModel(signal);

    centerPanel.innerHTML = \`<div class="px-cell-padding-x py-cell-padding-y border-b border-outline-variant bg-surface-container-low flex justify-between items-center z-10 relative">
            <h2 class="font-headline-sm text-headline-sm text-on-surface">Catalyst Topology</h2>
            <button id="reheat-btn" class="text-on-surface-variant p-1 rounded hover:bg-surface-bright transition-colors flex items-center justify-center bg-transparent border-none" title="Reset Layout">
                <span class="material-symbols-outlined text-[18px]">refresh</span>
            </button>
        </div>
        <div id="d3-container" class="flex-1 w-full relative z-0 overflow-hidden outline-none bg-[#1e1e1e]" tabindex="0">
            <div id="d3-tooltip" class="absolute pointer-events-none opacity-0 transition-opacity z-50 text-sm" style="top: 16px; left: 16px; background: rgba(0,0,0,0.8); border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; padding: 12px; min-width: 250px; color: #fff;"></div>
        </div>\`;

    setTimeout(() => { initD3Graph(signal, topology); }, 0);
}

function initD3Graph(signal, topology) {
    const container = document.getElementById('d3-container');
    const width = container.clientWidth;
    const height = container.clientHeight;

    const nodes = [];
    const links = [];

    const rootId = 'root';
    nodes.push({ id: rootId, label: topology.root, group: 'root', radius: 18, color: '#4a90e2', detail: signal.market_consensus_divergence || 'Initial Catalyst', conviction: 'high' });

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

    node.on("mouseover", (event, d) => { if (pinnedNode && pinnedNode.id !== d.id) return; focusNode(d); }).on("mouseout", () => { if (pinnedNode) return; resetFocus(); }).on("click", (event, d) => { event.stopPropagation(); pinnedNode = d; focusNode(d); tooltip.transition().duration(200).style("opacity", 1); tooltip.html(\`\${d.ticker ? \`<div style="font-weight:bold; font-size:16px;">\${escapeHtml(d.ticker)}</div>\` : ''}<div style="margin-bottom:8px;">\${escapeHtml(d.label)}</div>\${d.directionInfo ? \`<span style="background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px; font-size: 10px; color:\${d.color}">\${d.directionInfo} IMPACT</span>\` : ''}<div style="margin-top:8px; font-size:12px; color:#ccc;">\${escapeHtml(d.detail)}</div>\`); });

    function hideTooltip() { tooltip.transition().duration(200).style("opacity", 0); }
    document.getElementById('reheat-btn').addEventListener('click', (e) => { e.stopPropagation(); simulation.alpha(1).restart(); });
    
    simulation.on("tick", () => { 
        link.attr("x1", d => d.source.x).attr("y1", d => d.source.y).attr("x2", d => d.target.x).attr("y2", d => d.target.y);
        node.attr("transform", d => \`translate(\${d.x},\${d.y})\`); 
    });
    
    function dragstarted(event, d) { if (!event.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; }
    function dragged(event, d) { d.fx = event.x; d.fy = event.y; }
    function dragended(event, d) { if (!event.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }
    const resizeObserver = new ResizeObserver(entries => { for (let entry of entries) { const newW = entry.contentRect.width; const newH = entry.contentRect.height; svg.attr("width", newW).attr("height", newH); simulation.force("center", d3.forceCenter(newW / 2, newH / 2)); simulation.alpha(0.3).restart(); } }); resizeObserver.observe(container);
}

function truncate(str, max) { if (!str) return ''; return str.length > max ? str.substring(0, max) + '...' : str; }
` + '\n\n';

const prePath = code.substring(0, startIndex);
const postPath = code.substring(endIndex);
fs.writeFileSync('website/app.js', prePath + newGraphCode + postPath);
console.log("Updated app.js successfully (minimalist style)!");
