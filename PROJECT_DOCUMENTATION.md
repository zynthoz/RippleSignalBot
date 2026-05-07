# RippleSignalBot - Project Documentation

## 📋 Project Overview

**RippleSignalBot** (also known as **ARGUS AI** / **MarketPulse AI**) is a news-to-signal platform that transforms financial and business news into AI-generated market trading signals. It helps traders and investors quickly identify market-moving events, understand their impact on specific stocks and sectors, and receive timely notifications through a modern web dashboard and Telegram bot.

### What It Does

1. **Polls financial news sources** continuously using NewsAPI
2. **Analyzes articles using AI** (Google Gemini) to extract market relevance
3. **Generates structured trading signals** with causal reasoning
4. **Visualizes impact chains** showing how news propagates through related companies and sectors
5. **Delivers notifications** in-app and via Telegram for matched watchlist rules
6. **Enables watchlist management** so users only get alerts for signals they care about

---

## 🎯 Purpose & Goals

### Core Problem It Solves
- **Information overload** — Too many news items, need intelligent filtering
- **Slow reaction time** — By the time a trader reads and interprets news, the market has already moved
- **Shallow analysis** — Most tools show headlines without tracing cascading impact to affected stocks

### Why It Matters
Traders and retail investors need **fast, contextual market intelligence** without having to read and interpret every article themselves. RippleSignalBot automates the pipeline: **ingest → interpret → causal analysis → signal → notify**.

---

## 🛠 Technology Stack

### Backend
| Component | Technology | Version |
|-----------|-----------|---------|
| **Server Framework** | Node.js + Express | 18+ |
| **Bot Client** | Telegraf.js | 4.15.3 |
| **HTTP Client** | Axios | 1.6.8 |
| **Database** | PostgreSQL | 15+ |
| **Cache / Message Queue** | Redis (Upstash) | ioredis 5.3.2 |
| **Task Scheduling** | node-cron | 4.2.1 |
| **Authentication** | bcryptjs | 3.0.3 |
| **Configuration** | dotenv | 16.4.5 |

### AI & ML
| Component | Technology | Version |
|-----------|-----------|---------|
| **LLM Provider** | Google Gemini | ^0.5.0 |
| **AI Framework** | LangGraph | Latest |
| **LLM Chain Library** | LangChain Google GenAI | Latest |
| **Python SDK** | google-genai | Latest |

### Python Worker
| Component | Technology | Version |
|-----------|-----------|---------|
| **Database ORM** | SQLAlchemy | Latest |
| **Database Driver** | psycopg2-binary | Latest |
| **Cache Client** | Redis | Latest |
| **Environment Config** | python-dotenv | Latest |
| **Financial Data** | yfinance | Latest |

### Frontend
| Component | Technology |
|-----------|-----------|
| **Visualization** | D3.js |
| **REST Client** | Fetch API / Axios |
| **DOM Manipulation** | Vanilla JavaScript |
| **Styling** | CSS3 |

### Infrastructure
| Component | Technology |
|-----------|-----------|
| **Containerization** | Docker & Docker Compose |
| **Public Tunneling** | ngrok |
| **Version Control** | Git / GitHub |

---

## 🏗 System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    External Services                         │
│  (NewsAPI, Google Gemini, Telegram, Upstash Redis)         │
└───────────────────────┬─────────────────────────────────────┘
                        │
        ┌───────────────┼───────────────┐
        │               │               │
    ┌─────────┐  ┌─────────────┐  ┌──────────┐
    │ Node.js │  │   Python    │  │ PostgreSQL
    │ Backend │  │   Worker    │  │ Database │
    │ Server  │  │ (LLM Agent) │  └──────────┘
    └────┬────┘  └─────────────┘
         │               │
         ├──────┬────────┤
         │      │        │
      ┌──────────────────────┐
      │   Redis / Cache      │
      │  (Signal Queue)      │
      └──────────────────────┘
         │
    ┌────┴──────────────────┐
    │                       │
 ┌──────────┐         ┌──────────┐
 │   Web    │         │ Telegram │
 │Dashboard │         │   Bot    │
 │(D3 UI)   │         │ (Telegraf)
 └──────────┘         └──────────┘
