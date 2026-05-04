# MarketPulse AI — Web Dashboard Integration Plan

## Overview

This document maps the existing Telegram bot backend to the Stitch-generated web
dashboard (`website/index.html`) and breaks down every integration step into
discrete, reviewable sub-tasks.

---

## Current State Audit

### Backend (Node.js — `src/`)

| File | Role | Key Exports |
|---|---|---|
| `src/index.js` | HTTP server + Telegraf bot | `/health`, `/webhook`, bot commands |
| `src/dispatcher.js` | Redis consumer → Telegram broadcaster | `startDispatcher`, `formatSignalMessage` |
| `src/newsApi.js` | NewsAPI poller → `news:raw` stream | `poll` |

**Exposed HTTP routes today:**
- `GET /health` → `{ ok: true, bot: true }`
- `POST /webhook` → Telegram webhook receiver

**Missing for the website:**
- No REST API endpoints for signals or users
- No static file serving
- No real-time push to browsers

---

### Python Worker (`python/worker.py`)

Reads `news:raw`, calls Gemini, validates tickers via Yahoo Finance,
then writes to:

1. **PostgreSQL** `signals` table (bare minimum: tickers, direction, confidence,
   reasoning, source_url)
2. **Redis** `signals:ready` stream (full rich payload: root_cause, first/second
   order effects, catalyst_chain, investment_thesis, thesis_risks, positively/
   negatively_affected, geography, source_headline, source_attribution)

**Schema gap:** The DB `signals` table only has 6 columns, but the worker and
dispatcher use ~15 fields. The rich data lives only in Redis and is lost after
the dispatcher ACKs it.

---

### Database (`db/init.sql`)

```sql
-- Current signals table (6 cols only):
signals (id, tickers, direction, confidence, reasoning, source_url, created_at)
```

Missing columns consumed by `dispatcher.js` / `worker.py`:
`time_horizon`, `root_cause`, `first_order_effects`, `second_order_effects`,
`positively_affected`, `negatively_affected`, `investment_thesis`, `thesis_risks`,
`catalyst_chain`, `geography`, `source_headline`, `source_name`,
`source_attribution`, `market_consensus_divergence`

---

### Website (`website/index.html`)

- **Stack:** Tailwind CSS (CDN), Material Symbols, IBM Plex Mono + Inter + Work Sans
- **Layout:** 3-column — Signal Feed | Center (empty) | Analysis Node
- **Signal Feed:** Static mock cards; filter buttons (ALL / BULL / BEAR) wired to nothing
- **Analysis Node:** Static mock detail panel for `LMT`
- **Center column:** 100% empty — no content

**Reusable HTML components identified:**

| Component | Location in file | Lines |
|---|---|---|
| Signal Card (Bullish) | Left sidebar | 134–146 |
| Signal Card (Bearish) | Left sidebar | 148–160 |
| Signal Card (Neutral) | Left sidebar | 162–174 |
| Analysis Node Panel | Right sidebar | 181–234 |
| Causal Chain Item | Inside Analysis Node | 210–216 |
| Metrics Grid Cell | Inside Analysis Node | 197–205 |
| Footer Status Bar | `<footer>` | 237–246 |

---

## Integration Architecture

```
Browser (index.html)
  │  polling / SSE
  ▼
GET /api/signals         ← src/index.js (new REST routes)
GET /api/signals/:id
GET /api/stats
GET /api/events (SSE)   ← streams signals:ready to browser
  │
  ▼
PostgreSQL  ←  Python worker (worker.py)  ←  Redis news:raw
                              │
                              └──►  Redis signals:ready  ──►  Dispatcher → Telegram
```

The Node server will both **serve the website** and **expose the REST API**,
reusing the existing `pg.Pool` connection.

---

## Sub-Tasks

---

### Phase 1 — Database Schema Extension

**Goal:** Persist the full rich signal payload so the website can query it.

#### 1.1 Add missing columns to `db/init.sql`

- Add `ALTER TABLE` / new column definitions for:
  `time_horizon VARCHAR(50)`, `root_cause TEXT`, `source_headline TEXT`,
  `source_name VARCHAR(255)`, `source_attribution TEXT`, `geography VARCHAR(255)`,
  `market_consensus_divergence TEXT`, `investment_thesis TEXT`,
  `first_order_effects JSONB`, `second_order_effects JSONB`,
  `positively_affected TEXT[]`, `negatively_affected TEXT[]`,
  `thesis_risks JSONB`, `catalyst_chain JSONB`
- Use `JSONB` for array-of-strings fields for easy querying
- Wrap in `ALTER TABLE IF NOT EXISTS` so existing DB installs don't break

#### 1.2 Update `python/worker.py` — `save_signal()`

