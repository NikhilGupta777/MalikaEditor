-- Add editing_patterns table for AI learning system persistence
-- Generated: 2026-02-03

-- Create pattern type enum
DO $$ BEGIN
    CREATE TYPE pattern_type AS ENUM ('cut', 'transition', 'broll', 'ai_image', 'caption', 'pacing', 'general');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Create editing_patterns table
CREATE TABLE IF NOT EXISTS editing_patterns (
    id SERIAL PRIMARY KEY,
    pattern_id TEXT NOT NULL UNIQUE,
    type pattern_type NOT NULL,
    genre TEXT,
    tone TEXT,
    prompt TEXT,
    action_details JSONB NOT NULL,
    success_score INTEGER NOT NULL,
    user_approved INTEGER NOT NULL DEFAULT 0,
    self_review_score INTEGER,
    context JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS editing_patterns_type_idx ON editing_patterns(type);
CREATE INDEX IF NOT EXISTS editing_patterns_genre_idx ON editing_patterns(genre);
CREATE INDEX IF NOT EXISTS editing_patterns_created_at_idx ON editing_patterns(created_at);
