# AI Video Editor

## Overview

The AI Video Editor is an AI-powered application designed to automate video post-production. It allows users to upload raw video footage and use natural language prompts to describe desired edits. The system leverages AI for video content analysis, audio transcription, intelligent edit plan generation, stock media fetching, custom AI image generation, and produces a professionally edited video. This project aims to make video editing accessible and efficient for content creators, marketers, and businesses by revolutionizing traditional post-production workflows.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
- **Framework**: React 18 with TypeScript
- **Routing**: Wouter
- **State Management**: TanStack React Query
- **UI Components**: shadcn/ui built on Radix UI
- **Styling**: Tailwind CSS with CSS variables for theming

### Backend
- **Runtime**: Node.js with Express
- **Language**: TypeScript (ESM modules)
- **API Structure**: RESTful endpoints
- **Video Processing**: FFmpeg via `fluent-ffmpeg` for all video and audio manipulations.

### Data Storage
- **ORM**: Drizzle ORM with PostgreSQL
- **In-Memory Storage**: `MemStorage` for fallback/temporary storage.
- **Project History**: Past projects viewable with status badges and quick actions.
- **Autosave**: User modifications in the review panel are automatically saved and restored.
- **Asset Caching**: `cachedAssets` table stores stock media and AI images for reuse.

### AI Services (Modular Architecture)
The AI services are modularized for transcription, video analysis, semantic analysis, edit planning, and image generation.

#### Centralized AI Configuration
- **Configuration File**: `server/config/ai.ts` centralizes all AI model names and operational constants
- **Model Names**: All AI model references (transcription, analysis, edit planning, image generation, media selection, review) use `AI_CONFIG.models.*`
- **AI Autonomy**: The AI freely decides overlay counts (B-roll windows, AI images, stock queries) based on content analysis - no arbitrary caps or limits
- **Operational Limits**: Only concurrency limits (3 concurrent API calls) and retries (3) remain to prevent API rate limiting
- **Timing**: Reference timing constants for prompt guidance only (not enforced in code)

#### Core AI Capabilities
- **Deep Video Understanding**: Utilizes Gemini API for multi-layer analysis including scene detection, emotion flow, speaker detection, visual importance scoring, and key moment detection.
- **Smart Transcript Analysis**: Multi-provider audio transcription (AssemblyAI primary with native word-level timestamps, OpenAI secondary with synthesized timing, Gemini fallback) with filler word detection, hook analysis, structure analysis, topic flow mapping, and ultra-specific B-roll query generation in multiple languages.
- **Multi-Pass Edit Planning**: An optimized 2-pass intelligent edit system (consolidated Structure+Quality+B-roll Pass, then Quality Review Pass) reduces API calls while generating comprehensive edit plans. Falls back to sequential 4-pass if needed.
- **Transcript-Based Editing**: Allows users to edit video by manipulating an interactive, color-coded transcript with real-time preview, including auto-removal of filler words and manual override for AI suggestions.
- **Additional AI Features**: Includes Karaoke-style captions and AI image generation based on transcript content.
- **Caption Rendering**: ASS format with karaoke-style word-by-word highlighting, phrases grouped 2-3 words respecting segment boundaries.
- **AI Response Normalization**: Centralized module (`server/services/ai/normalization.ts`) ensures robustness against varied AI responses using Zod schema integration and graceful fallbacks.
- **AI Self-Learning System**: Before rendering, AI (Gemini 1.5 Flash) reviews the edit plan, provides confidence scores, quality assessments, and issue detection. User approval/rejection decisions are stored in a PostgreSQL `edit_feedback` table for continuous learning.

### Video Processing Pipeline
1.  **Upload**: Video stored temporarily.
2.  **Analysis**: Frames extracted, analyzed with Gemini Vision.
3.  **Transcription**: Audio extracted and transcribed (AssemblyAI Universal with native word-level timestamps preferred; OpenAI gpt-4o-mini-transcribe with synthesized timing as secondary; Gemini fallback for reliability).
4.  **Planning**: AI generates edit plan using multi-pass system.
5.  **Stock Media**: Fetches media from Pexels.
6.  **AI Images**: Generates custom AI images.
7.  **User Review**: Processing pauses, user can review and edit transcript, approve/reject individual edit actions, select stock media/AI images. Includes a 2-minute auto-accept timer.
8.  **Rendering**: FFmpeg applies approved edits and outputs the final video.

#### User Review System
- **ReviewPanel Component**: Shows transcript, edit plan, and media selections in a tabbed interface.
- **Approval Flow**: User reviews AI decisions before cuts are made.
- **Modification Support**: Users can uncheck items to exclude them.
- **Pre-render Summary**: Shows a clear summary of upcoming actions (cuts, keeps, B-roll, AI images, captions).
- **Cut Warnings**: Red warning box shows exactly which cuts will happen.
- **"Keep Full Video" / "Uncheck All Cuts"**: Quick options for cut management.

#### B-Roll and Transitions
- **B-Roll Implementation**: Supports full-frame overlays with original audio continuity, fade transitions, Ken Burns effect for images, and smart AI image placement.
- **Video Transitions**: Implements crossfade transitions between video segments using FFmpeg's `xfade` filter.
- **Enhanced Media Selection System** (`server/services/ai/mediaSelector.ts`):
  - Uses Gemini 2.5 Flash AI to intelligently select best media for each B-roll window
  - AI sees ALL windows and ALL media at once for globally-optimal selections
  - Selects based on semantic meaning, content match, and viewer experience
  - Strict duplicate prevention ensures each clip is used only once
  - Multi-clip support: longer windows (>6s) can have 2-3 staggered clips
  - Content-aware fallback when AI selection needs backup

