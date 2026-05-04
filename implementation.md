# Implementation Plan: MarketPulse AI

This document breaks down the implementation of MarketPulse AI into actionable phases and sub-phases based on the PRD.

## Phase 1: Infrastructure & Environment Setup
**Goal:** Set up the local development environment, message broker, database, and public tunnel.

*   **1.1 Docker Compose Configuration**
    *   Create a `docker-compose.yml` file.
    *   Add PostgreSQL service (with initial user/db credentials).
    *   Add Redis service (for Streams).
*   **1.2 Database Initialization**
    *   Write SQL initialization scripts (`init.sql`).
    *   Create `users` table (`id`, `telegram_id`, `username`, `subscribed`, `created_at`).
    *   Create `signals` table (`id`, `tickers`, `direction`, `confidence`, `reasoning`, `source_url`, `created_at`).
*   **1.3 Public Webhook Setup**
    *   Install and run `ngrok` on port `3000` (or your chosen bot port).
    *   Register a new bot with Telegram `@BotFather` and save the Token.
*   **1.4 Project Scaffolding**
    *   Initialize the Node.js project (for the Telegraf bot and NewsAPI poller).
    *   Initialize the Python project/virtual environment (for the LangGraph AI Agent).

## Phase 2: Data Ingestion Pipeline (Node.js)
**Goal:** Continuously fetch news and push it into the message queue.

*   **2.1 NewsAPI Client**
    *   Set up Axios/Fetch client for NewsAPI.
    *   Create a polling mechanism (e.g., `node-cron` or `setInterval` every 60 seconds).
    *   Filter for relevant categories (business, finance, tech, etc.).
*   **2.2 Deduplication Logic**
    *   Generate a hash (or use the URL) for each article.
    *   Check Redis or an internal set to ensure the article hasn't been processed recently to prevent duplicate signals.
*   **2.3 Redis Stream Publisher**
    *   Connect to Redis.
    *   Push new, unique articles into the `news:raw` Redis Stream.

## Phase 3: AI Signal Engine (Python / LangGraph + Gemini)
**Goal:** Consume raw news, interpret the market impact, and output structured signals.

*   **3.1 Connect to Queue & Database**
    *   Set up a Redis consumer group to listen to `news:raw`.
    *   Set up PostgreSQL connection via SQLAlchemy or `psycopg2`.
*   **3.2 LangGraph & Gemini Setup**
    *   Initialize `langchain-google-genai` with AI Studio API keys.
    *   Define the state graph for the agent (Read -> Extract -> Chain Analysis -> Format Output).
*   **3.3 Causal Chain & Prompt Engineering**
    *   Write the system prompt enforcing the causal chain rule (Event -> Primary Industry -> Primary Stocks -> Adjacent Stocks).
    *   Define output schema for structured extraction (Tickers, Direction, Confidence, Reasoning, etc.).
*   **3.4 Ticker Validation (Optional but Recommended)**
    *   Create an implementation to verify that outputted tickers exist or are properly formatted before finalizing the signal.
*   **3.5 Signal Publishing**
    *   Save the structured signal directly to the PostgreSQL `signals` table.
    *   Push the signal data (or the new signal DB ID) to the `signals:ready` Redis Stream.

## Phase 4: Telegram Bot Application (Node.js / Telegraf)
**Goal:** Handle user interaction and push real-time notifications.

*   **4.1 Telegraf Initialization**
    *   Initialize Telegraf with the Telegram Bot Token.
    *   Configure webhook mode to listen on the local port exposed by ngrok.
*   **4.2 Command Handlers**
    *   Implement `/start`: Welcome text and instructions.
    *   Implement `/subscribe`: Upsert user into PostgreSQL `users` table and set `subscribed = true`.
    *   Implement `/unsubscribe`: Update `users` table and set `subscribed = false`.
    *   Implement `/latest`: Query PostgreSQL `signals` table for the top 5 most recent signals and send them formatted.
*   **4.3 Notification Dispatcher**
    *   Create a Redis consumer listening to `signals:ready`.
    *   Format incoming signals into the standard Telegram markdown/HTML layout.
    *   Query PostgreSQL for all users where `subscribed = true`.
    *   Iterate and dispatch the message using `telegram.sendMessage()`. Include batching/delays if necessary to avoid API limits.

## Phase 5: Integration, Testing & Polish
**Goal:** Ensure the system runs smoothly end-to-end for the demo.

*   **5.1 End-to-End Testing**
    *   Trigger a test article through the pipeline manually.
    *   Verify the AI interprets it, saves it to the DB, and the bot pushes the notification to Telegram.
*   **5.2 Error & Edge Case Handling**
    *   Handle empty news API responses.    
    *   Handle Gemini API rate limits/timeouts (add retry logic).
    *   Ensure Telegraf immediately returns a `200 OK` to Telegram webhooks to prevent timeouts.
*   **5.3 Demo Preparation**
    *   Verify ngrok auto-reconnect or write a script to easily restart and set the webhook if it drops.
    *   Prepare 2-3 specific, high-impact news URLs to manually push into the queue during the live demo to showcase the causal chain analysis cleanly.
