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
- **AI Self-Review System (Post-Render)**: AI watches rendered video to evaluate quality metrics, detect issues with timestamps, and provide a quality score.
- **Iterative Correction Loop**: AI generates correction plans for auto-fixable issues (transitions, cuts, B-roll, timing, captions). Maximum 2 render iterations with automatic re-render triggers for critical issues or low scores. Actually re-renders with corrected edit plan and stock media.
- **Self-Review Persistence**: Results stored with project for learning and future reference.
- **AI Learning System**: Stores successful editing patterns from user-approved edits and high-scoring renders. Retrieves relevant patterns for new projects based on video genre/tone similarity. Applies learned preferences to future edit plan generation. In-memory pattern storage with bounded capacity and age-based pruning.

### Video Processing Pipeline
1.  **Upload & Analysis**: Video stored, analyzed by AI (Gemini Vision) for motion, transitions, and pacing.
2.  **Transcription**: Audio extracted and transcribed.
3.  **Planning**: AI generates edit plan using a multi-pass system.
4.  **Media Acquisition**: Fetches stock media from Pexels and Freepik, and generates custom AI images.
5.  **User Review**: User reviews and modifies transcript, approves/rejects edit actions, and selects media. Includes a 2-minute auto-accept timer.
6.  **Rendering**: FFmpeg applies approved edits and outputs the final video.
7.  **Self-Review**: AI watches rendered output, evaluates quality, and reports issues/scores.

### B-Roll and Transitions
- **B-Roll Implementation**: Supports full-frame overlays with original audio continuity, fade transitions, Ken Burns effect, and smart AI image placement.
- **Video Transitions**: Implements crossfade transitions between video segments using FFmpeg's `xfade` filter.
- **Enhanced Media Selection System**: AI visually analyzes stock media thumbnails using Gemini Vision, generates detailed descriptions, and intelligently selects the best media for B-roll windows, ensuring global optimality and strict duplicate prevention.

### Performance and Reliability
- **Performance Optimizations**: Single-pass FFmpeg rendering, parallel overlay preparation, configurable encoding quality, parallelized background processing, and controlled-concurrency AI image generation.
- **Interactive Transcript**: Click-to-seek functionality and current segment highlighting during video playback.
- **Data Validation & Integrity**: All edit actions, review data, and media assets undergo validation to ensure data consistency and prevent errors.
- **Error Handling & Scalability**: User-friendly error messages, background processing with job queues, SSE auto-reconnection, and stale processing recovery.
- **Persistence & Multi-User Support**: PostgreSQL storage, project history, and project expiration.
- **Reliability Features**: Circuit breaker pattern for AI services, retry with exponential backoff, batch frame extraction, JSON parsing recovery for malformed AI responses, and feedback learning from user decisions.
- **Processing Lock System**: Atomic lock acquisition prevents race conditions and ensures job integrity.
- **AI Image Selection Priority**: Explicitly prioritizes AI-generated images over stock footage, with minimum usage requirements and guardrails to detect selection bias.

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
-   **Google Cloud Storage**: For object storage.