#### Performance and Quality
- **Performance Optimizations**: Single-pass FFmpeg rendering, parallel overlay preparation, configurable encoding quality (preview, balanced, quality modes), proxy video generation, parallelized background processing (frame+audio+silence detection, stock fetch+AI image generation), and controlled-concurrency AI image generation with graceful partial-success handling.
- **Chapter Metadata**: Automatic chapter generation embedded in output video.
- **Animation Improvements**: Increased FPS (30), improved transitions (0.5s sine easing), and 5 animation presets (zoom_in, zoom_out, pan_left, pan_right, fade_only).

#### Interactive Transcript
- **Click-to-Seek**: Clickable timestamps in TranscriptEditor.
- **Current Segment Highlighting**: Active segment highlighted during video playback.
- **Dual Edit Modes**: Tabs for AI-assisted editing and manual transcript editing.

#### Data Validation & Integrity
- **Edit Action Validation**: All cut/keep actions are sanitized for timestamp integrity (start < end, non-negative, clamped to video duration).
- **ReviewData Validation**: Render endpoint validates reviewData arrays before processing, prevents crashes from corrupted data.
- **Autosave Validation**: ReviewPanel validates autosave structure before hydrating, falls back to server data if corrupted.
- **Media Asset Preflight**: AI images validated for format/existence, stock downloads wrapped in try-catch with graceful skip.

#### Error Handling & Scalability
- **Error Handling**: User-friendly messages with recovery suggestions.
- **Scalability**: Designed for future integration with background job queues, worker processes, and cloud object storage.
- **Background Processing**: Videos continue processing even if users disconnect. Uses a background processor with job queue and subscriber pattern for real-time SSE updates.
- **Event Replay System**: SSE events include unique IDs for replaying missed events on reconnect.
- **SSE Auto-Reconnection**: If the connection drops during processing or rendering, the client automatically reconnects with exponential backoff (2s, 3s, 4.5s...) up to 5 attempts, fetching current status first to avoid duplicate streams.
- **Stale Processing Recovery**: Detects when processing was interrupted (e.g., server restart) and shows recovery options instead of silently restarting from scratch. Users see what progress was saved and can retry.
- **Persistence & Multi-User Support**: PostgreSQL storage, project history, 1-hour project expiration, max 3 concurrent processing jobs.
- **Error Recovery**: Failed projects show retry/re-run options. Interrupted projects show "staleRecovery" status with clear guidance.
- **Auto-Accept Timer**: 2-minute timer only starts after autosave data has been loaded, preventing premature auto-approval. Uses stable callback refs and deferred execution to prevent race conditions.

#### Reliability Features
- **Circuit Breaker Pattern**: AI services automatically stop retrying after 5 consecutive failures (60s recovery period) to prevent API hammering.
- **Retry with Exponential Backoff**: Stock media downloads and AI API calls use exponential backoff for transient failures.
- **Batch Frame Extraction**: Single-pass FFmpeg extraction with automatic fallback to sequential processing.
- **JSON Parsing Recovery**: Multi-strategy fallback for malformed AI responses (direct parse, array extraction, object-by-object matching).
- **Feedback Learning**: User approval/rejection decisions are persisted to database and used for AI self-improvement across sessions.
- **Natural Caption Phrasing**: Word-level timing uses punctuation and natural language boundaries for better caption readability.
- **Database Transaction Support**: `withTransaction` helper for multi-step database operations with automatic rollback on failure.
- **Stock Media Validation**: Runtime Zod validation for stock media items ensures type safety.
- **Centralized Configuration**: Magic numbers extracted to `AI_CONFIG` (server) and `CLIENT_CONFIG` (client) for maintainability. Stock media per-query limits also in `AI_CONFIG.stockMedia`.
- **Normalization Consolidation**: All AI enum values use centralized normalization functions from `normalization.ts`.
- **Processing Lock System**: Atomic lock acquisition with timestamp tracking and 30-minute stale lock detection prevents race conditions and stuck jobs.
- **Job Cleanup**: Automatic cleanup of completed/failed jobs after 5-minute delay preserves SSE replay capability while preventing memory leaks.
- **Enhanced Edit Planning**: Video analysis data (scenes, emotionFlow, speakers) integrated into edit planning prompts for better AI decision-making.
- **AI Image Selection Priority**: Media selector prompt explicitly prioritizes AI-generated images over stock footage, with enforced minimum usage requirement (at least 50% of generated AI images must be used). Fallback scoring gives AI images +15 bonus vs +3 for videos.
- **AI Image Usage Guardrails**: System logs warnings when AI images are generated but not selected by media selector (0 used or <30% used), enabling detection of selection bias issues.

## External Dependencies

### AI Services
-   **Gemini API**: For video analysis, edit planning, and image generation.
-   **OpenAI API**: For audio transcription and text-to-speech.

### Media Services
-   **Pexels API**: For fetching stock photos and videos.
-   **FFmpeg**: System dependency for all video and audio processing.

### Database
-   **PostgreSQL**: Primary data store.

### Cloud Storage
-   **Google Cloud Storage**: For object storage, integrated via Replit sidecar.