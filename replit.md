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
3.  **Transcription**: Audio extracted and transcribed.
4.  **Planning**: AI generates edit plan.
5.  **Stock Media**: Fetches media from Pexels.
6.  **AI Images**: Generates custom AI images.
7.  **Rendering**: FFmpeg applies edits and outputs the final video.

#### B-Roll and Transitions
- **B-Roll Implementation**: Supports full-frame overlays with original audio continuity, fade transitions, Ken Burns effect for images, and smart AI image placement with overlap detection.
- **Video Transitions**: Implements crossfade transitions between video segments using FFmpeg's `xfade` filter, controllable via UI.

#### Performance and Quality
- **Performance Optimizations**: Features single-pass FFmpeg rendering, parallel overlay preparation, configurable encoding quality (preview, balanced, quality modes), and proxy video generation.
- **Chapter Metadata**: Automatic chapter generation from edit plan analysis, embedded in output video for improved navigability.

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