# AI Video Editor

## Overview

The AI Video Editor is an AI-powered application designed to automate video post-production. It allows users to upload raw video footage and use natural language prompts to describe their desired edits. The system leverages AI to analyze video content, transcribe audio, generate intelligent edit plans, fetch relevant stock media, generate custom AI images, and produce a professionally edited video. The project aims to revolutionize video editing by making it accessible and efficient for users without specialized editing skills, offering a unique solution for content creators, marketers, and businesses seeking efficient video production.

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

### AI Services (Modular Architecture)
The AI services are modularized into focused modules for transcription, video analysis, semantic analysis, edit planning, and image generation.

#### Core AI Capabilities
- **Deep Video Understanding**: Utilizes Gemini API for multi-layer analysis including scene detection, emotion flow, speaker detection, visual importance scoring, and key moment detection.
- **Smart Transcript Analysis**: Multi-provider audio transcription (OpenAI primary, Gemini fallback) with filler word detection, hook analysis, structure analysis, topic flow mapping, and ultra-specific B-roll query generation. Supports multiple languages.
- **Multi-Pass Edit Planning**: A 4-pass intelligent edit system comprising Structure Pass, Quality Pass, B-Roll Optimization Pass, and Quality Review Pass to generate comprehensive edit plans.
- **Transcript-Based Editing**: Allows users to edit video by manipulating an interactive, color-coded transcript with real-time preview, including auto-removal of filler words and manual override for AI suggestions.
- **Additional AI Features**: Includes Karaoke-style captions, AI image generation based on transcript content, and a Quality Insights Dashboard for performance metrics.

### Video Processing Pipeline
1.  **Upload**: Video stored temporarily.
2.  **Analysis**: Frames extracted, analyzed with Gemini Vision.
3.  **Transcription**: Audio extracted and transcribed with synthesized word-level timing.
4.  **Planning**: AI generates edit plan using multi-pass system.
5.  **Stock Media**: Fetches media from Pexels.
6.  **AI Images**: Generates custom AI images.
7.  **User Review** (NEW): Processing pauses with status `awaiting_review`. User can:
    - Review and edit the transcript
    - Approve or reject individual edit actions (cuts, keeps, b-roll insertions)
    - Select which stock media and AI images to include
    - Approve and proceed to rendering, or cancel and re-process
8.  **Rendering**: FFmpeg applies approved edits and outputs the final video.

#### User Review System
- **ReviewPanel Component**: Shows transcript, edit plan, and media selections in tabbed interface
- **Approval Flow**: User reviews AI decisions before any cuts are made
- **Modification Support**: Users can uncheck items to exclude them from the final video
- **API Endpoints**:
  - `GET /api/videos/:id/review` - Get review data
  - `POST /api/videos/:id/approve-review` - Approve and save modifications
  - `GET /api/videos/:id/render` - Start rendering after approval (SSE)

#### B-Roll and Transitions
- **B-Roll Implementation**: Supports full-frame overlays with original audio continuity, fade transitions, Ken Burns effect for images, and smart AI image placement with overlap detection.
- **Video Transitions**: Implements crossfade transitions between video segments using FFmpeg's `xfade` filter, controllable via UI.

#### Performance and Quality
- **Performance Optimizations**: Features single-pass FFmpeg rendering, parallel overlay preparation, configurable encoding quality (preview, balanced, quality modes), and proxy video generation.
- **Quality Mode Selector**: UI dropdown in render panel allows users to select encoding quality (preview for fast testing, balanced for typical use, quality for final exports).
- **Chapter Metadata**: Automatic chapter generation from edit plan analysis, embedded in output video for improved navigability.

#### Interactive Transcript
- **Click-to-Seek**: Clickable timestamps in TranscriptEditor that seek video preview to segment start time.
- **Current Segment Highlighting**: Active segment highlighted with visual indicator based on video playback position.
- **Dual Edit Modes**: Tabs for AI-assisted editing (ReviewPanel) and manual transcript editing (TranscriptEditor).

#### Error Handling & Scalability
- **Error Handling**: Provides user-friendly messages with recovery suggestions, mapped to specific error types and visualized with UI icons.
- **Scalability**: Designed for future integration with background job queues, worker processes, and cloud object storage.

### AI Response Normalization System
A centralized normalization module (`server/services/ai/normalization.ts`) ensures robustness against varied AI responses by normalizing diverse values (e.g., priority, narrative arc, section type, tone, pacing, edit style, and more) using Zod schema integration, first-word extraction, capitalization handling, synonym mapping, and graceful fallbacks.

## External Dependencies

### AI Services
-   **Gemini API**: For video analysis, edit planning, and image generation.
-   **OpenAI API**: For audio transcription (primary) and text-to-speech.

