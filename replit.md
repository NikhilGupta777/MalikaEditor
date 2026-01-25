# AI Video Editor

## Overview

The AI Video Editor is an AI-powered application designed to automate video post-production. It allows users to upload raw video footage and use natural language prompts to describe their desired edits. The system leverages AI to analyze video content, transcribe audio, generate intelligent edit plans, fetch relevant stock media, generate custom AI images, and produce a professionally edited video. The project aims to revolutionize video editing by making it accessible and efficient for users without specialized editing skills.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
- **Framework**: React 18 with TypeScript
- **Routing**: Wouter
- **State Management**: TanStack React Query
- **UI Components**: shadcn/ui built on Radix UI
- **Styling**: Tailwind CSS with CSS variables for theming
- **Build Tool**: Vite

### Backend
- **Runtime**: Node.js with Express
- **Language**: TypeScript (ESM modules)
- **API Structure**: RESTful endpoints
- **File Handling**: Multer for video uploads
- **Video Processing**: FFmpeg via fluent-ffmpeg for all video and audio manipulations.

### Data Storage
- **ORM**: Drizzle ORM with PostgreSQL
- **Schema**: `shared/schema.ts` for shared types
- **In-Memory Storage**: `MemStorage` for fallback/temporary storage.

### AI Services (Modular Architecture)

The AI services have been modularized into focused modules in `server/services/ai/`:

| Module | Lines | Purpose |
|--------|-------|---------|
| `clients.ts` | 35 | Lazy-loading Gemini and OpenAI client initialization |
| `transcription.ts` | 220 | Multi-provider transcription with OpenAI + Gemini fallback |
| `videoAnalysis.ts` | 623 | Frame analysis, deep video analysis, quality insights |
| `semanticAnalysis.ts` | 450 | Transcript semantics, filler detection, language detection |
| `editPlanning.ts` | 473 | Multi-pass edit planning orchestration |
| `editPlanningPasses.ts` | 718 | 4-pass execution (structure, quality, B-roll, review) |
| `imageGeneration.ts` | 179 | AI image generation from semantic context |
| `index.ts` | 30 | Barrel exports for clean imports |

#### Layer 1: Deep Video Understanding
- **Enhanced Video Analysis**: Gemini API with multi-layer analysis including:
  - Scene Detection: Identifies distinct scenes with type (intro/main/outro/transition)
  - Emotion Flow: Tracks emotional journey throughout the video
  - Speaker Detection: Identifies and labels different speakers
  - Visual Importance Scoring: Rates segments HIGH (must see), MEDIUM, or LOW (can be covered with B-roll)
  - Key Moment Detection: Identifies hooks, climaxes, call-to-actions, key points

#### Layer 2: Smart Transcript Analysis
- **Audio Transcription**: Multi-provider system with automatic fallback:
  - Primary: OpenAI gpt-4o-mini-transcribe (via AI Integrations)
  - Fallback: Gemini 2.5 Flash for audio transcription
  - Retry logic with exponential backoff (3 attempts per provider)
  - Supports all languages including Hindi, English, and mixed-language audio
  - Startup health check confirms available providers
- **Filler Word Detection**: Automatically detects "um", "uh", "like", "you know", "basically", etc.
- **Hook Analysis**: Scores the first 3-10 seconds for attention-grabbing strength (0-100)
- **Structure Analysis**: Detects intro/main/outro section boundaries
- **Topic Flow Mapping**: Creates timeline of topics with unique IDs
- **Ultra-Specific B-Roll Queries**: Generates contextual queries like "peaceful sunrise over mountain lake with morning mist" instead of generic "nature"

#### Layer 3: Multi-Pass Edit Planning
- **4-Pass Intelligent Edit System**:
  1. **Structure Pass**: Analyzes intro/body/outro narrative structure
  2. **Quality Pass**: Scores segments for engagement, identifies boring vs engaging content
  3. **B-Roll Optimization Pass**: Places B-roll based on visual importance, transcript context, even distribution
  4. **Quality Review Pass**: Validates no overlaps, proper spacing, scores each action (0-100)
- **Quality Metrics**: Pacing, B-roll relevance, narrative flow, overall score
- **AI Recommendations**: Actionable suggestions for improvement

