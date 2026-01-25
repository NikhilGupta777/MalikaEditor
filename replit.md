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
- **Video Analysis**: Gemini API for genre, tone, pacing, narrative structure, and topic segmentation.
- **Audio Transcription**: Local whisper.cpp for multilingual speech-to-text with word-level timing, supporting 90+ languages and automatic translation to English for semantic analysis. Fallback to OpenAI.
- **Karaoke-Style Captions**: Generates professional word-by-word animated captions in ASS format using whisper.cpp timings.
- **Semantic Transcript Analysis**: Deep analysis of transcripts to extract topics, tone, keywords, and identify B-roll opportunities with contextual search queries.
- **Edit Plan Generation**: AI-driven context-aware editing plans incorporating genre-specific guidelines, intelligent B-roll placement, and quality heuristics.
- **AI Image Generation**: Uses Gemini 2.5-flash-image to generate custom images based on transcript content, distributed dynamically across the video timeline.

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