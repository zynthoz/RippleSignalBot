# Product Requirements Document
# MarketPulse AI — Telegram Market Signal Bot
**Version:** 1.0 (Hackathon MVP)
**Date:** May 2026
**Status:** Draft
**Platform:** Telegram Bot (Webhook via ngrok)

---

## 1. Executive Summary

MarketPulse AI is a Telegram bot that scrapes market and business news, interprets it using a LangGraph agent powered by Google Gemini, and pushes real-time investment signals directly to users. The system performs causal chain analysis — tracing a news event to the industries and stocks it affects, both directly and indirectly — and delivers signals as Telegram notifications. Built for a hackathon MVP, the system is self-hosted on a local machine and exposed publicly via ngrok.

---

## 2. Problem Statement

Retail investors face three core problems:

- **Information overload** — hundreds of news items per day with no filtering for market relevance
- **Slow reaction time** — by the time an investor reads and interprets a story, the market has already moved
- **Shallow analysis** — most tools surface headlines without tracing downstream impact to specific tickers

MarketPulse AI automates the full pipeline: **ingest → interpret → causal chain → signal → notify.**

---

## 3. Goals

### Product Goals
- Deliver AI-interpreted market signals inside Telegram within 60 seconds of a relevant news event
- Perform multi-hop causal chain analysis linking events to primary and secondary affected stocks
- Support multiple users discovering and using the bot via a shared Telegram link
- Function reliably in a self-hosted, hackathon environment

### MVP Scope (In)
- NewsAPI ingestion on a polling schedule
- Gemini-powered LangGraph agent for signal generation
- Causal chain reasoning (event → industry → stocks → adjacent stocks)
- Telegram push notifications via Telegraf.js
- Basic user commands: `/start`, `/subscribe`, `/unsubscribe`, `/latest`
- Redis Streams as the internal message queue
- PostgreSQL for user and signal storage
- ngrok webhook tunnel for public accessibility

### MVP Scope (Out)
- User authentication or premium tiers
- Mobile/web dashboard
- Portfolio tracking
- Backtesting or historical signal accuracy metrics
- Multi-language support

---

## 4. User Personas

| Persona | Description |
|---|---|
| **Hackathon Judge** | Evaluates the product live during demo; needs the bot to respond clearly and quickly |
| **Retail Investor** | Wants fast, digestible signals without doing deep research themselves |
| **Curious Tester** | Discovers the bot via a shared link; explores commands casually |

---

## 5. Features & Requirements

### 5.1 News Ingestion
- Poll **NewsAPI** every 60 seconds for top business and financial headlines
- Filter by categories: business, finance, markets, geopolitics
- Deduplicate articles using URL hashing to avoid reprocessing
- Push new articles into **Redis Streams** for the AI worker to consume

### 5.2 AI Signal Engine (LangGraph + Gemini)
This is the core of the product. A LangGraph agent receives a news article and produces a structured investment signal.

**Agent steps:**
1. Read and classify the news article (geopolitical, earnings, macro, sector-specific)
2. Extract named entities — companies, countries, commodities, people
3. Perform causal chain traversal:
   - Identify the primary industry affected
   - Map to directly impacted stocks
   - Identify adjacent/secondary stocks affected
4. Assign signal direction: `BULLISH` / `BEARISH` / `NEUTRAL`
5. Assign confidence score: 0–100
6. Generate a 2–3 sentence plain-English reasoning summary
7. Output structured signal (see schema below)

**Example causal chain:**
```
News: "US launches missile strike in Middle East"
→ Primary: Defense manufacturers → RTX, LMT, NOC (BULLISH)
→ Adjacent: Oil supply risk → XOM, CVX (BULLISH)
→ Risk-off: Airlines, tourism → DAL, UAL, MAR (BEARISH)
```

**Signal output schema:**
```json
{
  "tickers": ["RTX", "LMT"],
  "direction": "BULLISH",
  "confidence": 82,
  "reasoning": "US military action increases demand for Raytheon and Lockheed missiles and defense systems. Both companies hold active DoD contracts for the weapon systems reportedly used.",
  "time_horizon": "intraday",
  "source_headline": "US launches missile strike...",
  "source_url": "https://...",
  "timestamp": "2026-05-03T08:42:00Z"
}
```

**LLM:** Google Gemini via Google AI Studio API key
**Framework:** LangChain + LangGraph (stateful agent with tool use)

### 5.3 Telegram Bot (Telegraf.js)
**Mode:** Webhook (via ngrok free tier)
**Discoverability:** Publicly accessible via `t.me/YourBotName`; share link to distribute

**Commands:**

| Command | Description |
|---|---|
| `/start` | Welcome message + onboarding instructions |
| `/subscribe` | Subscribe to receive live signal notifications |
| `/unsubscribe` | Stop receiving notifications |
| `/latest` | Return the 5 most recent signals |
| `/help` | List available commands |

**Notification format:**
```
📈 BULLISH SIGNAL — RTX, LMT
Confidence: 82%
Time Horizon: Intraday

US military action increases demand for Raytheon and 
Lockheed defense systems. Both hold active DoD contracts 
for systems reportedly used in the strike.

Source: Reuters — "US launches missile strike in Middle East"
🔗 https://reuters.com/...
```

### 5.4 Data Storage (PostgreSQL)

