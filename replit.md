# AI Video Editor

## Overview

The AI Video Editor is an AI-powered application designed to automate video post-production. It allows users to upload raw video footage and use natural language prompts to describe desired edits. The system leverages AI for video content analysis, audio transcription, intelligent edit plan generation, stock media fetching, custom AI image generation, and produces a professionally edited video. This project aims to make video editing accessible and efficient for content creators, marketers, and businesses by revolutionizing traditional post-production workflows.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
- **Framework**: React 18 with TypeScript
- **State Management**: TanStack React Query
- **UI Components**: shadcn/ui built on Radix UI with Tailwind CSS for styling

### Backend
- **Runtime**: Node.js with Express
- **Language**: TypeScript
- **Video Processing**: FFmpeg via `fluent-ffmpeg` for all video and audio manipulations.

### Data Storage
- **ORM**: Drizzle ORM with PostgreSQL
- **Asset Caching**: `cachedAssets` table stores stock media and AI images for reuse.
- **Autosave**: User modifications in the review panel are automatically saved and restored.

### AI Services
The AI services are modularized for transcription, video analysis, semantic analysis, edit planning, and image generation.
- **Centralized AI Configuration**: `server/config/ai.ts` centralizes all AI model names and operational constants.
- **Deep Video Understanding**: Utilizes Gemini API for multi-layer analysis including scene detection, emotion flow, speaker detection, visual importance scoring, and key moment detection.
- **Smart Transcript Analysis**: Multi-provider audio transcription (AssemblyAI primary, OpenAI secondary, Gemini fallback) with filler word detection, hook analysis, structure analysis, topic flow mapping, and B-roll query generation.
- **AssemblyAI Enhanced Features**: Speaker Diarization, Auto Chapters, Sentiment Analysis, and Entity Detection are enabled when AssemblyAI is primary.
- **Multi-Pass Edit Planning**: An optimized 2-pass intelligent edit system generates comprehensive edit plans, falling back to a sequential 4-pass if needed.
- **Transcript-Based Editing**: Allows users to edit video by manipulating an interactive, color-coded transcript with real-time preview, including auto-removal of filler words.
- **AI Response Normalization**: Centralized module (`server/services/ai/normalization.ts`) ensures robustness against varied AI responses using Zod schema integration.
- **AI Self-Learning System**: Before rendering, AI (Gemini 1.5 Flash) reviews the edit plan, provides confidence scores, quality assessments, and issue detection. User feedback is stored for continuous learning.
- **Full Video Watching (Advanced Analysis)**: AI uploads and analyzes entire videos (not just frames) for motion, transition, audio-visual sync, and pacing analysis. Graceful fallback to frame extraction if video upload fails.
- **Enhanced Analysis Integration**: Motion/pacing/transition data flows through entire pipeline - edit planning uses motion intensity for cut frequency, media selector prefers video during high-motion scenes and adjusts B-roll duration based on pacing, post-render review compares output against original motion profile, and learning system stores motion/pacing context for pattern matching.
- **AI Self-Review System (Post-Render)**: AI watches rendered video to evaluate quality metrics, detect issues with timestamps, and provide a quality score.
- **Pre-Render Transcript Correction**: Before rendering, AI proofreads transcript segments for spelling errors, inconsistent proper nouns, and speech-to-text mistakes, correcting them in-place.
- **Iterative Correction Loop**: AI generates correction plans for auto-fixable issues (transitions, cuts, B-roll, timing, captions). Maximum 2 render iterations with automatic re-render triggers for ANY auto-fixable issues (not just critical). Actually re-renders with corrected edit plan, stock media, and transcript.
- **Self-Review Persistence**: Results stored with project for learning and future reference.
- **AI Learning System**: Disconnected — learning pattern imports/calls removed from edit planning pipeline. Table/migration preserved but system is inactive.
- **AI Chat Companion**: Real-time conversational guide that provides explanations throughout the video editing pipeline. Sends automatic updates at each processing stage (upload, transcription, analysis, planning, media fetching, review ready, rendering, self-review, corrections, completion). Users can ask questions about the current state, AI decisions, and get contextual guidance. Uses Gemini AI for intelligent question answering with full project context including stock media data. Non-blocking design doesn't interfere with autonomous processing.
- **Re-Edit System**: Users can request changes to completed edits via the chat companion. The AI detects change requests, proposes a plan with a "Proposed Changes" card, and on user confirmation triggers a re-edit that resumes processing from the planning stage. The pipeline uses `shouldSkipStage` to skip transcription and analysis during re-edits (loading existing data from DB), and the user's re-edit instructions are passed directly to the consolidated analysis and B-roll optimization AI prompts so the new edit plan reflects the requested changes.

