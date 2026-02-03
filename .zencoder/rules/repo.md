---
description: Repository Information Overview
alwaysApply: true
---

# AI Video Editor Information

## Summary
The **AI Video Editor** is an advanced AI-powered application designed to automate video post-production workflows. It enables users to transform raw footage into professionally edited videos using natural language prompts. Key features include AI-driven content analysis, multi-provider audio transcription, intelligent multi-pass edit planning, stock media integration (Pexels, Freepik), and custom AI image generation.

## Structure
- **client/**: React 18 frontend built with Vite, TypeScript, and TanStack Query.
- **server/**: Express backend in TypeScript, utilizing FFmpeg for video processing and job orchestration.
- **shared/**: Shared schemas and TypeScript models used by both client and server.
- **migrations/**: Database schema definitions and SQL migration files for PostgreSQL.
- **script/**: Utility scripts for building the application and running migrations.
- **docs/**: Project documentation, including codebase audits and recovery procedures.

## Language & Runtime
**Language**: TypeScript  
**Version**: Node.js 20  
**Build System**: Vite (Frontend), tsx/esbuild (Backend)  
**Package Manager**: npm

## Dependencies
**Main Dependencies**:
- **Backend**: `express`, `drizzle-orm`, `pg`, `fluent-ffmpeg`, `@google/genai`, `openai`, `passport`, `helmet`, `compression`.
- **Frontend**: `react`, `@tanstack/react-query`, `wouter`, `tailwind-merge`, `lucide-react`, `framer-motion`, `radix-ui` components.
- **AI Services**: Gemini (Vision/Analysis), AssemblyAI (Transcription - via direct API), OpenAI (Transcription/Fallback).

**Development Dependencies**:
- `tsx`, `typescript`, `vite`, `drizzle-kit`, `tailwindcss`, `postcss`, `esbuild`.

## Build & Installation
```bash
# Install dependencies
npm install

# Database migrations
npm run db:push
npm run db:migrate

# Development mode
npm run dev

# Production build
npm run build

# Start production server
npm start
```

## Docker

**Dockerfile**: `./Dockerfile`
**Base Image**: `node:20-alpine`
**Configuration**: Installs system-level dependencies for video processing: `ffmpeg`, `python3`, `make`, `g++`.
**Run Command**:
```bash
npx tsx server/index.ts
```

## Main Files & Resources
- **Backend Entry**: [./server/index.ts](./server/index.ts)
- **Frontend Entry**: [./client/src/main.tsx](./client/src/main.tsx)
- **Database Schema**: [./shared/schema.ts](./shared/schema.ts)
- **AI Config**: [./server/config/ai.ts](./server/config/ai.ts)
- **Routes Definition**: [./server/routes.ts](./server/routes.ts)

## Testing
No automated testing frameworks (Jest/Vitest) are currently configured. Verification is performed through manual audits and documented fixes in [./docs/AUDIT_AND_FIXES.md](./docs/AUDIT_AND_FIXES.md).

## Usage & Operations
The application uses a background processing pipeline:
1. **Upload**: Video is stored and analyzed for motion and pacing.
2. **Transcription**: Audio is processed via AssemblyAI/OpenAI.
3. **Planning**: AI generates an edit plan based on user prompts and analysis.
4. **Media Fetch**: Stock media and AI images are gathered.
5. **Review**: Users interact with a color-coded transcript to approve edits.
6. **Render**: FFmpeg generates the final video file.
