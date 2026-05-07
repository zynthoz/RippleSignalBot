# Argus AI Product Requirements Document

## Overview

Argus AI is a market-intelligence platform that turns finance headlines into structured, explainable trading signals.

The current codebase includes:

- A public landing page that introduces the product
- A dashboard that shows the signal feed, catalyst topology, and analysis panel
- A Telegram bot for alerts and quick commands
- A Node.js API layer for auth, watchlists, notifications, signals, and webhook handling
- A Python worker that uses Gemini to generate structured market signals
- PostgreSQL and Redis for persistence, queueing, and deduplication

This PRD describes the actual product as implemented in the repository.

## Problem Statement

Market participants need more than raw headlines.

They need a system that can:

- Detect relevant news fast
- Explain why a story matters to markets
- Identify which tickers are directly and indirectly affected
- Show whether the impact is bullish, bearish, or mixed
- Surface second-order supply chain and contagion effects

## Product Goal

Argus AI should help a user move from headline to market thesis as quickly as possible.

The product should make it easy to:

- Discover a signal
- Understand the causal chain behind it
- Evaluate confidence and time horizon
- Save a ticker-based watchlist
- Receive alerts in the dashboard and Telegram

## Product Surfaces

### Landing Page

The landing page is the first experience for new visitors.

It explains the product, shows the value proposition, and links to the dashboard and Telegram bot.

### Dashboard

The dashboard is the authenticated operating surface.

It includes:

- Signal feed
- Catalyst topology graph
- Analysis node panel
- Notification popover
- Watchlist drawer
- Login and registration UI

### Telegram Bot

The bot is a companion delivery channel.

Supported commands:

- `/start`
- `/help`
- `/latest`
- `/subscribe`
- `/unsubscribe`
- `/broadcast on|off`
- `/linktelegram <code>`

### Backend API

The Node service exposes the app data and handles authentication, watchlist management, notifications, and signal retrieval.

## Core User Journey

1. A visitor opens the landing page.
2. The visitor launches the dashboard or Telegram bot.
3. The user signs up or logs in on the web app.
4. The dashboard restores the session and shows the main workspace.
5. The user scans the signal feed.
6. The user selects a signal and inspects the causal topology.
7. The user reads the analysis node and signal metadata.
8. The user creates watchlist rules.
9. The user receives in-app notifications and Telegram alerts for matching signals.
10. The user can link Telegram to the web account using a generated code.

## Functional Requirements

### 1. News Ingestion

The system shall:

- Poll NewsAPI business headlines on a schedule
- Keep only articles within the configured freshness window
- Deduplicate repeated stories in Redis
- Mark articles as pending while they are being processed
- Promote processed articles into a seen cache

### 2. AI Signal Generation

The Python worker shall:

- Send relevant articles to Gemini
- Return a single structured JSON signal
- Extract direction, confidence, root cause, and reasoning
- Identify positively and negatively affected tickers
- Build a causal chain and relationship graph
- Infer supply-chain and contagion relationships when possible

The generated signal should include, when available:

- `tickers`
- `ticker_profiles`
- `direction`
- `confidence`
- `reasoning`
- `source_headline`
- `source_name`
- `source_attribution`
- `root_cause`
- `time_horizon`
- `geography`
- `market_consensus_divergence`
- `investment_thesis`
- `first_order_effects`
- `second_order_effects`
- `positively_affected`
- `negatively_affected`
- `thesis_risks`
- `catalyst_chain`
- `relationship_graph`
- `vulnerability_type`
- `contagion_path`
- `chokepoint`

### 3. Signal Storage

The system shall store signals in PostgreSQL.

Signals must be available for:

- Dashboard rendering
- Telegram delivery
- Notification matching
- Performance tracking

### 4. Signal Publishing

The worker shall publish processed signals to the `signals:ready` Redis stream.

That stream supports:

- Server-sent event updates in the dashboard
- Deduplication and backfill
- Downstream delivery to notification consumers

### 5. Web Authentication

The web app shall support:

- Registration
- Login
- Session restoration
- Logout

The user record shall support:

- Email
- Password hash
- Display name
- Session token
- Telegram link code
- Telegram ID

### 6. Watchlist Management

Authenticated users shall be able to create, update, disable, and delete watchlist rules.

Watchlist rules support:

- Ticker
- Direction filter
- Minimum confidence
- Maximum confidence
- Time horizon
- Source quality
- Telegram notification toggle
- In-app notification toggle

