# Codebase Audit and Fixes

## Overview

End-to-end audit of the AI video-editing workflow from upload to final render, covering server logic, background processor, AI services, storage, and client. This document summarizes **findings**, **root causes**, and **implemented fixes**. (No API rate limiting or authorization changes were made per requirement.)

---

## PHASE 2 AUDIT (Exhaustive Deep Dive) – Additional Findings

### 7. Path Configuration Inconsistency (CRITICAL)

**Finding:** Three different modules define UPLOADS_DIR/OUTPUT_DIR independently:
- `server/config/paths.ts` – Centralized config, respects `UPLOADS_PATH` env
- `server/services/videoProcessor.ts` – Hardcodes `os.tmpdir()`, ignores env
- `server/services/backgroundProcessor.ts` – Hardcodes `os.tmpdir()`, ignores env

**Impact:** In production with persistent storage (e.g. `UPLOADS_PATH=/mnt/storage`), uploads and outputs would go to system temp instead of the configured path. Background processor would look for videos in a different location than where routes save them.

**Fix:** Import centralized paths from `server/config/paths.ts` in both videoProcessor and backgroundProcessor.

### 8. Retry Route Ignores Stage Parameter

**Finding:** `POST /api/videos/:id/retry` accepts `{ stage: 'transcription' | 'analysis' | 'planning' | 'stock' | 'ai_images' | 'full' }` but only resets status to "pending" and returns. The stage is never passed to the processing pipeline. When the user starts processing again, the pipeline runs from the beginning.

**Impact:** Stage-specific retry is non-functional. Users cannot resume from a failed stage without re-running the entire pipeline.

**Fix:** Implement stage-aware retry: map retry stage to ProcessingStage, export `retryProcessingFromStage` from backgroundProcessor, and have the retry route trigger it (or set processingStage so the next process call resumes correctly).

### 9. runBackgroundRender Uses Wrong Analysis Path for Self-Review

**Finding:** In `runBackgroundRender`, self-review is called with `(project.analysis as any)?.videoAnalysis`. But `project.analysis` is stored as a flattened VideoAnalysis (from backgroundProcessor sanitizedAnalysis) – there is no nested `videoAnalysis` property. The correct structure is `project.analysis` itself (it is the VideoAnalysis).

**Impact:** Self-review in background render receives `undefined` for video analysis, degrading AI quality assessment.

**Fix:** Pass `project.analysis` directly as VideoAnalysis (it is already flattened).

### 10. videoProcessor cleanupTempFilesSync Bug

**Finding:** `cleanupTempFilesSync` calls `fs.unlink(p)` on all paths. Frame extraction pushes directory paths (`path.dirname(framePaths[0])`). `fs.unlink` on a directory fails with EISDIR. Also, `fs.unlink` is async but the function does not await – cleanup is fire-and-forget.

**Fix:** Use `fs.rmSync(p, { recursive: true, force: true })` to handle both files and directories, and run synchronously in the timeout callback.

### 11. storage.createVideoProject Omits Optional Fields

**Finding:** `createVideoProject` does not set `processingStage` or `transcriptEnhanced` on insert. These are optional but helpful for new projects. `processingStage: 'upload'` would make checkpoint/resume logic clearer for brand-new projects.

**Fix:** Set `processingStage: 'upload'` (or null) and leave transcriptEnhanced null – schema allows it. Minimal change for consistency.

### 12. EDIT PLAN actions type mismatch

**Finding:** In `backgroundProcessor.ts` line 548, filter checks for `a.type === 'add_broll'` but schema has `insert_stock` and `insert_ai_image`. `add_broll` is not a valid EditAction type in shared schema. This would never match.

**Fix:** Remove `add_broll` from the filter – only `insert_stock` and `insert_ai_image` are valid.

### 13. Autonomous Mode videoAnalysis Path

**Finding:** In autonomous pipeline self-review (backgroundProcessor ~line 815), `(project.analysis as { videoAnalysis?: unknown })?.videoAnalysis` is passed. Same issue as #9 – analysis is flattened, no nested videoAnalysis.

**Fix:** Pass `project.analysis` directly as VideoAnalysis.

---

## 1. Recovery & Job State

### 1.1 recoverInterruptedJobs used invalid statuses

**Finding:** `inProgressStatuses` included `"processing"`, which is not a value in `projectStatusEnum`. Actual DB statuses are `uploading`, `analyzing`, `transcribing`, `planning`, `fetching_stock`, `generating_ai_images`, `editing`, `rendering`.

**Impact:** Projects in `fetching_stock`, `generating_ai_images`, or `editing` after a restart were not recovered.

**Fix:** Replaced with the full set of in-progress statuses and skipped terminal/user-waiting states (`awaiting_review`, `completed`, `failed`, `cancelled`, and `processingStage === "review_ready" | "complete"`).

**Files:** `server/services/backgroundProcessor.ts`

### 1.2 Resuming from review_ready / complete

**Finding:** When `processingStage` was `"review_ready"`, `determineResumeStage` returned the next stage `"complete"`. The pipeline would then skip all stages and rebuild review data. Recovering jobs that were already at review was redundant and could be confusing.

**Fix:**  
- In `determineResumeStage`, if stage is `review_ready`, `rendering`, or `complete`, return that stage (no “next” stage).  
- In `recoverInterruptedJobs`, skip calling `resumeProcessing` when the resolved stage is `review_ready` or `complete` (user action required).

**Files:** `server/services/backgroundProcessor.ts`

### 1.3 stageOrder inconsistency

**Finding:** `determineResumeStage` used a `stageOrder` without `"rendering"`, while `shouldSkipStage` used one with `"rendering"`. Schema `processingStageEnum` includes `"rendering"`.

