const fs = require('fs');
let code = fs.readFileSync('website/app.js', 'utf-8');

const updatedFunc = `function renderAnalysisNode(signal) {
    const isBull = signal.direction === 'BULLISH';
    const isBear = signal.direction === 'BEARISH';
    const color = isBull ? 'secondary' : isBear ? 'error' : 'primary-fixed-dim';
    const icon = isBull ? 'trending_up' : isBear ? 'trending_down' : 'horizontal_rule';
    
    // Process JSONB arrays safely
    const catalystChain = normalizeTextList(signal.catalyst_chain);
    
    let catalystHtml = '';
    if (catalystChain.length > 0) {
        catalystHtml = catalystChain.map((step, idx) => \`
            <div class="flex items-center gap-2">
                <span class="material-symbols-outlined text-[16px] text-outline">article</span>
                <span class="font-body-compact text-body-compact text-on-surface text-xs">\${escapeHtml(step)}</span>
            </div>
            \${idx < catalystChain.length - 1 ? \`
            <div class="flex ml-2 border-l border-outline-variant pl-4 py-1">
                <span class="material-symbols-outlined text-[16px] text-outline self-center">arrow_downward</span>
            </div>\` : ''}
        \`).join('');
    } else {
        catalystHtml = \`<span class="text-on-surface-variant text-xs italic">No causal chain data available.</span>\`;
    }

    return \`
    <div class="px-cell-padding-x py-cell-padding-y border-b border-outline-variant bg-surface-container-low flex justify-between items-center">
        <h2 class="font-headline-sm text-headline-sm text-on-surface">Analysis Node</h2>
        <span class="material-symbols-outlined text-outline cursor-pointer hover:text-on-surface" onclick="clearAnalysisNode()">close</span>
    </div>
    <div class="flex-1 overflow-y-auto p-4 flex flex-col gap-6 bg-surface-dim">
        <!-- Header Status -->
        <div class="flex flex-col items-center text-center">
            <div class="w-16 h-16 rounded-full border-2 border-\${color} flex items-center justify-center shadow-[0_0_16px_rgba(var(--\${color}-rgb, 0,0,0),0.2)] mb-3">
                <span class="material-symbols-outlined text-[32px] text-\${color}">\${icon}</span>
            </div>
            <div class="font-display-ticker text-display-ticker text-on-surface">\${formatTicker(signal.tickers)}</div>
            <div class="font-label-caps text-label-caps text-\${color} tracking-widest mt-1">\${signal.direction}</div>
        </div>

        <!-- News Details -->
        <div class="flex flex-col gap-2">
            <div class="font-label-caps text-label-caps text-on-surface-variant">CATALYST NEWS</div>
            <div class="bg-surface-container p-3 border border-outline-variant rounded-sm flex flex-col gap-2">
                \${signal.source_name ? \`<div class="text-xs font-label-caps text-primary">\${escapeHtml(signal.source_name)}</div>\` : ''}
                <div class="text-sm font-headline-sm text-on-surface">\${escapeHtml(signal.source_headline || 'Unknown News Source')}</div>
                \${signal.source_url ? \`<a href="\${escapeHtml(signal.source_url)}" target="_blank" rel="noopener noreferrer" class="text-xs text-primary hover:underline flex items-center gap-1 mt-1"><span class="material-symbols-outlined text-[14px]">open_in_new</span> View Source Article</a>\` : ''}
            </div>
        </div>

        <!-- Metrics Grid -->
        <div class="grid grid-cols-2 gap-panel-gap">
            <div class="bg-surface-container-low p-2 border border-outline-variant rounded-sm">
                <div class="font-label-caps text-label-caps text-on-surface-variant mb-1">CONFIDENCE</div>
                <div class="font-data-tabular text-data-tabular text-\${color} text-lg">\${signal.confidence ?? 'N/A'}%</div>
            </div>
            <div class="bg-surface-container-low p-2 border border-outline-variant rounded-sm">
                <div class="font-label-caps text-label-caps text-on-surface-variant mb-1">IMPACT HORIZON</div>
                <div class="font-data-tabular text-data-tabular text-on-surface text-lg">\${escapeHtml(signal.time_horizon || 'Unknown')}</div>
            </div>
        </div>

        <!-- Causal Chain -->
        <div class="flex flex-col gap-2">
            <div class="font-label-caps text-label-caps text-on-surface-variant">CAUSAL CHAIN</div>
            <div class="bg-surface-container p-3 border border-outline-variant rounded-sm flex flex-col">
                \${catalystHtml}
            </div>
        </div>

        <!-- AI Reasoning -->
        <div class="flex flex-col gap-2 mb-4">
            <div class="font-label-caps text-label-caps text-on-surface-variant">AI REASONING</div>
            <p class="font-body-compact text-body-compact text-on-surface text-xs leading-relaxed text-justify opacity-80">
                \${escapeHtml(signal.reasoning || 'No reasoning provided.')}
            </p>
        </div>
    </div>
    \`;
}`;

const startIndex = code.indexOf('function renderAnalysisNode(signal)');
const endIndex = code.indexOf('function getStyleColor(tone)');

if (startIndex === -1 || endIndex === -1) {
    console.error('Failed to find bounds.');
    process.exit(1);
}

const pre = code.substring(0, startIndex);
const post = code.substring(endIndex);

fs.writeFileSync('website/app.js', pre + updatedFunc + '\n\n' + post);
console.log('Successfully updated app.js Analysis Node template.');