Constraints:

- Maximum 20 active rules per user
- Tickers are normalized to uppercase
- Watchlist rules are user-scoped

### 7. Notifications

The app shall support in-app notifications for signals that match a user’s watchlist.

It shall support:

- Unread count polling
- Notification list rendering
- Mark as read
- Mark all as read

### 8. Telegram Integration

The bot shall:

- Introduce itself as ArgusBot
- Give a short product intro on `/start`
- Explain commands on `/help`
- Return recent signals via `/latest`
- Manage subscription state
- Toggle broadcast mode
- Link Telegram to the web account through a generated code

## Dashboard Requirements

### Signal Feed

The feed shall:

- Show bullish, bearish, and mixed signals
- Display confidence and time-ago information
- Show ticker symbols and headline text
- Allow filtering by direction
- Allow search by ticker or theme

### Catalyst Topology

The topology view shall:

- Render the root cause as the center node
- Render primary tickers, direct effects, secondary effects, beneficiaries, and headwinds as branches
- Color nodes and links by impact tone
- Support drag interaction
- Support fullscreen or expanded topology viewing
- Show relationship labels and exposure details when available

### Analysis Node

The analysis panel shall:

- Show selected signal details
- Show confidence and impact horizon
- Show the causal chain
- Show the contagion path
- Show source and article metadata

## Landing Page Requirements

The landing page shall:

- Be the first page a user sees on the deployed site
- Present the product story before login
- Link clearly to the dashboard
- Link clearly to Telegram
- Use the product logo as a home link

## Data Model

### Users

The users table supports both web auth and Telegram linking.

Important fields:

- `telegram_id`
- `email`
- `password_hash`
- `display_name`
- `session_token`
- `authenticated_at`
- `telegram_link_code`
- `telegram_broadcast`

### Signals

Signals store both the original event and the AI-generated analysis.

Important fields:

- `tickers`
- `ticker_profiles`
- `direction`
- `confidence`
- `reasoning`
- `source_url`
- `time_horizon`
- `root_cause`
- `source_headline`
- `source_name`
- `source_attribution`
- `geography`
- `market_consensus_divergence`
- `investment_thesis`
- `first_order_effects`
- `second_order_effects`
- `positively_affected`
- `negatively_affected`
- `thesis_risks`
- `catalyst_chain`
- `relationship_graph`

### Watchlist

Watchlist rules are stored per user and determine alert preferences.

### Notifications

Notifications link a user, a signal, and optionally a watchlist rule.

## API Requirements

The Node service shall provide:

- `GET /health`
- `GET /api/signals`
- `GET /api/signals/:id`
- `GET /api/stats`
- `GET /api/events`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/logout`
- `GET /api/watchlist`
- `POST /api/watchlist`
- `PUT /api/watchlist/:id`
- `DELETE /api/watchlist/:id`
- `GET /api/notifications`
- `POST /api/notifications/:id/read`
- `POST /api/notifications/read-all`
- `POST /webhook` for Telegram updates

## Non-Functional Requirements

- The dashboard should load without a build step in the deployed static hosting setup.
- The backend should work locally with Docker for PostgreSQL and Redis.
- The system should deduplicate repeated articles and repeated processed signals.
- The UI should remain legible in a dark theme.
- The signal graph should support partially structured AI output.
- The app should recover sessions from localStorage after refresh.

## Success Criteria

The MVP is successful if a user can:

- Open the landing page
- Understand what the product does quickly
- Open the dashboard and see live signal cards
- Select a signal and inspect the causal graph
- Create a watchlist rule
- Receive a notification for a matching signal
- Link the Telegram bot to the web account

## Out of Scope

The current MVP does not need:

- Broker integration
- Order execution
- Portfolio management
- Advanced charting overlays
- Multi-user collaboration features
- Native mobile apps

## Implementation Notes

- The Node server owns web auth, Telegram webhook handling, API routes, and static file delivery.
- The Python worker owns AI analysis, signal enrichment, and publication into Redis and PostgreSQL.
- The dashboard consumes signals through REST and SSE.
- The Telegram bot is a companion delivery surface, not the primary analysis interface.

## Hackathon Positioning

The strongest demo line is:

> Argus AI takes a market-moving headline, turns it into a causal map, highlights the tickers that matter, and delivers the result in both the dashboard and Telegram.

That is the product this repository currently implements.