- Extend the `INSERT` query in `save_signal()` to include all new columns
- Map each field from the signal dict to the correct column type
- Test: manually push one article through the pipeline and verify all columns
  are populated in `psql`

---

### Phase 2 — REST API in Node Server

**Goal:** Expose signal data over HTTP so the website JavaScript can fetch it.

#### 2.1 Add `GET /api/signals` route in `src/index.js`

- Query: `SELECT * FROM signals ORDER BY created_at DESC LIMIT 50`
- Support query params: `?direction=BULLISH`, `?limit=20`, `?offset=0`
- Return JSON array; timestamps in ISO 8601
- Reuse the existing `pool` instance — no new DB connection

#### 2.2 Add `GET /api/signals/:id` route

- Query by UUID primary key
- Return the full signal row as JSON (all new columns included)
- 404 if not found

#### 2.3 Add `GET /api/stats` route

- Return: `{ total_signals, subscribed_users, signals_today, last_signal_at }`
- Powers the footer status bar on the website

#### 2.4 Add `GET /api/events` SSE endpoint

- Use `text/event-stream` response
- Subscribe to `signals:ready` Redis stream (new Redis client in long-poll mode)
- Forward each new message as a `data: {...}\n\n` SSE event
- The browser receives live signal pushes without polling
- On disconnect, clean up the Redis connection

#### 2.5 Add CORS headers

- `Access-Control-Allow-Origin: *` (or restrict to `localhost` for MVP)
- Required for browser fetches to `localhost:3000` when opening `index.html`
  as a file

---

### Phase 3 — Static File Serving

**Goal:** The Node server serves the website directly; no separate web server needed.

#### 3.1 Serve `website/` directory from `src/index.js`

- Add `GET /` and `GET /*` catch-all route
- Stream the requested file from the `website/` directory using `fs.createReadStream`
- Set correct `Content-Type` header (`.html`, `.css`, `.js`, `.png`)
- 404 for any path not found in `website/`
- Access the dashboard at `http://localhost:3000/`

---

### Phase 4 — Website JavaScript: Signal Feed (Left Column)

**Goal:** Replace static mock signal cards with live data from the API.

#### 4.1 Extract Signal Card as a JS template function

Reuse the existing HTML structure (lines 134–174). Create a `renderSignalCard(signal)`
function that returns an HTML string:

```js
// Reused component — mirrors the static HTML in index.html
function renderSignalCard(signal) {
  const isBull = signal.direction === 'BULLISH';
  const isBear = signal.direction === 'BEARISH';
  const color   = isBull ? 'secondary' : isBear ? 'error' : 'primary-fixed-dim';
  const icon    = isBull ? 'trending_up' : isBear ? 'trending_down' : 'horizontal_rule';
  const label   = signal.direction;
  const ticker  = (signal.tickers || []).join(' · ') || 'N/A';
  const conf    = signal.confidence ?? 'N/A';
  const age     = timeAgo(signal.created_at);
  return `<div class="bg-surface border border-outline-variant border-l-4
    border-l-${color} p-2 cursor-pointer hover:bg-surface-variant
    transition-colors" data-id="${signal.id}">
    ...
  </div>`;
}
```

#### 4.2 Fetch and render signals on load

- `fetch('/api/signals')` on `DOMContentLoaded`
- Clear the static mock cards
- Render each signal using `renderSignalCard`
- Store signals in a module-level `signals` array for filtering

#### 4.3 Wire filter buttons (ALL / BULL / BEAR)

- Add `data-filter` attributes to the buttons
- On click: filter the `signals` array and re-render the list
- Highlight active button using Tailwind class toggle

#### 4.4 Latency display in Signal Feed header

- Replace static `12ms` with the real round-trip time of the `/api/signals` fetch
- Update on each poll

---

### Phase 5 — Website JavaScript: Analysis Node (Right Column)

**Goal:** Clicking a signal card populates the right panel with full detail.

#### 5.1 Extract Analysis Panel as a JS template function

Reuse the HTML structure (lines 186–233). Create `renderAnalysisNode(signal)`:

```js
function renderAnalysisNode(signal) {
  // Renders: ticker header, direction badge, confidence, impact horizon,
  // causal chain steps, AI reasoning, investment thesis, thesis risks,
  // source link — all from the signal object
}
```

#### 5.2 Render causal chain from `catalyst_chain` array

- Each step in `signal.catalyst_chain` becomes a chain item (reuse lines 210–216)
- Fallback: `first_order_effects` and `second_order_effects` if `catalyst_chain` is empty

#### 5.3 Signal card click → load detail

- Add click listener to each rendered signal card
- On click: `fetch('/api/signals/' + signal.id)` for full payload
- Call `renderAnalysisNode(signal)` and inject into the right panel
- Highlight the selected card with a border

