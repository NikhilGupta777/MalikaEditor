-- MalikaEditor Initial Schema Migration
-- Generated: 2026-02-03
-- This migration creates all tables for the MalikaEditor application

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Create enum types
DO $$ BEGIN
    CREATE TYPE project_status AS ENUM (
        'pending', 'uploading', 'analyzing', 'transcribing', 'planning',
        'fetching_stock', 'generating_ai_images', 'awaiting_review',
        'editing', 'rendering', 'completed', 'failed', 'cancelled'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE chat_message_role AS ENUM ('companion', 'user', 'system');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE chat_message_type AS ENUM ('update', 'explanation', 'question', 'answer', 'milestone', 'insight');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL
);

-- Video projects table
CREATE TABLE IF NOT EXISTS video_projects (
    id SERIAL PRIMARY KEY,
    file_name TEXT NOT NULL,
    original_path TEXT NOT NULL,
    output_path TEXT,
    prompt TEXT,
    status project_status NOT NULL DEFAULT 'pending',
    processing_stage TEXT,
    duration INTEGER,
    analysis JSONB,
    edit_plan JSONB,
    transcript JSONB,
    transcript_enhanced JSONB,
    stock_media JSONB,
    review_data JSONB,
    error_message TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP + INTERVAL '1 hour'
);

CREATE INDEX IF NOT EXISTS video_projects_status_idx ON video_projects(status);
CREATE INDEX IF NOT EXISTS video_projects_created_at_idx ON video_projects(created_at);
CREATE INDEX IF NOT EXISTS video_projects_expires_at_idx ON video_projects(expires_at);

-- Cached assets table
CREATE TABLE IF NOT EXISTS cached_assets (
    id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES video_projects(id) ON DELETE CASCADE,
    cache_type TEXT NOT NULL,
    cache_key TEXT NOT NULL,
    data JSONB NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP + INTERVAL '1 hour'
);

CREATE INDEX IF NOT EXISTS cached_assets_type_key_idx ON cached_assets(cache_type, cache_key);
CREATE INDEX IF NOT EXISTS cached_assets_expires_at_idx ON cached_assets(expires_at);

-- Project autosaves table
CREATE TABLE IF NOT EXISTS project_autosaves (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES video_projects(id) ON DELETE CASCADE,
    review_data JSONB NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS project_autosaves_project_id_idx ON project_autosaves(project_id);

-- Edit feedback table
CREATE TABLE IF NOT EXISTS edit_feedback (
    id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES video_projects(id) ON DELETE CASCADE,
    edit_action_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    was_approved INTEGER NOT NULL,
    was_modified INTEGER NOT NULL DEFAULT 0,
    user_reason TEXT,
    original_start INTEGER,
    original_end INTEGER,
    modified_start INTEGER,
    modified_end INTEGER,
    context_genre TEXT,
    context_tone TEXT,
    context_duration INTEGER,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS edit_feedback_project_id_idx ON edit_feedback(project_id);
CREATE INDEX IF NOT EXISTS edit_feedback_action_type_idx ON edit_feedback(action_type);

-- Project chat messages table
CREATE TABLE IF NOT EXISTS project_chat_messages (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES video_projects(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    role chat_message_role NOT NULL,
    type chat_message_type NOT NULL,
    content TEXT NOT NULL,
    stage TEXT,
    metadata JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS project_chat_messages_project_id_idx ON project_chat_messages(project_id);
CREATE INDEX IF NOT EXISTS project_chat_messages_created_at_idx ON project_chat_messages(created_at);

-- Session table (created by connect-pg-simple, but define here for completeness)
CREATE TABLE IF NOT EXISTS "session" (
    "sid" VARCHAR NOT NULL PRIMARY KEY,
    "sess" JSON NOT NULL,
    "expire" TIMESTAMP(6) NOT NULL
);

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