**users table**
| Column | Type | Description |
|---|---|---|
| id | UUID | Primary key |
| telegram_id | BIGINT | Telegram user ID |
| username | VARCHAR | Telegram username |
| subscribed | BOOLEAN | Receiving notifications |
| created_at | TIMESTAMP | Registration time |

**signals table**
| Column | Type | Description |
|---|---|---|
| id | UUID | Primary key |
| tickers | TEXT[] | Affected tickers |
| direction | VARCHAR | BULLISH / BEARISH / NEUTRAL |
| confidence | INTEGER | 0–100 |
| reasoning | TEXT | AI-generated summary |
| source_url | TEXT | Original article URL |
| created_at | TIMESTAMP | Signal generation time |

### 5.5 Message Queue (Redis Streams)

- **Stream:** `news:raw` — articles from NewsAPI poller waiting to be processed
- **Stream:** `signals:ready` — processed signals waiting to be dispatched to Telegram
- Consumer groups used to ensure no article is processed twice and no signal is sent twice

---

## 6. System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Your Machine                         │
│                                                         │
│  ┌─────────────┐     ┌──────────────────────────────┐  │
│  │ NewsAPI     │────▶│ Redis Stream: news:raw        │  │
│  │ Poller      │     └──────────────┬───────────────┘  │
│  │ (60s cron)  │                    │                   │
│  └─────────────┘                    ▼                   │
│                        ┌────────────────────────┐       │
│                        │ LangGraph Agent Worker  │       │
│                        │ (Gemini via AI Studio)  │       │
│                        └───────────┬────────────┘       │
│                                    │                     │
│                        ┌───────────▼────────────┐       │
│                        │ Redis Stream:           │       │
│                        │ signals:ready           │       │
│                        └───────────┬────────────┘       │
│                                    │                     │
│  ┌─────────────┐      ┌────────────▼───────────┐        │
│  │ PostgreSQL  │◀────▶│ Telegraf.js Bot         │        │
│  │ (users +    │      │ (webhook mode)          │        │
│  │  signals)   │      └────────────┬───────────┘        │
│  └─────────────┘                   │                     │
│                                    │                     │
└────────────────────────────────────┼────────────────────┘
                                     │
                              ┌──────▼──────┐
                              │    ngrok    │
                              │ free tunnel │
                              └──────┬──────┘
                                     │
                              ┌──────▼──────┐
                              │  Telegram   │
                              │  Servers    │
                              └─────────────┘
```

---

## 7. Tech Stack Summary

| Layer | Technology | Reason |
|---|---|---|
| News Source | NewsAPI | Simple REST API, no scraping infrastructure needed for MVP |
| AI Framework | LangChain + LangGraph | Stateful agent, tool use, structured output parsing |
| LLM | Google Gemini (AI Studio) | Free API key, strong reasoning, good context window |
| Message Queue | Redis Streams | Lightweight, fast, easy local setup |
| Database | PostgreSQL | Reliable relational store for users and signals |
| Bot Framework | Telegraf.js | Best-in-class Telegram bot library, clean webhook support |
| Tunnel | ngrok (free tier) | Exposes localhost webhook to Telegram publicly |
| Runtime | Node.js + Python | Telegraf.js on Node; LangGraph agent on Python |
| Containerization | Docker Compose | Single command to spin up all services locally |

---

## 8. Technical Considerations & Risks

| Risk | Impact | Mitigation |
|---|---|---|
| ngrok restarts / machine sleeps | Bot goes offline for all users | Keep machine awake; set ngrok to auto-reconnect |
| NewsAPI free tier rate limit (100 req/day) | Reduced news coverage | Cache responses; poll smartly; upgrade if needed |
| Gemini API quota limits | AI worker stalls | Add retry logic with exponential backoff |
| LangGraph agent hallucinating tickers | Bad signals sent to users | Validate tickers against a known stock list before sending |
| Redis or PostgreSQL crash | Data loss / bot failure | Docker restart policies; pgdump before demo |
| Telegram webhook timeout (5s limit) | Bot appears unresponsive | Acknowledge webhook immediately; process signal async |

---

## 9. Development Milestones (Hackathon Timeline)

| Milestone | Tasks |
|---|---|
| **Phase 1 — Infrastructure** | Docker Compose setup, PostgreSQL schema, Redis Streams, ngrok tunnel, Telegraf.js skeleton with webhook |
| **Phase 2 — Data Pipeline** | NewsAPI poller, deduplication, push to Redis Stream |
| **Phase 3 — AI Agent** | LangGraph agent with Gemini, causal chain logic, structured signal output, ticker validation |
| **Phase 4 — Bot Commands** | `/start`, `/subscribe`, `/unsubscribe`, `/latest`, notification dispatcher |
| **Phase 5 — Integration & Demo** | End-to-end test, signal quality review, share bot link, demo preparation |

---

## 10. Out of Scope (Post-Hackathon Ideas)

- Move to real hosting (Railway / Fly.io / VPS) for 24/7 uptime
- Add sector subscription filters (`/subscribe tech`, `/subscribe energy`)
- User watchlists with ticker-specific alerts
- Signal accuracy tracking and feedback (`👍 / 👎` buttons)
- Web dashboard for signal history
- Replace NewsAPI with full Scrapy + Playwright scraper for broader coverage
- Fine-tune Gemini on historical news-to-price-movement datasets
- Add crypto market signals

---

*MarketPulse AI — Hackathon MVP PRD v1.0*