```

---

## ✨ Features & Functionalities

### 1. **Signal Feed**
- Real-time list of market signals generated from news articles
- Filter by direction: Bullish, Bearish, or Mixed
- Pagination and search capabilities
- Clickable signals that load full analysis

### 2. **Analysis Node (Detail View)**
- Displays the catalyst news story and original article
- Shows confidence level and time horizon
- Includes causal chain reasoning — why this matters
- Highlights primary tickers affected
- AI-generated description in trader-friendly language
- Quick "Set Alert" button to create watchlist rules

### 3. **Topology View (Causal Graph)**
Visualizes how a news event propagates through the market:
- **Primary Impact**: Companies directly mentioned in the news
- **Secondary Companies**: Related firms and suppliers affected
- **Beneficiaries**: Companies that gain from the event
- **Headwinds**: Companies negatively impacted
- Interactive graph with zoom, pan, and details on hover
- Labeled edges showing relationship types

### 4. **Impact View (Hierarchical Visualization)**
- Fixed hierarchy showing news → industry → affected stocks
- Conviction indicators (color-coded confidence levels)
- Curved SVG edges for clarity
- Tooltips showing impact reasoning
- Responsive layout that adapts to content

### 5. **Watchlist & Alerts**
- Create per-ticker alert rules
- Filter by: Direction, Confidence Range, Time Horizon, Source Quality
- Delivery channels: In-app notifications and/or Telegram
- Real-time alert dispatch when signals match rules
- Manage multiple watchlist rules per user

### 6. **Notifications**
- In-app notification popover in header
- Unread badge with count
- Telegram notifications for subscribed signals
- Click to load matching signal in dashboard

### 7. **User Authentication & Telegram Linking**
- Website session-based user accounts
- Telegram account linking via code exchange
- User profile management
- Persistent watchlist and preferences

### 8. **Telegram Bot Interface**
- `/start` — Initialize and link account
- `/latest` — Get the most recent signal
- `/subscribe` — Enable Telegram notifications
- `/unsubscribe` — Disable notifications
- Direct signal delivery when rules match

---

## 🔧 Core Components

### Backend Services

#### **News Poller** (`src/newsApi.js`)
- Periodically polls NewsAPI for fresh market-moving stories
- Filters by business, finance, and market categories
- Deduplicates using URL hashing
- Pushes new articles to Redis queue for processing

#### **Signal Dispatcher** (`src/dispatcher.js`)
- Routes processed signals to appropriate channels
- Sends Telegram notifications to subscribed users
- Delivers in-app notifications
- Matches signals against user watchlist rules

#### **Telegram Bot** (Telegraf middleware in `src/index.js`)
- Handles user commands and interactions
- Links Telegram accounts to website users
- Delivers signal notifications
- Manages subscription preferences

#### **Redis Client** (`src/redisClient.js`)
- Shared cloud-safe Redis connection factory
- Manages connection pooling for Upstash
- Used for message queues, caching, and session storage

### Python Worker

#### **Signal Generation Engine** (`python/worker.py`)
- Reads articles from Redis queue
- Uses LangGraph agent with Gemini LLM
- Generates structured signal JSON including:
  - **Tickers**: Affected companies
  - **Direction**: Bullish, Bearish, or Mixed
  - **Confidence**: Signal strength (0-100)
  - **Time Horizon**: When impact expected
  - **Investment Thesis**: Why this matters
  - **Thesis Risks**: Potential counters
  - **Causal Chain**: How impact propagates
  - **Relationship Graph**: Company connections
  - **Reasoning**: AI explanation for casual traders
- Stores signals in PostgreSQL
- Model prompt tuned for trader-friendly language

#### **Supporting Utilities**
- `python/ticker_cache.py` — Maintains ticker and company name mappings
- `python/price_fetcher.py` — Fetches stock price data from yfinance
- `python/performance_tracker.py` — Tracks signal accuracy and performance
- `python/db_pool.py` — Database connection pooling

### Frontend Dashboard

#### **Web UI** (`website/app.js`)
- Three-panel trading-style interface
- Real-time signal feed on the left
- Topology/Impact graph in center
- Analysis detail panel on the right
- State management for view modes (Topology vs Impact)
- D3.js rendering for complex graphs
- Responsive layout with fullscreen modes

#### **Interactive Elements**
- Signal search and filtering
- Graph node tooltips with details
- Node-adjacent labels with smart positioning
- Fullscreen graph view
- Watchlist drawer for rule management
- Notification popover

---

## 📊 Data Flow

```
1. News Article (NewsAPI)
         ↓
