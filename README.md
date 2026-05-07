# RippleSignalBot Quick Setup

This project runs as three parts:

- Docker for PostgreSQL and Redis
- Node.js for the bot and news poller
- Python for the signal worker

## Prerequisites

- Node.js 18+ and npm
- Python 3.10+
- Docker and Docker Compose
- A Telegram bot token
- NewsAPI key
- Gemini API key

## 1) Start the database and Redis

```bash
docker compose up -d
```

This starts PostgreSQL on `5432` and Redis on `6379`.

## 2) Install dependencies

```bash
npm install
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## 3) Create `.env`

Create a `.env` file in the project root with at least these values:

```env
PORT=3000
DATABASE_URL=postgresql://devkada:devkada_password@localhost:5432/marketpulse
REDIS_URL=redis://localhost:6379
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
WEBHOOK_DOMAIN=https://your-ngrok-url.example
NEWS_API_KEY=your_newsapi_key
GEMINI_API_KEY=your_gemini_key
```

Optional settings:

```env
NEWS_BATCH_SIZE=20
NEWS_DEDUPE_ENABLED=true
NEWS_SEEN_TTL_SECONDS=86400
DISPATCH_BATCH_SIZE=20
DISPATCH_DELAY_MS=1000
MAX_SIGNAL_AGE_HOURS=72
GEMINI_MODEL=gemini-3.1-flash-lite-preview
```

## 4) Start the app

Open two terminals.

Terminal 1: Node bot and poller

```bash
npm start
```

Terminal 2: Python worker

```bash
source venv/bin/activate
python3 python/worker.py
```

## 5) If you are using ngrok

Use ngrok to expose your local Node backend on port `3000`:

```bash
ngrok http 3000
```

Copy the `https://...` forwarding URL that ngrok prints, then set it in `.env`:

```env
WEBHOOK_DOMAIN=https://your-ngrok-url.ngrok-free.app
```

Telegram webhooks need a public HTTPS URL, so `http://localhost:3000` will not work for `WEBHOOK_DOMAIN`.

If you are only testing the dashboard locally, open the app from the Node server at `http://localhost:3000/` after starting `npm start`.

If the dashboard is hosted on Vercel, set `window.API_BASE_URL` in [website/config.js](website/config.js) to your ngrok `https://...` URL so the browser sends `/api/*` requests to the backend instead of Vercel.

## What each process does

- `src/index.js` starts the Telegram bot webhook and the dispatcher
- `src/newsApi.js` polls NewsAPI and pushes raw articles into Redis
- `python/worker.py` reads `news:raw`, generates signals, stores them in Postgres, and publishes `signals:ready`

## Quick check

- `GET /health` on the Node app should return `{"ok":true,...}`
- PostgreSQL should contain `users` and `signals` from `db/init.sql`