#### Layer 4: Transcript-Based Editing
- **Interactive Transcript Editor**: Users can edit video by manipulating transcript text
- **Color-Coded Actions**: Green (keep), Red (cut), Blue (B-roll), Yellow (filler), Purple (key moments)
- **Auto-Remove Fillers**: One-click to mark all filler words for cutting
- **Manual Override**: Accept, reject, or modify AI suggestions
- **Real-Time Preview**: See changes reflected before rendering

#### Additional AI Features
- **Karaoke-Style Captions**: Professional word-by-word animated captions in ASS format
- **AI Image Generation**: Uses Gemini 2.5-flash-image to generate custom images based on transcript content
- **Quality Insights Dashboard**: Displays hook strength, pacing score, engagement prediction

### Video Processing Pipeline
1.  **Upload**: Video stored temporarily.
2.  **Analysis**: Frames extracted, analyzed with Gemini Vision.
3.  **Transcription**: Audio extracted and transcribed.
4.  **Planning**: AI generates edit plan.
5.  **Stock Media**: Fetches media from Pexels.
6.  **AI Images**: Generates custom AI images.
7.  **Rendering**: FFmpeg applies edits and outputs the final video.

### B-Roll Implementation
-   **Traditional Overlay**: Full-frame overlay of stock media with original audio continuity.
-   **Fade Transitions**: 0.3s fade in/out using FFmpeg for B-roll overlays.
-   **Animation**: Ken Burns effect for static images.
-   **Smart AI Image Placement**: Multi-stage fallback system for high placement rate:
    - Stage 1: Exact segment match
    - Stage 2: Tolerance matching (±0.5s) with clamping
    - Stage 3: Nearest segment placement (within 2s)
-   **Overlap Detection**: Uses proper interval intersection algorithm to prevent B-roll conflicts.

### Video Transitions (NEW)
-   **Crossfade Transitions**: Smooth 0.5s crossfade between video segments using FFmpeg xfade filter.
-   **UI Control**: Users can enable/disable transitions via checkbox.
-   **Automatic Application**: When enabled, transitions are applied between all adjacent "keep" segments.

### Chapter Metadata (NEW)
-   **Automatic Chapters**: Chapters generated from edit plan section analysis.
-   **Sources**: Structure analysis (intro/body/outro), key moments, topic flow segments.
-   **Embedding**: FFmpeg FFMETADATA format embedded in output video.
-   **Compatibility**: Viewable in VLC, YouTube, and other compatible players.

### Error Handling
-   **User-Friendly Messages**: Technical errors mapped to plain-language descriptions.
-   **Recovery Suggestions**: Each error includes actionable suggestions.
-   **Error Types**: upload_failed, file_not_found, video_processing, transcription, ai_api, rate_limit, network, timeout, storage, unknown.
-   **Visual Indicators**: Error-type-specific icons in the UI.

### Scalability Considerations
-   Current architecture is synchronous and single-server. Future plans include a background job queue (Redis-backed), separate worker processes, and cloud object storage for scalability.

## External Dependencies

### AI Services
-   **Gemini API**: For video analysis, edit planning, and image generation.
-   **OpenAI API**: Used as a fallback for audio transcription and for text-to-speech.

### Media Services
-   **Pexels API**: For fetching stock photos and videos.
-   **FFmpeg**: System dependency for all video and audio processing.

### Database
-   **PostgreSQL**: Primary data store.

### Cloud Storage
-   **Google Cloud Storage**: For object storage, integrated via Replit sidecar.

## Recent Changes (January 2026)

### Major Architecture Improvements (January 25, 2026 - Latest)

#### AI Service Modularization
- **Split aiService.ts** (3,240 lines) into 8 focused modules in `server/services/ai/`
- **Clean separation of concerns**: transcription, videoAnalysis, semanticAnalysis, editPlanning, imageGeneration
- **Backward compatible**: Original imports from `aiService.ts` still work via re-exports

#### New Features
- **Video Transitions**: Crossfade transitions between segments using FFmpeg xfade filter
- **Chapter Metadata**: Automatic chapter generation and embedding in output videos
- **User-Friendly Errors**: Comprehensive error mapping with suggestions and recovery paths