**Fix:** Use a single `stageOrder`: `["upload", "transcription", "analysis", "planning", "media_fetch", "media_selection", "review_ready", "rendering", "complete"]` in `determineResumeStage`.

**Files:** `server/services/backgroundProcessor.ts`

---

## 2. AI Data Flow & Edit Planning

### 2.1 Filler segments not passed to edit plan

**Finding:** In `runProcessingPipeline`, `fillerSegments` was always `[]` when calling `generateSmartEditPlan`. Filler-word data from semantic analysis (or `detectFillerWords`) was never used for planning.

**Impact:** Edit plan and downstream logic did not use filler detection for cuts/decisions.

**Fix:** Set  
`fillerSegments = sanitizedAnalysis.semanticAnalysis?.fillerSegments ?? detectFillerWords(transcript)`  
and pass this into `generateSmartEditPlan`. Import `detectFillerWords` from `./ai`.

**Files:** `server/services/backgroundProcessor.ts`

### 2.2 enhancedAnalysis event sent empty fillerSegments

**Finding:** `notifySubscribers(projectId, "enhancedAnalysis", { ... fillerSegments: [] })` always sent an empty array.

**Fix:** Send actual filler segments:  
`analysis.semanticAnalysis?.fillerSegments ?? detectFillerWords(transcript)`.

**Files:** `server/services/backgroundProcessor.ts`

---

## 3. Client SSE & Reconnection

### 3.1 useProcessSSE sessionKey not applied per connection

**Finding:** `useProcessSSE` passes `sessionKey` into `useSSE` only at hook init; at that time `currentProjectIdRef.current` is often null, so `sessionKey` was undefined. Reconnect and lastEventId persistence were not tied to the current project.

**Fix:**  
- **useSSE:** Support an optional per-connection `sessionKey` via `connect(url, options?: { sessionKey?: string })`. When provided, use it for reading/writing `lastEventId` in sessionStorage and store it in `connectionSessionKeyRef`.  
- **useProcessSSE:** Call `sse.connect(url, { sessionKey: getSessionKey(projectId) })` in `startProcess` so each connection uses the correct project key (`process_<id>`).

**Files:** `client/src/hooks/useSSE.ts`, `client/src/hooks/useProcessSSE.ts`

### 3.2 clearStoredEventId by key

**Finding:** `useProcessSSE.clearStoredEventId(projectId)` cleared storage using its own key construction; the underlying `useSSE` did not accept a key, so clearing could be inconsistent.

**Fix:** `useSSE.clearStoredEventId(key?: string)` now accepts an optional key. `useProcessSSE.clearStoredEventId(projectId)` calls `sse.clearStoredEventId(getSessionKey(projectId))`.

**Files:** `client/src/hooks/useSSE.ts`, `client/src/hooks/useProcessSSE.ts`

---

## 4. Media Selector

### 4.1 Typo in thumbnail analysis

**Finding:** Function name typo: `analyzeThumbailWithVision` (missing “n”).

**Fix:** Renamed to `analyzeThumbnailWithVision` (definition and call site).

**Files:** `server/services/ai/mediaSelector.ts`

---

## 5. Not Changed (By Design)

- **Editor.tsx:** Still uses raw `EventSource` for the process SSE flow. `useProcessSSE` is available and now correct for sessionKey/clearStoredEventId; refactoring Editor to use it would reduce duplication but was not required for this audit.
- **Rate limiting / auth:** Not implemented per your requirement (1–3 users only).
- **transcriptEnhanced on create:** Left optional; it is set after transcription, not at project create.
- **StockMediaItem extra fields:** `id`, `width`, `height` in backgroundProcessor are not in the shared schema but are allowed as extra JSON; no change.

---

## 6. Architecture Notes (No Code Change)

- **Pipeline flow:** Upload → transcription → analysis → planning → media_fetch (Pexels/Freepik + AI images in parallel) → media_selection → review_ready → (user approve) → render (SSE or background). Recovery uses `processingStage` and DB status correctly after fixes.
- **Rendering:** Can be started from `/api/videos/:id/approve-review` (background) or `/api/videos/:id/render` (SSE). Duplicate render is prevented by `activeRenderJobs` and reconnect/polling when status is already `rendering`.
- **AI outputs:** Edit plan, semantic analysis, filler segments, and enhanced transcript are now consistently passed and emitted so the pipeline and client receive the same data.

---

## Summary of File Touches

### Phase 1 (Original Audit)
| File | Changes |
|------|--------|
| `server/services/backgroundProcessor.ts` | Recovery statuses, skip review_ready/complete resume, stageOrder with rendering, fillerSegments from analysis and in enhancedAnalysis event, import detectFillerWords |
| `client/src/hooks/useSSE.ts` | connect(url, options?), connectionSessionKeyRef, clearStoredEventId(key?), sessionKey in deps |
| `client/src/hooks/useProcessSSE.ts` | Pass sessionKey in connect(), clearStoredEventId via sse.clearStoredEventId(getSessionKey(projectId)) |
| `server/services/ai/mediaSelector.ts` | analyzeThumbailWithVision → analyzeThumbnailWithVision |

### Phase 2 (Exhaustive Deep Dive)
| File | Changes |
|------|--------|
| `server/services/videoProcessor.ts` | Use centralized paths from config/paths.ts (respects UPLOADS_PATH env); fix cleanupTempFilesSync to use fs.rmSync with recursive for dirs |
| `server/services/backgroundProcessor.ts` | Use centralized paths; fix runBackgroundRender and autonomous self-review to pass project.analysis directly (not .videoAnalysis); remove invalid add_broll from filter; export retryProcessingFromStage |
| `server/routes.ts` | Retry route now calls retryProcessingFromStage; accept stage "all" (client sends this) as alias for "full" |

All changes are backward compatible and build passes.
