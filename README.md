# Argus AI
# Check it out at https://try-argus-ai.vercel.app/dashboard

Argus AI is a market-catalyst intelligence system that turns noisy finance headlines into structured, tradable narratives.

It watches the news stream, extracts the companies and themes that matter, scores the signal, and presents the result in a polished analyst dashboard and Telegram workflow. The goal is not to flood you with headlines. The goal is to explain why a story matters, which names it touches, and how the catalyst can propagate through the market.

## What It Does

Argus AI is built around a simple pipeline:

1. **Ingest** market-moving news from NewsAPI.
2. **Filter** for stories that are likely to matter to public markets.
3. **Analyze** the article with Gemini to extract direction, confidence, root cause, and follow-on effects.
4. **Deduplicate** and queue events through Redis so the same story is not processed twice.
5. **Persist** curated signals in PostgreSQL for history, review, and performance tracking.
6. **Visualize** the causal chain in a dark, radar-style dashboard with signal feed, topology graph, and analysis panel.
7. **Deliver** alerts and commands through Telegram for fast operator access.

## Why It Exists

Most market news apps stop at the headline. Argus AI goes one step further and answers the questions traders actually ask:

- What is the root cause?
- Which tickers are directly affected?
- Is the catalyst bullish, bearish, or mixed?
- How confident is the system?
- What is the second-order impact?

This architecture provides a professional decisioning layer alongside a robust user-facing interpretation layer.

## Product Surfaces

The demo is centered on a few clear experiences:

- **Signal Feed** - a live list of market-relevant catalysts with direction and confidence.
- **Catalyst Topology** - a graph that maps root cause to affected names, themes, and downstream effects.
- **Analysis Node** - a focused summary card that explains the selected signal in plain language.
- **Telegram Commands** - subscription, linking, broadcast control, and latest-signal lookup.
- **Performance Tracking** - a database-backed foundation for evaluating whether a signal was directionally correct over time.

## How It Works

The system is split into a few cooperating services:

- **Node.js runtime** handles the API surface, Telegram webhook, and news polling.
- **Python worker** performs the deeper signal analysis and enrichment pass.
- **Redis** acts as the short-lived queue and dedupe layer.
- **PostgreSQL** stores users, signals, and performance records.
- **Google Gemini** provides the language-model reasoning used to turn articles into structured trading narratives.
- **D3.js** powers the graph-style visualization in the dashboard.

## Technology Stack

| Layer | Technologies |
|---|---|
| Frontend | Vanilla JavaScript, HTML, Tailwind CSS, D3.js |
| Backend | Node.js, Telegraf, native HTTP server |
| Analysis | Python, Google Gemini, heuristic enrichment |
| Data | PostgreSQL, Redis |
| Ingestion | NewsAPI |
| Delivery | Telegram bots, webhook flow |
| Deployment | Docker Compose, Vercel config, ngrok for local webhook tunneling |

## Architecture Snapshot

- `src/newsApi.js` pulls finance headlines and uses Redis-backed pending/seen keys to keep the feed clean.
- `python/worker.py` enriches signals with tickers, causal chains, market impact, and confidence calibration.
- `src/index.js` exposes health, API, and Telegram routes while keeping the app online as a small control plane.
- `website/app.js` renders the dashboard, signal feed, and interactive topology view.

## What Makes It Stand Out

- Converts headlines into a causal story instead of a generic sentiment score.
- Shows a visual market graph rather than a plain table.
- Combines AI analysis with real delivery channels like Telegram.
- Provides a professional analyst workstation experience for deep market monitoring.

## Product Features & Visualization

### Integrated Analyst Workstation
![Argus AI dashboard overview](img3.png)
The main workspace integrates a ranked signal feed with an interactive topology map and detailed analysis panel. It allows operators to monitor multiple catalysts simultaneously while providing immediate access to the underlying investment thesis, confidence metrics, and contagion risks.

### Causal Mapping & Linkage
![Argus AI topology deep-dive](img2.png)
The topology view transforms headlines into a branching market map. It identifies the root cause at the center and radiates out to show direct exposures, downstream winners (beneficiaries), and losers (headwinds) connected by color-coded relationship lines that clarify the structural links between assets.

### Supply Chain Contagion Tracing
![Argus AI causal chain supply ripple](img1.png)
The system identifies complex market setups, such as logistics-driven disruptions that ripple into airfreight substitution and manufacturing delays. This feature enables traders to visualize both immediate and delayed market reactions across diverse asset classes and sectors.