#### 5.4 "Execute Hedge Script" button

- For MVP: copy the signal JSON to clipboard and show a toast notification
- Later: could trigger an ngrok-exposed automation endpoint

---

### Phase 6 — Website JavaScript: Center Column

**Goal:** Fill the currently empty center panel with a useful view.

#### 6.1 Catalyst Chain Graph (recommended)

- Render the `catalyst_chain` steps as a vertical node-graph
- Each node: icon + text, connected by animated SVG lines
- Highlight nodes based on direction (green/red/grey)
- Updates when a signal is selected in the left column

#### 6.2 Live News Feed (alternative / fallback)

- `GET /api/signals?limit=10` displayed as a scrolling ticker
- Auto-refresh every 30 seconds

#### 6.3 Stats Summary Cards (supplement)

- `fetch('/api/stats')` on load
- Render: Total Signals, Subscribed Users, Signals Today, Last Signal time
- Display as a 2×2 grid in the center column header

---

### Phase 7 — Real-Time Updates via SSE

**Goal:** New signals appear in the feed without refreshing.

#### 7.1 Connect to `GET /api/events` SSE from the browser

```js
const evtSource = new EventSource('/api/events');
evtSource.onmessage = (e) => {
  const signal = JSON.parse(e.data);
  signals.unshift(signal);           // prepend to array
  prependSignalCard(signal);         // prepend card to DOM
  flashNewSignalIndicator();         // pulse the green dot in the header
};
```

#### 7.2 Flash indicator on new signal

- The green dot in `<header>` (`.bg-secondary-container`) pulses with a CSS
  keyframe animation when a new signal arrives
- Auto-dimms after 3 seconds

---

### Phase 8 — Footer Status Bar

**Goal:** The footer shows live system health instead of static text.

#### 8.1 Wire `GET /api/stats` to the footer

- Replace `SYS_HEALTH: OPTIMAL | LATENCY: 12ms | CONNECTED: NYC-SEC-01` with:
  `SYS_HEALTH: OPTIMAL | LATENCY: {fetch_ms}ms | SIGNALS_TODAY: {n} | USERS: {u}`
- Fetch every 30 seconds and update in-place

---

### Phase 9 — Polish & Integration Hardening

#### 9.1 Error states

- If `/api/signals` fails: show `"No signals available — pipeline may be offline"` in the
  signal feed
- If SSE disconnects: show a reconnecting indicator; auto-retry after 5s

#### 9.2 Loading skeletons

- While signals are loading, show 3 skeleton cards (animated grey rectangles)
  using Tailwind's `animate-pulse` utility

#### 9.3 Signal count badge on filter buttons

- After fetch: `ALL (12)`, `BULL (7)`, `BEAR (5)` — count derived from the array

#### 9.4 Responsive layout

- The current design is fixed `h-screen overflow-hidden` — fine for a desktop terminal
- Add a mobile breakpoint: stack the three columns vertically on screens < 768px

---

## Component Reuse Map

| Existing Component | Reused In |
|---|---|
| `formatSignalMessage()` in `dispatcher.js` | Phase 4.1 JS template (same field names) |
| `escapeHtml()` in `dispatcher.js` | Copy to `website/app.js` or inline |
| `parseJsonArray()` in `dispatcher.js` | Copy to `website/app.js` for JSONB fields |
| Signal card HTML (lines 134–174) | Phase 4.1 `renderSignalCard()` |
| Analysis node HTML (lines 186–233) | Phase 5.1 `renderAnalysisNode()` |
| Causal chain item HTML (210–216) | Phase 5.2 `renderCatalystStep()` |
| Metrics grid cell HTML (197–205) | Phase 5.1 stats cells |
| Footer status bar (237–246) | Phase 8.1 live stats |
| `formatTicker()` in `dispatcher.js` | Phase 4.1 ticker rendering |

---

## File Changelist

| File | Action | Phase |
|---|---|---|
| `db/init.sql` | Add 14 new columns to `signals` | 1.1 |
| `python/worker.py` → `save_signal()` | Extend INSERT query | 1.2 |
| `src/index.js` | Add REST routes + static serving | 2.1–3.1 |
| `website/index.html` | Remove static mock data; add `<script src="app.js">` | 4–8 |
| `website/app.js` | **[NEW]** All client-side JS (fetch, render, SSE) | 4–8 |

---

## Suggested Order of Execution

```
1.1 → 1.2  (schema + worker)
2.1 → 2.3  (REST API, blocking tasks for the frontend)
3.1         (static serving so browser can open the page)
4.1 → 4.4  (signal feed becomes live)
5.1 → 5.4  (analysis node becomes interactive)
2.4 → 7.2  (SSE real-time push)
6.1         (center column)
8.1         (footer stats)
9.1 → 9.4  (polish)
```
