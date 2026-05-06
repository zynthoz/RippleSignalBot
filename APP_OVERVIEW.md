# RippleSignalBot / MarketPulse AI Overview

## Purpose
RippleSignalBot is a news-to-signal platform for market monitoring. It ingests business and financial news, turns articles into structured trading signals, and surfaces them in a dashboard and Telegram flow so users can quickly understand what matters and act on it.

The product is designed for people who want fast, contextual market intelligence without reading every article themselves. It does not execute trades; it helps users spot catalysts, understand likely market impact, and follow the signals they care about.

## What It Does
1. Polls news sources and detects fresh market-moving stories.
2. Uses an AI worker to generate a structured signal from each article.
3. Stores and serves signals through a web dashboard.
4. Sends signals to Telegram for subscribed users.
5. Lets users build watchlist rules so they only get alerts for matching signals.
6. Shows in-app notifications and a signal detail view with causal analysis.

## Main User-Facing Features
### Signal Feed
- Real-time list of generated signals.
- Filtering by bullish, bearish, or mixed direction.
- Pagination and search across signal text and tickers.

### Analysis Node
- Full detail view for the selected signal.
- Displays the catalyst news story, confidence, time horizon, causal chain, and AI reasoning.
- Highlights the primary tickers affected by the event.
- Includes a direct `Set Alert` action that opens the watchlist flow for that signal.

### Causal / Topology View
- Visualizes how the news event propagates through related companies and sectors.
- Helps users see primary, secondary, beneficiary, and headwind relationships.

### Watchlist
- Users can create per-ticker rules.
- Rules can filter by direction, confidence range, time horizon, and source quality.
- Notifications can be delivered in-app and/or to Telegram.
- The watchlist drawer is the main place to configure alerts.

### Notifications
- In-app notification popover in the header.
- Unread badge polling.
- Clicking a notification loads the matching signal in the dashboard.

### Authentication and Telegram Linking
- Website session support for user accounts.
- Telegram linking via a code exchange.
- Logged-in users can manage watchlist rules and notifications.

## System Parts
### Node.js Backend
- Serves the web app and REST APIs.
- Handles authentication, watchlist CRUD, and notification retrieval.
- Runs the Telegram bot and signal dispatcher.

### Python Worker
- Reads raw news items.
- Generates structured signals using the AI pipeline.
- Stores signal records in PostgreSQL.

### Telegram Bot
- Delivers signal notifications.
- Supports linking a Telegram account to a website user profile.
- Provides a lightweight command surface for updates and subscription management.

### Web Dashboard
- Provides the three-panel trading-style interface.
- Keeps the feed, topology, and analysis view visible together.
- Uses drawers and popovers instead of separate pages to preserve context.

## Core Design Principle
The app is built around the idea that market context should stay visible. Instead of switching between many pages, users stay inside one workspace and use secondary overlays for alerts, notifications, and account actions.

## In One Sentence
RippleSignalBot turns financial news into AI-generated market signals and gives users a focused dashboard plus watchlist/notification tools to track the signals that matter to them.