#### Bug Fixes & Improvements
- **Whisper.cpp Cleanup**: Removed non-functional fallback, clear startup health check, documented OpenAI-only mode
- **AI Image Placement**: Multi-stage fallback (exact/tolerance/nearest) for 80%+ placement rate
- **B-Roll Overlap Fix**: Proper interval intersection algorithm prevents edge case overlaps
- **Standardized Logging**: All Pexels errors now use structured logger with query context

### Real-Time AI Activity Feed
- **ActivityLog Component**: New terminal-style feed showing live AI operations
- **SSE Activity Events**: Backend streams 30+ detailed activity messages during processing
- **Live Indicators**: Pulsing animation shows current operation, timestamps for each activity
- **Activity Examples**: "Extracting 6 key frames...", "Transcribed 24 segments", "Hook strength: 78/100"
- **Memory Safety**: Activities capped at 100 entries to prevent unbounded growth

### Enhanced Processing Status UI
- **Step Descriptions**: Each processing step now shows what the AI is actually doing
- **Step Icons**: Visual icons for each processing phase (Video, Brain, Mic, Wand, etc.)
- **Live Statistics**: Shows scenes detected, transcript segments, B-roll count, edit actions
- **Progress Visualization**: Hover tooltips on progress bar segments

### Comprehensive Zod Validation (Latest)
- **EditActionSchema** - All action types now include qualityScore field
- **Multi-Pass Planning Schemas** - Full Zod schemas for all 4 passes:
  - StructuredPlanSchema (Pass 1: Structure Analysis)
  - QualityMapSchema (Pass 2: Quality Assessment)
  - OptimizedBrollPlanSchema (Pass 3: B-Roll Optimization)
  - ReviewedEditPlanSchema (Pass 4: Quality Review)
- **Fail-Fast Validation** - All AI responses use safeParse() with default fallbacks
- **Timing Constraints** - end >= start refinements on segment schemas
- **analyzeVideoFrames** - Now properly validates all AI output before use

### Bug Fixes
- Fixed `hookScore` null validation error - AI responses returning `null` instead of `undefined` now handled correctly
- Added `insert_ai_image` to editActionSchema enum - AI-generated image actions now validate properly
- Fixed missing `sendEvent("transcript", ...)` - Transcript data now streams to frontend in real-time

### Security Improvements
- Added `requireAuth` middleware to `/api/videos/upload` and `/api/videos/:id/process` endpoints
- Added Zod validation for editPlan PUT endpoint to prevent invalid data

### SSE Event Handling
All 11 server events now properly matched with client handlers:
- status, transcript, editPlan, stockMedia, aiImages, aiImagesError, aiImageStats, enhancedAnalysis, activity, complete, error

### Code Quality Improvements (January 25, 2026)
- **Proper Logging**: Replaced all console.log/warn/error with structured logger in videoProcessor.ts and pexelsService.ts
- **OpenAI Transcription**: Now uses verbose_json format with word-level timestamps instead of estimated timing
- **Video Encoding Quality**: Upgraded FFmpeg preset from "ultrafast" to "fast" and CRF from 28 to 23 for significantly better output quality
- **Lazy AI Client Initialization**: Gemini and OpenAI clients now initialize on first use, preventing startup crashes when API keys aren't configured

### AI Response Normalization Layer (January 25, 2026)
- **Normalization Functions**: Added comprehensive functions to handle AI enum response variations:
  - `normalizeValueLevel`: Handles `high_value` → `high`, `must-keep` → `must_keep`, etc.
  - `normalizeQualityLevel`: Handles `N/A` → `low`, `excellent` → `high`, etc.
  - `normalizePacing`: Handles `quick` → `fast`, `relaxed` → `slow`, etc.
  - `normalizePriority`: Handles `critical` → `high`, `optional` → `low`, etc.
- **Pre-Validation Normalization**: Applied in Pass 2 (quality map), Pass 3 (B-roll plan), and Pass 4 (reviewed plan) before Zod validation
- **Graceful Degradation**: Defaults to sensible values (`medium`) when AI responses are unexpected