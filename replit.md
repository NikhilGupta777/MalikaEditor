# AI Video Editor

## Overview

An AI-powered video editing application that transforms raw footage into professionally edited videos using natural language prompts. Users upload videos, describe their desired edits in plain English, and the system automatically analyzes content, transcribes audio, generates an edit plan, fetches relevant stock media, and produces the final edited video.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: React 18 with TypeScript
- **Routing**: Wouter (lightweight router)
- **State Management**: TanStack React Query for server state
- **UI Components**: shadcn/ui built on Radix UI primitives
- **Styling**: Tailwind CSS with CSS variables for theming (light/dark mode support)
- **Build Tool**: Vite with HMR support

The frontend follows a component-based architecture with:
- Page components in `client/src/pages/`
- Reusable UI components in `client/src/components/`
- shadcn/ui primitives in `client/src/components/ui/`
- Custom hooks in `client/src/hooks/`

### Backend Architecture
- **Runtime**: Node.js with Express
- **Language**: TypeScript (ESM modules)
- **API Structure**: RESTful endpoints under `/api/`
- **File Handling**: Multer for video uploads (up to 1GB)
- **Video Processing**: FFmpeg via fluent-ffmpeg for frame extraction, audio extraction, silence detection, and final rendering

### Data Storage
- **ORM**: Drizzle ORM with PostgreSQL dialect
- **Schema Location**: `shared/schema.ts` for shared types between client and server
- **In-Memory Storage**: `MemStorage` class in `server/storage.ts` provides a fallback storage implementation
- **Database Migrations**: Managed via `drizzle-kit push`

### AI Services (`server/services/aiService.ts`)
- **Video Analysis**: Gemini API with comprehensive context classification
  - Genre detection (tutorial, vlog, interview, spiritual, tech, documentary, etc.)
  - Tone analysis (serious, casual, professional, inspirational, etc.)
  - Pacing assessment (slow, moderate, fast, dynamic)
  - Narrative structure identification (intro, main content, outro, peak moments)
  - Topic segmentation with importance scoring
  - Pre-identified B-roll opportunities with timing and priority
- **Audio Transcription**: Local whisper.cpp for speech-to-text with REAL timestamps
  - Uses multilingual ggml-base model at `/tmp/whisper_models/ggml-base.bin`
  - Supports Hindi, Arabic, Chinese, Japanese, Korean, Russian, and more
  - Zero API cost, no external dependencies
  - Accurate segment timing critical for captions and B-roll placement
  - **Multilingual Pipeline**: Non-English transcripts are automatically detected and translated to English for semantic analysis while preserving original timestamps
  - Fallback to OpenAI if whisper.cpp fails
- **Semantic Transcript Analysis** (NEW): Deep semantic analysis of transcripts for context-aware B-roll
  - Extracts main topics, overall tone, key moments, and extractedKeywords
  - Identifies B-roll windows with specific timestamps and contextual search queries
  - Provides content summary for better edit planning
  - Ensures B-roll queries match ACTUAL transcript content (not generic queries)
- **Edit Plan Generation**: Context-aware AI editing with:
  - Genre-specific editing guidelines (spiritual = calm/minimal, tech = fast-paced, etc.)
  - Intelligent B-roll placement with timing rules (2-6 second duration, 3+ second spacing)
  - Validation to prevent overlapping B-roll actions
  - Context-appropriate stock media search queries derived from transcript semantics
  - Quality heuristics: pacing rules, genre-specific constraints, quality scoring
- **AI Image Generation** (NEW): Fully functional custom image generation
  - Uses Gemini 2.5-flash-image model for cost-effective image generation
  - Images generated from semantic B-roll windows (high/medium priority)
  - Auto-placed at deterministic timestamps from semantic analysis
  - Context-aware prompts derived from transcript content and video context
  - Separate media queue for type integrity (no stock/AI substitution)

### Video Processing Pipeline
1. **Upload**: Video file stored in `/tmp/uploads`
2. **Analysis**: Extract frames, analyze with Gemini vision
3. **Transcription**: Extract audio, transcribe with OpenAI
4. **Planning**: AI generates edit plan based on user prompt
5. **Stock Media**: Fetch relevant images/videos from Pexels API
6. **AI Images** (NEW): Generate custom AI images from semantic B-roll windows
7. **Rendering**: Apply edits with FFmpeg, output to `/tmp/output`

### B-Roll Implementation (Traditional Style)
The B-roll system uses traditional TV/documentary style overlay:
- **Full-frame overlay**: Stock media covers the entire screen during B-roll moments
- **Audio continuity**: Original audio continues playing uninterrupted while B-roll is visible
- **Fade transitions**: 0.3s fade in/out using FFmpeg alpha channel for smooth blending
- **No timeline cuts**: B-roll is overlaid on top of the video at specific timestamps without splicing
- **Ken Burns effect**: Static images get subtle zoom animation for visual interest

Technical implementation:
- `insert_stock` actions in edit plans are visual overlays, not timeline replacements
- Uses `overlay=0:0:eof_action=pass` FFmpeg filter for full-frame compositing
- Audio preserved via `-c:a copy` during overlay phase
- Timing controlled via `setpts` filter for precise positioning

## Recent Changes

### January 2026
- **Multilingual Video Support** (NEW): Full support for non-English videos
  - Whisper.cpp now uses multilingual ggml-base model (supports 90+ languages)
  - Language detection using Unicode script patterns (Hindi, Arabic, Chinese, Japanese, Korean, Russian)
  - Automatic translation of non-English transcripts to English for semantic analysis via Gemini
  - Original timestamps preserved - only text is translated
  - Flow: Whisper (any language) → Detect language → Translate text → Gemini analysis → Overlay with original timestamps