2. Redis Stream Queue
         ↓
3. Python Worker (LLM Analysis)
         ↓
4. PostgreSQL Storage
         ↓
5. Node.js API (retrieve signals)
         ↓
6. Web Dashboard / Telegram Bot
         ↓
7. User Notification & Interaction
```

---

## 🚀 Key Technologies & Why They Were Chosen

### **Google Gemini + LangGraph**
- Multi-step reasoning for causal chain analysis
- Cost-effective for high-volume signal generation
- Easy integration with Python ecosystem

### **D3.js for Visualization**
- Network graph rendering (Topology & Impact views)
- Interactive features (hover, zoom, pan)
- SVG-based for scalable graphics

### **Redis / Upstash**
- Fast message queue for article processing
- Shared state across backend services
- Cloud-hosted for reliability

### **PostgreSQL**
- ACID compliance for signal and user data
- Relational schema for watchlist rules
- Full-text search for signal discovery

### **Telegraf.js**
- Native Telegram Bot API abstraction
- Webhook support via ngrok for local development
- Command routing and middleware

### **Vanilla D3 + JavaScript**
- No build step needed for frontend
- Direct DOM manipulation for responsiveness
- Minimal dependencies for dashboard

---

## 🎨 User Experience Design

The dashboard follows a **three-panel trading terminal** paradigm:

1. **Left Panel**: Signal feed with search/filter
2. **Center Panel**: Interactive graph (Topology or Impact view)
3. **Right Panel**: Detailed analysis for selected signal

**Secondary overlays** (not separate pages):
- Watchlist drawer
- Notification popover
- Account settings

**Key Design Principle**: Market context stays visible. Users work within one workspace using overlays instead of switching between pages.

---

## 📈 Use Cases

### For Day Traders
- Spot intraday catalysts faster than news feeds
- Understand cross-market impact in real-time
- Set alerts on key stocks to catch moves early

### For Swing Traders
- Track multi-day catalyst effects
- Monitor related sector movements
- Build hedges based on causal chains

### For Portfolio Managers
- Identify systemic risks from major news
- Understand second-order effects
- Prioritize due diligence on affected holdings

### For Retail Investors
- Get curated market intelligence
- Learn causal reasoning from AI analysis
- Reduce time spent reading financial news

---

## 🔐 Security & Reliability

- **Password hashing** with bcryptjs
- **Environment variable management** via dotenv
- **Session-based auth** for web users
- **Telegram code-based linking** for bot
- **Redis connection pooling** for reliability
- **Docker containerization** for consistency
- **Error handling** and retry logic in worker

---

## 🚦 Deployment & Setup

### Local Development
```bash
# Start database and cache
docker compose up -d

# Install Node dependencies
npm install

# Set up Python environment
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Configure environment
cp .env.example .env
# Edit .env with your API keys

# Run services
npm start
python3 python/worker.py
```

### Public Access
- ngrok tunnel for Telegram webhook
- Cloud-hosted Redis (Upstash) for multi-device sync
- Railway or similar for backend deployment

---

## 📥 Input Sources

- **NewsAPI**: Business and financial headlines
- **Google Gemini**: LLM for signal generation
- **yfinance**: Stock price and company data
- **User Input**: Watchlist configuration via web/Telegram

---

## 📤 Output Channels

- **Web Dashboard**: Interactive signal analysis
- **Telegram Bot**: Signal notifications
- **PostgreSQL**: Persistent signal and user data
- **Redis**: Real-time message queue

---

## 🎯 In One Sentence

**RippleSignalBot turns financial news into AI-generated market signals and gives traders a focused dashboard plus watchlist/notification tools to track the signals that matter to them.**

---

## 📝 Version & Status

- **Version**: 1.0.0 (Hackathon MVP + Production Refinement)
- **Status**: Active Development
- **Date**: May 2026
- **Platform**: Self-hosted with cloud integrations
