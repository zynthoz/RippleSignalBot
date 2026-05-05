const fs = require('fs');
let code = fs.readFileSync('website/app.js', 'utf-8');

const startIndex = code.indexOf('function renderCenterGraph');
const endIndex = code.indexOf('// Logic Functions');

const newGraphCode = `function getMutedColor(tone) {
    const t = String(tone).toLowerCase();
    if (t.includes('bull') || t.includes('positive') || t.includes('beneficiary')) return '#81b29a'; // Sage green
    if (t.includes('bear') || t.includes('negative') || t.includes('hit')) return '#e07a5f'; // Muted coral
    return '#8d99ae'; // Cool grey-blue
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
        <div id="d3-container" class="flex-1 w-full relative z-0 overflow-hidden outline-none bg-[#0a0e1a]" tabindex="0">
            <div class="absolute inset-0 pointer-events-none" style="background: radial-gradient(circle at center, rgba(255,255,255,0.05) 0%, transparent 70%); mix-blend-mode: screen;"></div>
            <div class="absolute inset-0 pointer-events-none opacity-5" style="background-image: url('data:image/svg+xml,%3Csvg viewBox=%220 0 200 200%22 xmlns=%22http://www.w3.org/2000/svg%22%3E%3Cfilter id=%22noiseFilter%22%3E%3CfeTurbulence type=%22fractalNoise%22 baseFrequency=%220.65%22 numOctaves=%223%22 stitchTiles=%22stitch%22/%3E%3C/filter%3E%3Crect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23noiseFilter)%22/%3E%3C/svg%3E');"></div>
            
            <div id="d3-tooltip" class="absolute pointer-events-none opacity-0 transition-opacity z-50 text-sm" style="top: 16px; left: 16px; backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 16px; min-width: 250px; box-shadow: 0 8px 32px rgba(0,0,0,0.3);"></div>
            <div id="edge-tooltip" class="absolute pointer-events-none opacity-0 transition-opacity bg-black/80 text-white px-2 py-1 rounded text-xs font-mono tracking-wider border border-white/10 z-40 transform -translate-x-1/2 -translate-y-1/2"></div>
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
    nodes.push({ id: rootId, label: topology.root, group: 'root', radius: 36, color: '#adc6ff', detail: signal.market_consensus_divergence || 'Initial Catalyst', conviction: 'high' });

    topology.branches.forEach((branch) => {
        if (branch.nodes) {
            branch.nodes.forEach((leaf) => {
                const leafId = 'leaf_' + Math.random().toString(36).substr(2, 9);
                const leafColor = getMutedColor(leaf.direction || branch.tone);
                const impact = parseFloat(leaf.impact_score) || 5;

                nodes.push({
                    id: leafId, label: leaf.company_name || leaf.ticker || leaf.focus || 'Entity', ticker: leaf.ticker,
                    group: 'leaf', radius: 20 + (impact / 2), color: leafColor, detail: leaf.why_it_matters || leaf.focus || 'Exposed entity',
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
    ['#adc6ff', '#81b29a', '#e07a5f', '#8d99ae'].forEach(color => {
        const c = color.replace('#', '');
        const grad = defs.append("radialGradient").attr("id", "grad-" + c).attr("cx", "30%").attr("cy", "30%").attr("r", "70%");
        grad.append("stop").attr("offset", "0%").attr("stop-color", d3.color(color).brighter(1));
        grad.append("stop").attr("offset", "100%").attr("stop-color", d3.color(color).darker(1.5));
        
        const filter = defs.append("filter").attr("id", "glow-" + c).attr("x", "-50%").attr("y", "-50%").attr("width", "200%").attr("height", "200%");
        filter.append("feGaussianBlur").attr("stdDeviation", "8").attr("result", "blur");
        filter.append("feFlood").attr("flood-color", color).attr("flood-opacity", "0.5").attr("result", "glowColor");
        filter.append("feComposite").attr("in", "glowColor").attr("in2", "blur").attr("operator", "in").attr("result", "glow");
        const merge = filter.append("feMerge");
        merge.append("feMergeNode").attr("in", "glow");
        merge.append("feMergeNode").attr("in", "SourceGraphic");
        
        defs.append("marker").attr("id", "arrow-" + c).attr("viewBox", "0 -5 10 10").attr("refX", 32).attr("refY", 0).attr("markerWidth", 6).attr("markerHeight", 6).attr("orient", "auto").append("path").attr("d", "M0,-5L10,0L0,5").attr("fill", color).attr("opacity", 0.6);
    });

    const g = svg.append("g");

    const simulation = d3.forceSimulation(nodes).force("link", d3.forceLink(links).id(d => d.id).distance(180)).force("charge", d3.forceManyBody().strength(-1200)).force("center", d3.forceCenter(width / 2, height / 2)).force("collide", d3.forceCollide().radius(d => d.radius + 40));

    setInterval(() => { if (!pinnedNode) simulation.alpha(0.05).restart(); }, 2000);

    const link = g.append("g").attr("class", "links").selectAll("path").data(links).enter().append("path").attr("fill", "none").attr("stroke", d => d.color).attr("stroke-width", d => Math.max(1, d.value)).attr("stroke-dasharray", d => d.value < 4 ? "4,4" : "none").attr("opacity", 0).attr("marker-end", d => "url(#arrow-" + d.color.replace('#', '') + ")");
    link.transition().duration(1000).delay((d,i) => i*100).attr("opacity", 0.6);

    const linkHover = g.append("g").selectAll("path").data(links).enter().append("path").attr("fill", "none").attr("stroke", "transparent").attr("stroke-width", 20).on("mouseover", (event, d) => { if(pinnedNode) return; const edgeTooltip = d3.select("#edge-tooltip"); edgeTooltip.transition().duration(200).style("opacity", 1); edgeTooltip.text(d.reason).style("left", event.pageX + "px").style("top", (event.pageY - 20) + "px"); }).on("mouseout", () => { d3.select("#edge-tooltip").transition().duration(200).style("opacity", 0); });

    const node = g.append("g").attr("class", "nodes").selectAll("g").data(nodes).enter().append("g").style("opacity", 0).call(d3.drag().on("start", dragstarted).on("drag", dragged).on("end", dragended));
    node.transition().duration(800).delay((d,i) => i*100).style("opacity", 1);

    const circles = node.append("circle").attr("r", 0).attr("fill", d => "url(#grad-" + d.color.replace('#', '') + ")").attr("stroke", d => d.color).attr("stroke-width", d => d.group==='root' ? 3 : 1).style("filter", d => "url(#glow-" + d.color.replace('#', '') + ")");
    circles.transition().duration(800).delay((d,i) => i*100).attr("r", d => d.radius);

    const labelGroups = node.append("g").attr("transform", d => \`translate(0, \${d.radius + 15})\`);
    labelGroups.append("rect").attr("fill", "rgba(0,0,0,0.4)").attr("rx", 10).attr("ry", 10).attr("height", 20).style("pointer-events", "none");
    const texts = labelGroups.append("text").text(d => truncate(d.ticker || d.label, 25)).attr("text-anchor", "middle").attr("y", 14).attr("fill", "#c2c6d6").attr("font-size", d => d.group === 'root' ? "12px" : "10px").attr("font-family", "'IBM Plex Mono', monospace").attr("letter-spacing", "0.05em").style("pointer-events", "none");
    setTimeout(() => { labelGroups.each(function() { const t = d3.select(this).select("text").node(); if(t){try{const bbox = t.getBBox(); d3.select(this).select("rect").attr("width", bbox.width + 16).attr("x", -(bbox.width + 16)/2);}catch(e){}}}); }, 100);

    const tooltip = d3.select("#d3-tooltip");
    let pinnedNode = null;

    function focusNode(d) {
        const connectedNodes = new Set(); connectedNodes.add(d.id); links.forEach(l => { if (l.source.id === d.id) connectedNodes.add(l.target.id); if (l.target.id === d.id) connectedNodes.add(l.source.id); });
        node.transition().duration(300).style("opacity", o => connectedNodes.has(o.id) ? 1 : 0.2);
        link.transition().duration(300).style("opacity", o => (o.source.id === d.id || o.target.id === d.id) ? 0.8 : 0.1).attr("stroke", o => (o.source.id === d.id || o.target.id === d.id) ? o.color : "#424754");
    }
    function resetFocus() { node.transition().duration(300).style("opacity", 1); link.transition().duration(300).style("opacity", 0.6).attr("stroke", d => d.color); }

    node.on("mouseover", (event, d) => { if (pinnedNode && pinnedNode.id !== d.id) return; focusNode(d); }).on("mouseout", () => { if (pinnedNode) return; resetFocus(); }).on("click", (event, d) => { event.stopPropagation(); pinnedNode = d; focusNode(d); tooltip.transition().duration(200).style("opacity", 1); tooltip.html(\`\${d.ticker ? \`<div class="font-display-ticker text-lg text-white mb-1">\${escapeHtml(d.ticker)}</div>\` : ''}<div class="font-headline-sm text-on-surface mb-3">\${escapeHtml(d.label)}</div>\${d.directionInfo ? \`<div class="font-label-caps text-label-caps mb-2 inline-block px-2 py-1 rounded" style="background: \${d.color}20; color: \${d.color}">\${d.directionInfo} IMPACT • \${String(d.conviction).toUpperCase()} CONVICTION</div>\` : ''}<div class="text-sm text-on-surface-variant leading-relaxed">\${escapeHtml(d.detail)}</div>\`); });

    function hideTooltip() { tooltip.transition().duration(200).style("opacity", 0); }
    document.getElementById('reheat-btn').addEventListener('click', (e) => { e.stopPropagation(); simulation.alpha(1).restart(); });
    simulation.on("tick", () => { const updatePath = d => { const dx = d.target.x - d.source.x, dy = d.target.y - d.source.y, dr = Math.sqrt(dx * dx + dy * dy) * 1.5; return \`M\${d.source.x},\${d.source.y}A\${dr},\${dr} 0 0,1 \${d.target.x},\${d.target.y}\`; }; link.attr("d", updatePath); linkHover.attr("d", updatePath); node.attr("transform", d => \`translate(\${d.x},\${d.y})\`); });
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
console.log("Updated app.js successfully!");
