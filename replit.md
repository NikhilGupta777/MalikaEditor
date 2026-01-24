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
- **Audio Transcription**: OpenAI Whisper for speech-to-text with timestamps
- **Edit Plan Generation**: Context-aware AI editing with:
  - Genre-specific editing guidelines (spiritual = calm/minimal, tech = fast-paced, etc.)
  - Intelligent B-roll placement with timing rules (2-6 second duration, 2+ second spacing)
  - Validation to prevent overlapping B-roll actions
  - Context-appropriate stock media search queries

### Video Processing Pipeline
1. **Upload**: Video file stored in `/tmp/uploads`
2. **Analysis**: Extract frames, analyze with Gemini vision
3. **Transcription**: Extract audio, transcribe with OpenAI
4. **Planning**: AI generates edit plan based on user prompt
5. **Stock Media**: Fetch relevant images/videos from Pexels API
6. **Rendering**: Apply edits with FFmpeg, output to `/tmp/output`

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
- **Enhanced AI Analysis**: Comprehensive video context understanding with genre, tone, pacing, and narrative structure detection
- **Smart B-Roll Placement**: AI now understands video context (spiritual, tech, tutorial, etc.) and places B-roll intelligently based on content type
- **Topic Segmentation**: Videos are analyzed for distinct topic segments with importance scoring
- **Genre-Specific Editing**: Different editing styles for spiritual content (calm, minimal) vs tech (fast-paced) vs tutorials (instructional focus)
- **B-Roll Validation**: Automatic prevention of overlapping B-roll with proper timing constraints (2-6 second duration, 2+ second spacing)
- Implemented traditional B-roll overlay system with fade effects
- Added upload cancel functionality
- Added real-time video preview during processing
- Path traversal protection for static file serving
- ID parameter validation for API routes
- EventSource cleanup on component unmount

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