### Video Processing Pipeline
1.  **Upload & Analysis**: Video stored, analyzed by AI (Gemini Vision) for motion, transitions, and pacing.
2.  **Transcription**: Audio extracted and transcribed.
3.  **Planning**: AI generates edit plan using a multi-pass system.
4.  **Media Acquisition**: Fetches stock media from Pexels and Freepik, and generates custom AI images.
5.  **User Review**: User reviews and modifies transcript, approves/rejects edit actions, and selects media. Includes a 2-minute auto-accept timer.
6.  **Rendering**: FFmpeg applies approved edits and outputs the final video.
7.  **Self-Review**: AI watches rendered output, evaluates quality, and reports issues/scores.

### B-Roll and Transitions
- **B-Roll Implementation**: Supports full-frame overlays with original audio continuity, context-aware fade transitions, per-clip animation presets (fade_only, zoom_in, zoom_out, pan_left, pan_right), and smart AI image placement.
- **AI Animation Control**: AI planner chooses animation preset per B-roll clip based on content type. Default is `fade_only` (gentle hold). No artificial duration caps — AI's planned durations are respected (0.5–30s safety bounds only).
- **Context-Aware Transitions**: Per-boundary transition types (fade default, wipeleft at major section breaks where source gap > 8s and > 3× median gap). Transition durations scale with segment length (0.2–0.7s).
- **Context-Aware B-Roll Fading**: Overlay fade-in/out durations scale with clip length: 0.15s for clips <2s, 0.25s for 2-4s, 0.4s for 4-8s, 0.6s for >8s.
- **Video Transitions**: Implements crossfade and wipeleft transitions between video segments using FFmpeg's `xfade` filter. Supports fade, wipeleft, wiperight, wipeup, wipedown, slideleft, slideright, circleopen, circleclose.
- **Enhanced Media Selection System**: AI visually analyzes stock media thumbnails using batched Gemini Vision calls (5 thumbnails per call instead of individual), generates detailed descriptions, and intelligently selects the best media for B-roll windows with no source bias, ensuring global optimality and strict duplicate prevention.

### Performance and Reliability
- **Performance Optimizations**: Single-pass FFmpeg rendering, parallel overlay preparation, configurable encoding quality, parallelized background processing, and controlled-concurrency AI image generation.
- **Interactive Transcript**: Click-to-seek functionality and current segment highlighting during video playback.
- **Data Validation & Integrity**: All edit actions, review data, and media assets undergo validation to ensure data consistency and prevent errors.
- **Error Handling & Scalability**: User-friendly error messages, background processing with job queues, SSE auto-reconnection, and stale processing recovery.
- **Persistence & Multi-User Support**: PostgreSQL storage, project history, and project expiration.
- **Reliability Features**: Circuit breaker pattern for AI services, retry with exponential backoff, batch frame extraction, JSON parsing recovery for malformed AI responses, and feedback learning from user decisions. Circuit breaker explicitly exempts HTTP 429 rate-limit errors — a throttled service stays "available" and does not trip the breaker.
- **Processing Lock System**: Atomic lock acquisition prevents race conditions and ensures job integrity.
- **AI Image Selection (No Source Bias)**: The media selector treats AI-generated images and stock media equally — the AI model picks purely on content quality and visual match. No source-type preference is applied in prefiltering, fallback scoring, or the AI selection prompt. The only meaningful distinction is video (has motion) vs still image (no motion) for motion-heavy windows.
- **Resumable Processing with Database Checkpoints**: Processing jobs persist across server restarts via database-persisted checkpoints. The `processingStage` field tracks pipeline progress (upload, transcription, analysis, planning, media_fetch, media_selection, review_ready). On server startup, `recoverInterruptedJobs` automatically detects interrupted projects and resumes from the last completed checkpoint without redoing work.

## External Dependencies

### AI Services
-   **Gemini API**: For video analysis, edit planning, and image generation.
-   **OpenAI API**: For audio transcription.

### Media Services
-   **Pexels API**: Primary stock library for photos and videos.
-   **Freepik API**: Premium stock library for creative assets.
-   **FFmpeg**: System dependency for all video and audio processing.

### Database
-   **PostgreSQL**: Primary data store.

### Cloud Storage
-   **AWS S3**: For object storage (bucket: `malikaeditor`, region: `us-east-1`).