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
    catalyst_chain JSONB
);

-- Migration guards: safely add new columns to existing installs
ALTER TABLE signals ADD COLUMN IF NOT EXISTS time_horizon VARCHAR(50);
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