- **Local Whisper.cpp Transcription**: Replaced Gemini/OpenAI transcription with local whisper.cpp
  - Real, accurate timestamps from the whisper model (not estimated)
  - Zero API cost, works offline, no Replit proxy issues
  - Single source of truth for captions, B-roll timing, and AI image placement
- **AI Image Generation**: Fully functional using Gemini 2.5-flash-image model
  - Context-aware image generation from semantic transcript analysis
  - Deterministic placement based on B-roll windows (not edit plan actions)
  - Strict timing validation with detailed error reporting
  - SSE feedback with applied/skipped counts visible in UI
- **Enhanced User Feedback**: Real-time AI image stats in ProcessingStatus component
  - Shows applied/skipped AI images during and after processing
  - Toast notifications include AI image placement summary
- **Strict Validation Pipeline**: 
  - AI image candidates must have valid startTime, endTime, and positive duration
  - Images extending beyond video bounds are skipped with clear warnings
  - Separate media queues for stock and AI content (no cross-type substitution)
- **Semantic Transcript Analysis**: Deep transcript-first workflow (like Opus Clip, Submagic)
  - Extracts keywords, emotions, topics from transcript for intelligent B-roll matching
  - B-roll windows identified based on transcript content, not random frame selection
  - Search queries derived from actual spoken content (e.g., "peaceful meditation mindfulness" not generic "nature")
- **Enhanced Edit Options UI**: Added Transitions toggle and AI Generated Images
- **Improved Edit Planning**: Uses semantic analysis for transcript-aligned B-roll placement
- **Enhanced AI Analysis**: Comprehensive video context understanding with genre, tone, pacing, and narrative structure detection
- **Smart B-Roll Placement**: AI now understands video context (spiritual, tech, tutorial, etc.) and places B-roll intelligently based on content type
- **Topic Segmentation**: Videos are analyzed for distinct topic segments with importance scoring
- **Genre-Specific Editing**: Different editing styles for spiritual content (calm, minimal) vs tech (fast-paced) vs tutorials (instructional focus)
- **B-Roll Validation**: Automatic prevention of overlapping B-roll with proper timing constraints (2-6 second duration, 3+ second spacing)
- Implemented traditional B-roll overlay system with fade effects
- Added upload cancel functionality
- Added real-time video preview during processing
- Path traversal protection for static file serving
- ID parameter validation for API routes
- EventSource cleanup on component unmount

## Scalability Considerations

### Current Architecture Limitations
- **Synchronous Processing**: Video processing runs within the HTTP request lifecycle using SSE for progress updates. For very long videos (>1 hour), this may approach timeout limits.
- **Single Server**: Currently designed for single-server deployment; no distributed job queue.

### Recommended Future Improvements
1. **Background Job Queue**: Implement a Redis-backed job queue (Bull, BullMQ) for FFmpeg processing to handle timeouts gracefully
2. **Worker Processes**: Separate worker processes for CPU-intensive FFmpeg operations
3. **Object Storage**: Move from local `/tmp` storage to cloud object storage for scalability
4. **Caching**: Cache AI analysis results and edit plans for re-processing workflows

### Error Handling Strategy
- **AI Services**: Return fallback values (empty arrays, default semantic analysis) on failure
- **Video Processing**: Propagate structured errors via SSE to the frontend
- **File Operations**: Cleanup temp files in `finally` blocks to prevent disk space issues
- **Validation**: Strict validation at generation and processing stages with detailed console logging

### Replit Integrations (`server/replit_integrations/`)
Pre-built modules for common AI patterns:
- **Audio**: Voice chat with real-time streaming, speech-to-text, text-to-speech
- **Chat**: Conversational AI with Gemini models
- **Image**: Image generation with Gemini
- **Batch**: Rate-limited batch processing utilities
- **Object Storage**: Google Cloud Storage integration with presigned URLs

## External Dependencies

### AI Services
- **Gemini API**: Primary AI for video analysis, edit planning, and image generation (via `AI_INTEGRATIONS_GEMINI_API_KEY` and `AI_INTEGRATIONS_GEMINI_BASE_URL`)
- **OpenAI API**: Audio transcription and text-to-speech (via `AI_INTEGRATIONS_OPENAI_API_KEY` and `AI_INTEGRATIONS_OPENAI_BASE_URL`)

### Media Services
- **Pexels API**: Stock photos and videos (requires `PEXELS_API_KEY`)
- **FFmpeg**: Video/audio processing (system dependency)

### Database
- **PostgreSQL**: Primary database (requires `DATABASE_URL`)

### Cloud Storage
- **Google Cloud Storage**: Object storage for uploaded files (uses Replit sidecar at `http://127.0.0.1:1106` for credentials)

### Environment Variables Required
- `DATABASE_URL` - PostgreSQL connection string
- `AI_INTEGRATIONS_GEMINI_API_KEY` - Gemini API key
- `AI_INTEGRATIONS_GEMINI_BASE_URL` - Gemini API base URL
- `AI_INTEGRATIONS_OPENAI_API_KEY` - OpenAI API key
- `AI_INTEGRATIONS_OPENAI_BASE_URL` - OpenAI API base URL
- `PEXELS_API_KEY` - Pexels stock media API key