CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    telegram_id BIGINT UNIQUE NOT NULL,
    username VARCHAR(255),
    subscribed BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS signals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tickers TEXT[] NOT NULL,
    ticker_profiles JSONB,
    direction VARCHAR(50) NOT NULL,
    confidence INTEGER CHECK (confidence >= 0 AND confidence <= 100),
    reasoning TEXT,
    source_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    -- Rich signal fields (populated by python/worker.py via Gemini)
    time_horizon VARCHAR(50),
    root_cause TEXT,
    source_headline TEXT,
    source_name VARCHAR(255),
    source_attribution TEXT,
    geography VARCHAR(255),
    market_consensus_divergence TEXT,
    investment_thesis TEXT,
    first_order_effects JSONB,
    second_order_effects JSONB,
    positively_affected TEXT[],
    negatively_affected TEXT[],
    thesis_risks JSONB,
    catalyst_chain JSONB,
    relationship_graph JSONB
);

-- Migration guards: safely add new columns to existing installs
ALTER TABLE signals ADD COLUMN IF NOT EXISTS time_horizon VARCHAR(50);
ALTER TABLE signals ADD COLUMN IF NOT EXISTS ticker_profiles JSONB;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS root_cause TEXT;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS source_headline TEXT;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS source_name VARCHAR(255);
ALTER TABLE signals ADD COLUMN IF NOT EXISTS source_attribution TEXT;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS geography VARCHAR(255);
ALTER TABLE signals ADD COLUMN IF NOT EXISTS market_consensus_divergence TEXT;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS investment_thesis TEXT;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS first_order_effects JSONB;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS second_order_effects JSONB;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS positively_affected TEXT[];
ALTER TABLE signals ADD COLUMN IF NOT EXISTS negatively_affected TEXT[];
ALTER TABLE signals ADD COLUMN IF NOT EXISTS thesis_risks JSONB;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS catalyst_chain JSONB;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS relationship_graph JSONB;

-- ================================================================
-- Phase 1: Per-User Watchlist & Notifications Schema
-- ================================================================

-- 1.1 Extend users table for web-first authentication
--     telegram_id becomes optional (web signup first, link Telegram later)
ALTER TABLE users ALTER COLUMN telegram_id DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(320) UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(256);
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_token VARCHAR(256) UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS authenticated_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_link_code VARCHAR(50) UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_broadcast BOOLEAN DEFAULT true;

-- 1.2 Watchlist rules (alerts are just watchlist items with notify=true)
CREATE TABLE IF NOT EXISTS user_watchlist (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255),
    ticker VARCHAR(10) NOT NULL,
    direction VARCHAR(20),              -- 'BULLISH', 'BEARISH', 'MIXED', or NULL (any)
    min_confidence INTEGER DEFAULT 0,
    max_confidence INTEGER DEFAULT 100,
    time_horizon VARCHAR(50),           -- 'short-term', 'medium-term', 'long-term', or NULL (any)
    source_quality VARCHAR(50),         -- 'high', 'medium', 'low', or NULL (any)
    notify_telegram BOOLEAN DEFAULT true,
    notify_in_app BOOLEAN DEFAULT true,
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_user_watchlist_user_id ON user_watchlist(user_id);
CREATE INDEX IF NOT EXISTS idx_user_watchlist_active ON user_watchlist(active);

-- 1.3 In-app notifications
CREATE TABLE IF NOT EXISTS user_in_app_notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    signal_id UUID NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
    watchlist_id UUID REFERENCES user_watchlist(id) ON DELETE SET NULL,
    read BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON user_in_app_notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON user_in_app_notifications(user_id, read);
