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

### AI Services

#### Layer 1: Deep Video Understanding
- **Enhanced Video Analysis**: Gemini API with multi-layer analysis including:
  - Scene Detection: Identifies distinct scenes with type (intro/main/outro/transition)
  - Emotion Flow: Tracks emotional journey throughout the video
  - Speaker Detection: Identifies and labels different speakers
  - Visual Importance Scoring: Rates segments HIGH (must see), MEDIUM, or LOW (can be covered with B-roll)
  - Key Moment Detection: Identifies hooks, climaxes, call-to-actions, key points

#### Layer 2: Smart Transcript Analysis
- **Audio Transcription**: Local whisper.cpp for multilingual speech-to-text with word-level timing, supporting 90+ languages and automatic translation to English for semantic analysis. Fallback to OpenAI.
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
-   **Transitions**: 0.3s fade in/out using FFmpeg.
-   **Animation**: Ken Burns effect for static images.

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

### Real-Time AI Activity Feed (Latest)
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