### Media Services
-   **Pexels API**: For fetching stock photos and videos.
-   **FFmpeg**: System dependency for all video and audio processing.

### Database
-   **PostgreSQL**: Primary data store.

### Cloud Storage
-   **Google Cloud Storage**: For object storage, integrated via Replit sidecar.

## Recent Changes (January 2026)

### Security Updates
- Removed hardcoded credentials from source code
- Admin user credentials now configured via environment variables:
  - `DEFAULT_ADMIN_USERNAME`: Username for auto-created admin account
  - `DEFAULT_ADMIN_PASSWORD`: Password for auto-created admin account
- Session secret validation strengthened for production environments

### Bug Fixes
- Fixed TypeScript compilation error with Map iteration (using `Array.from()`)
- Added missing `reviewData` field to VideoProject creation in MemStorage
- Added reviewData schema validation in storage layer

### Transcription & Caption Pipeline Improvements
- Fixed transcription timing: No longer defaults to incorrect 60-second duration when actual duration is unavailable
- Improved karaoke caption accuracy: Word timings are now properly clamped to caption boundaries
- Fixed phrase grouping: Phrases no longer cross caption/segment boundaries after video edits
- Added silent audio detection: Pre-checks audio levels before transcription with user feedback
- Improved empty transcription handling: Gracefully disables captions when no speech is detected
- Fixed word timing mapping: Properly maps word timings from source to output timeline during video edits

### New Features
- Added file magic byte validation for video uploads (validates actual file content, not just MIME type)
- Added SSE reconnection hook for frontend with exponential backoff (client/src/hooks/useSSE.ts)
- Health check endpoint available at `/api/health`
- Improved SSE disconnect handling with proper abort controllers and resource cleanup
- **2-minute auto-accept timer**: Review stage now has a countdown timer that auto-approves after 2 minutes of inactivity. Timer resets when user makes changes, giving them another 2-minute window.
- **Pre-render summary**: ReviewPanel now shows a clear summary of what will happen (approved cuts, keeps, B-roll, AI images, captions) before rendering.

### User Review Flow Improvements
- Fixed unauthorized cutting issue: Backend now only applies cuts when user explicitly approves them
- Original `editOptions` (captions, remove silence, etc.) are now stored in `reviewData` and used during rendering
- Detailed activity logging shows exactly what edit actions are being applied during rendering
- Summary shows excluded transcript segments and no-cuts messaging when user unchecks all cuts
- **Prominent cut warning**: Red warning box shows exactly which cuts will happen and how much video will be removed
- **"Keep Full Video" button**: One-click option to disable all cuts and preserve original video length
- **"Uncheck All Cuts" toggle**: Quick toggle in Edit Plan tab to enable/disable all cuts at once
- **Enhanced logging**: Backend logs exactly which cuts were approved/rejected for debugging

### Persistence & Multi-User Support
- **PostgreSQL Storage**: Migrated from in-memory to persistent PostgreSQL database storage via DatabaseStorage class
- **Project History Panel**: Users can view past projects with status badges, expiration time, and quick actions (view/delete)
- **1-Hour Project Expiration**: Projects automatically expire and are cleaned up after 1 hour; periodic cleanup runs every 10 minutes
- **Max 3 Concurrent Processing Jobs**: System limits concurrent video processing to 3 jobs to prevent resource exhaustion
- **Autosave for Reviews**: User modifications in the review panel are automatically saved (debounced) and restored if they leave and return
- **Asset Caching**: New `cachedAssets` table stores stock media and AI images for reuse across projects
- **Error Recovery**: Failed projects show recovery buttons (Retry Processing, Re-run Transcription, Upload New Video)

### AI Improvements
- **Transcription**: Added language hint support, improved sentence grouping for natural segment breaks, better handling of background noise
- **Edit Planning**: Dynamic pacing guidance based on video duration (short/medium/long), mid-sentence cut prevention, content-type specific rules (tutorial vs entertainment)
- **B-Roll Queries**: Improved query generation with action verbs + specific subjects, negative examples to avoid generic queries, topic context awareness

## Environment Variables

### Required for Authentication
- `SESSION_SECRET`: Secret key for session encryption (required in production)
- `DEFAULT_ADMIN_USERNAME`: Username for initial admin account
- `DEFAULT_ADMIN_PASSWORD`: Password for initial admin account

### AI Services (via Replit Integrations)
- `AI_INTEGRATIONS_OPENAI_API_KEY`: OpenAI API key (for transcription)
- `AI_INTEGRATIONS_GEMINI_API_KEY`: Gemini API key (for video analysis)

### Media Services
- `PEXELS_API_KEY`: Pexels API key for stock media