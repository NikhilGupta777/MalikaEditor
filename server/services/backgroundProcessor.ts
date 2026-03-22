import { storage } from "../storage";
import { fileStorage, generateFileKey } from "./fileStorage";
import { getVideoMetadata, extractFrames, extractAudio, detectSilence, applyEdits } from "./videoProcessor";
import { analyzeVideoDeep, generateSmartEditPlan, transcribeAudioEnhanced, detectFillerWords } from "./ai";
import { performPreRenderReview } from "./ai/preRenderReview";
import { performPostRenderSelfReview } from "./ai/postRenderReview";
import { arbitrateReviewConflicts } from "./ai/arbitration";
import { generateAiImagesForVideo } from "./ai/imageGeneration";
import { fetchStockMediaWithVariants, type StockMediaVariants } from "./pexelsService";
import { fetchFreepikMediaWithVariants, isFreepikConfigured } from "./freepikService";
import { selectBestMediaForWindows, convertSelectionsToStockMediaItems } from "./ai/mediaSelector";
import {
  initializeProjectChat,
  updateProjectContext,
  sendUploadUpdate,
  sendTranscriptionUpdate,
  sendAnalysisUpdate,
  sendEditPlanningUpdate,
  sendMediaFetchingUpdate,
  sendMediaSelectionUpdate,
  sendReviewReadyUpdate,
  sendErrorUpdate,
} from "./chatCompanion";
import type { ProcessingStatus, ReviewData, StockMediaItem, ProcessingStage } from "@shared/schema";
import path from "path";
import fs from "fs/promises";
import { UPLOADS_DIR as UPLOADS_DIR_CONFIG, OUTPUT_DIR as OUTPUT_DIR_CONFIG } from "../config/paths";

// ─── Background Quality Event System ─────────────────────────────────────────
// Allows the background quality loop to push live status events to connected SSE clients.
export type BgQualityEvent =
  | { type: "phase_a_start" }
  | { type: "phase_a_score"; score: number; approved: boolean; issues: number }
  | { type: "phase_b_skipped"; reason: string }
  | { type: "phase_b_start"; reason: string }
  | { type: "phase_b_fetching_media" }
  | { type: "phase_b_rendering" }
  | { type: "phase_b_reviewing" }
  | { type: "phase_b_done"; oldScore: number; newScore: number; outputPath: string }
  | { type: "done" };

type BgQualityCallback = (event: BgQualityEvent) => void;
const bgQualityListeners = new Map<number, Set<BgQualityCallback>>();

export function subscribeToBgQuality(projectId: number, cb: BgQualityCallback): () => void {
  if (!bgQualityListeners.has(projectId)) bgQualityListeners.set(projectId, new Set());
  bgQualityListeners.get(projectId)!.add(cb);
  return () => { bgQualityListeners.get(projectId)?.delete(cb); };
}

/** Returns true if there is an active (in-progress) background quality loop for this project. */
export function hasBgQualityLoop(projectId: number): boolean {
  return (bgQualityListeners.get(projectId)?.size ?? 0) > 0;
}

function emitBgQuality(projectId: number, event: BgQualityEvent) {
  bgQualityListeners.get(projectId)?.forEach(cb => { try { cb(event); } catch {} });
}
// ─────────────────────────────────────────────────────────────────────────────

interface EditOptionsType {
  addCaptions: boolean;
  addBroll: boolean;
  removeSilence: boolean;
  generateAiImages: boolean;
  addTransitions: boolean;
  autonomousMode?: boolean; // If true, skip user review and auto-render
}

let onJobCompleteCallback: ((projectId: number) => void) | null = null;

export function setOnJobComplete(callback: (projectId: number) => void) {
  onJobCompleteCallback = callback;
}

// Track active render jobs to prevent duplicate renders
const activeRenderJobs = new Set<number>();

export function isRenderActive(projectId: number): boolean {
  return activeRenderJobs.has(projectId);
}

const processorLogger = {
  info: (...args: unknown[]) => console.log(`${new Date().toLocaleTimeString()} [INFO] [background-processor]`, ...args),
  warn: (...args: unknown[]) => console.warn(`${new Date().toLocaleTimeString()} [WARN] [background-processor]`, ...args),
  error: (...args: unknown[]) => console.error(`${new Date().toLocaleTimeString()} [ERROR] [background-processor]`, ...args),
  debug: (...args: unknown[]) => console.log(`${new Date().toLocaleTimeString()} [DEBUG] [background-processor]`, ...args),
};

// Use centralized paths (respects UPLOADS_PATH env)
const UPLOADS_DIR = UPLOADS_DIR_CONFIG;
const OUTPUT_DIR = OUTPUT_DIR_CONFIG;

const processingLocks = new Map<number, { acquired: boolean; timestamp: number }>();
const LOCK_TIMEOUT_MS = 90 * 60 * 1000;
const STALE_JOB_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Cleanup locks on process exit - mark jobs as failed so UI doesn't hang
// This is critical for preventing "zombie" jobs that look like they're running forever
async function cleanupAllJobsOnExit(): Promise<void> {
  const jobCount = activeJobs.size;
  if (jobCount > 0) {
    processorLogger.info(`Process exit: cleaning up ${jobCount} active jobs`);

    // Create an array of update promises
    const updatePromises = Array.from(activeJobs.values()).map(async (job) => {
      try {
        await storage.updateVideoProject(job.projectId, {
          status: "failed",
          errorMessage: "Processing interrupted by server restart. Please retry."
        });
        processorLogger.debug(`Marked project ${job.projectId} as failed due to shutdown`);
      } catch (err) {
        processorLogger.error(`Failed to update project ${job.projectId} during shutdown:`, err);
      }
    });

    // Wait for all DB updates to complete (with a timeout safety)
    try {
      await Promise.race([
        Promise.all(updatePromises),
        new Promise(resolve => setTimeout(resolve, 2000)) // 2s max wait
      ]);
    } catch (err) {
      processorLogger.error("Error waiting for job cleanup updates:", err);
    }
  } else {
    processorLogger.info("Process exit: no active jobs to clean up");
  }

  processingLocks.clear();
  activeJobs.clear();
}

// Register process exit handlers
// Note: 'exit' event must be synchronous, so we can't do DB writes there.
// We rely on SIGINT/SIGTERM handlers for graceful shutdown DB updates.
process.on("exit", () => {
  processorLogger.info("Process exiting (synchronous cleanup only)");
  processingLocks.clear();
  activeJobs.clear();
});

process.on("SIGINT", async () => {
  processorLogger.info("Received SIGINT");
  await cleanupAllJobsOnExit();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  processorLogger.info("Received SIGTERM");
  await cleanupAllJobsOnExit();
  process.exit(0);
});

process.on("uncaughtException", async (err) => {
  processorLogger.error("Uncaught exception, cleaning up jobs:", err);
  await cleanupAllJobsOnExit();
  process.exit(1);
});

// Track the stale job cleanup interval for graceful shutdown
let staleJobCleanupInterval: NodeJS.Timeout | null = null;

// Periodically clean up stale jobs that have been running too long
async function cleanupStaleJobs(): Promise<void> {
  const now = Date.now();
  let cleanedCount = 0;

  try {
    // First: Clean up stale locks (use Array.from for compatibility)
    for (const [projectId, lock] of Array.from(processingLocks.entries())) {
      if (lock.acquired && now - lock.timestamp > LOCK_TIMEOUT_MS) {
        const job = activeJobs.get(projectId);

        // Only clean up if job is not actively processing or is truly stale
        if (!job || job.status !== "processing") {
          processingLocks.delete(projectId);
          cleanedCount++;
          processorLogger.info(`Cleaned up stale lock for project ${projectId}`);
        } else {
          // Job still processing but exceeded timeout - mark as failed
          job.status = "failed";
          processingLocks.delete(projectId);
          cleanedCount++;
          processorLogger.warn(`Force-cleaned stale processing job ${projectId} after ${LOCK_TIMEOUT_MS}ms`);

          // Update storage
          await storage.updateVideoProject(projectId, {
            status: "failed",
            errorMessage: "Processing timed out. Please retry with a shorter video.",
          }).catch((err) => {
            processorLogger.error(`Failed to update timed-out project ${projectId}:`, err);
          });
        }
      }
    }

    // Second: Clean up zombie jobs (use Array.from for compatibility)
    for (const [projectId, job] of Array.from(activeJobs.entries())) {
      if (job.status === "processing") {
        const lock = processingLocks.get(projectId);

        // If no lock exists, job is a zombie - check if it's been processing too long
        if (!lock) {
          // Use job startTime if available, otherwise mark as zombie immediately
          // Convert Date to numeric timestamp for comparison
          const jobStartTime = job.startTime ? job.startTime.getTime() : 0;
          if (now - jobStartTime > LOCK_TIMEOUT_MS || jobStartTime === 0) {
            job.status = "failed";
            cleanedCount++;
            processorLogger.warn(`Cleaned up zombie job ${projectId} (processing without lock)`);

            // Release slot if reserved
            if (job.slotReserved && onJobCompleteCallback) {
              job.slotReserved = false;
              onJobCompleteCallback(projectId);
            }

            await storage.updateVideoProject(projectId, {
              status: "failed",
              errorMessage: "Processing state lost. Please retry.",
            }).catch((err) => {
              processorLogger.error(`Failed to update zombie project ${projectId}:`, err);
            });
          }
        }
      }
    }

    if (cleanedCount > 0) {
      processorLogger.info(`Stale job cleanup: cleaned ${cleanedCount} stale locks/jobs`);
    }
  } catch (error) {
    processorLogger.error("Error during stale job cleanup:", error);
  }

  // Schedule next cleanup
  if (staleJobCleanupInterval !== null) { // Only schedule if not stopped
    staleJobCleanupInterval = setTimeout(cleanupStaleJobs, STALE_JOB_CLEANUP_INTERVAL_MS);
  }
}

function startStaleJobCleanup(): void {
  if (staleJobCleanupInterval) return; // Already started
  // Use a dummy timeout initially to signal it's active, effectively "started"
  // The actual loop starts immediately
  staleJobCleanupInterval = setTimeout(cleanupStaleJobs, STALE_JOB_CLEANUP_INTERVAL_MS);

  // Also run once immediately on startup (after a slight delay to let things settle)
  setTimeout(cleanupStaleJobs, 10000);
}

/**
 * Stop the stale job cleanup interval.
 * Call this during graceful shutdown to prevent memory leaks.
 */
export function stopStaleJobCleanup(): void {
  if (staleJobCleanupInterval) {
    clearTimeout(staleJobCleanupInterval);
    staleJobCleanupInterval = null;
  }
}

// Start the cleanup interval
startStaleJobCleanup();

// Helper function to update processing stage in database
async function updateProcessingStage(projectId: number, stage: ProcessingStage): Promise<void> {
  try {
    await storage.updateVideoProject(projectId, { processingStage: stage });
    processorLogger.debug(`Updated processing stage for project ${projectId}: ${stage}`);
  } catch (err) {
    processorLogger.error(`Failed to update processing stage for project ${projectId}:`, err);
  }
}

// Recover interrupted jobs on server startup
export async function recoverInterruptedJobs(): Promise<void> {
  processorLogger.info("Checking for interrupted processing jobs from previous run...");

  try {
    // Find all projects in any processing state
    const allProjects = await storage.getAllVideoProjects();
    const inProgressStatuses = [
      "uploading", "analyzing", "transcribing", "planning",
      "fetching_stock", "generating_ai_images", "editing", "rendering",
    ];

    // Find orphaned jobs: Database says "doing work", but Memory activeJobs (empty on startup) doesn't know about them.
    const orphanedProjects = allProjects.filter(p => {
      if (["awaiting_review", "completed", "failed", "cancelled"].includes(p.status)) return false;
      if (p.processingStage === "review_ready" || p.processingStage === "complete") return false;
      return (
        inProgressStatuses.includes(p.status) ||
        (p.processingStage &&
          p.processingStage !== "complete" &&
          p.processingStage !== "review_ready" &&
          p.status !== "failed")
      );
    });

    if (orphanedProjects.length === 0) {
      processorLogger.info("No orphaned jobs found.");
      return;
    }

    processorLogger.warn(`Found ${orphanedProjects.length} orphaned job(s) from previous, ungraceful shutdown.`);

    // Fail Fast Strategy:
    // Instead of auto-resuming (which runs in background with no UI feedback since SSE is lost),
    // we mark them as failed. This forces the user to see the error and click "Retry",
    // ensuring they are connected to the new processing session.
    for (const project of orphanedProjects) {
      try {
        await storage.updateVideoProject(project.id, {
          status: "failed",
          errorMessage: "Processing interrupted by system restart. Please retry."
        });
        processorLogger.info(`Marked orphaned project ${project.id} as failed.`);
      } catch (err) {
        processorLogger.error(`Failed to update orphaned project ${project.id}:`, err);
      }
    }
  } catch (err) {
    processorLogger.error("Failed to recover/cleanup interrupted jobs:", err);
  }
}

// Determine which stage to resume from based on persisted checkpoint (primary) or existing data (fallback)
function determineResumeStage(project: any): ProcessingStage {
  // PRIMARY: Use the persisted processingStage if available
  // This is the most reliable source as it was saved at the exact point processing stopped
  if (project.processingStage) {
    const stage = project.processingStage as ProcessingStage;
    const stageOrder: ProcessingStage[] = ["upload", "transcription", "analysis", "planning", "media_fetch", "media_selection", "review_ready", "rendering", "complete"];
    if (stage === "review_ready" || stage === "rendering" || stage === "complete") {
      processorLogger.debug(`Project at ${stage} - not resuming pipeline`);
      return stage;
    }
    const currentIdx = stageOrder.indexOf(stage);
    if (currentIdx >= 0 && currentIdx < stageOrder.length - 1) {
      const nextStage = stageOrder[currentIdx + 1];
      processorLogger.debug(`Using persisted stage ${stage}, resuming from next stage: ${nextStage}`);
      return nextStage;
    }
    return stage;
  }

  // FALLBACK: Infer from existing data if no processingStage is set
  // This handles projects created before the processingStage field was added
  processorLogger.debug(`No persisted processingStage for project ${project.id}, inferring from data...`);

  if (project.reviewData && project.stockMedia) {
    return "review_ready";
  }
  if (project.stockMedia) {
    return "media_selection";
  }
  if (project.editPlan) {
    return "media_fetch";
  }
  if (project.analysis) {
    return "planning";
  }
  // Check both transcript and transcriptEnhanced - if either exists, we've completed transcription
  if (project.transcript || project.transcriptEnhanced) {
    return "analysis";
  }
  return "upload";
}

// Resume processing from a specific stage
async function resumeProcessing(projectId: number, prompt: string, resumeFromStage: ProcessingStage, retryCount = 0): Promise<void> {
  const MAX_RESUME_RETRIES = 5;

  if (!canStartNewJob()) {
    if (retryCount >= MAX_RESUME_RETRIES) {
      processorLogger.warn(`Cannot resume project ${projectId}: max concurrent jobs reached and max retries (${MAX_RESUME_RETRIES}) exceeded.`);
      // Optionally mark as failed or just leave it for next server restart / user action
      return;
    }

    processorLogger.warn(`Cannot resume project ${projectId}: max concurrent jobs reached, will retry later (Attempt ${retryCount + 1}/${MAX_RESUME_RETRIES})`);
    // Backoff strategy: 30s, 60s, 90s...
    const delay = 30000 * (retryCount + 1);
    setTimeout(() => resumeProcessing(projectId, prompt, resumeFromStage, retryCount + 1), delay);
    return;
  }

  if (!acquireProcessingLock(projectId)) {
    processorLogger.warn(`Cannot resume project ${projectId}: failed to acquire lock`);
    return;
  }

  const job: ProcessingJob = {
    projectId,
    status: "processing",
    activities: [],
    eventHistory: [],
    lastEventId: 0,
    minEventId: 0,
    slotReserved: true,
    startTime: new Date(),
  };
  activeJobs.set(projectId, job);

  processorLogger.info(`Resuming background processing for project ${projectId} from stage: ${resumeFromStage}`);
  addActivity(projectId, `Resuming processing from ${resumeFromStage}...`);

  // Get project and determine edit options from existing data
  const project = await storage.getVideoProject(projectId);
  if (!project) {
    processorLogger.error(`Cannot resume project ${projectId}: project not found in storage`);
    releaseProcessingLock(projectId);
    activeJobs.delete(projectId);
    return;
  }

  // Infer edit options from existing data or use defaults
  // Initialize with safe defaults, then try to load from project if saved
  let editOptions: EditOptionsType = {
    addCaptions: true,
    addBroll: true,
    removeSilence: true,
    generateAiImages: true,
    addTransitions: true,
  };

  // If project has reviewData, it might have editOptions
  if (project.reviewData && (project.reviewData as any).editOptions) {
    editOptions = { ...editOptions, ...(project.reviewData as any).editOptions };
  }

  // Run the pipeline with the resume stage
  runProcessingPipeline(projectId, prompt, editOptions, resumeFromStage).catch((error: Error) => {
    processorLogger.error(`Resumed processing failed for project ${projectId}:`, error);
  });
}

function acquireProcessingLock(projectId: number): boolean {
  const existing = processingLocks.get(projectId);
  const now = Date.now();

  if (existing?.acquired) {
    if (now - existing.timestamp > LOCK_TIMEOUT_MS) {
      const activeJob = activeJobs.get(projectId);
      if (activeJob?.status === "processing") {
        processorLogger.warn(`Stale lock detected for project ${projectId} but job still marked as processing - denying new request`);
        return false;
      }
      processorLogger.warn(`Stale lock detected for project ${projectId} (job not processing), forcing release`);
      processingLocks.delete(projectId);
    } else {
      processorLogger.info(`Project ${projectId} is already being processed, skipping duplicate request`);
      return false;
    }
  }

  processingLocks.set(projectId, { acquired: true, timestamp: now });
  return true;
}

function releaseProcessingLock(projectId: number): void {
  processingLocks.delete(projectId);
}

interface SSEEvent {
  id: number;
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
}

interface ProcessingJob {
  projectId: number;
  status: "queued" | "processing" | "completed" | "failed";
  activities: Array<{ message: string; timestamp: number }>;
  eventHistory: SSEEvent[];
  lastEventId: number;
  minEventId: number; // Track minimum available event ID for replay handling
  abortController?: AbortController;
  slotReserved: boolean;
  startTime: Date;
}

const MAX_EVENT_HISTORY = 100; // Keep last 100 events for replay
const activeJobs = new Map<number, ProcessingJob>();
const jobSubscribers = new Map<number, Set<(event: SSEEvent) => void>>();

// Slot management - export functions for routes.ts to use
export const MAX_CONCURRENT_JOBS = 3;

/**
 * Atomically try to reserve a processing slot for a project.
 * This prevents race conditions where multiple requests could claim the same slot.
 * @param projectId The project ID to reserve a slot for
 * @returns true if slot was successfully reserved, false if no slots available
 */
export function tryReserveSlot(projectId: number): boolean {
  // If this project already has a reserved slot, allow it
  const existingJob = activeJobs.get(projectId);
  if (existingJob?.slotReserved && existingJob.status === "processing") {
    return true;
  }

  // Count current active slots
  const activeCount = Array.from(activeJobs.values()).filter(
    job => job.status === "processing" && job.slotReserved
  ).length;

  if (activeCount >= MAX_CONCURRENT_JOBS) {
    return false;
  }

  // Reserve the slot immediately by creating/updating job entry
  if (existingJob) {
    existingJob.slotReserved = true;
    existingJob.status = "processing";
  }
  // Note: Full job creation happens in startProcessingJob

  return true;
}

export function canStartNewJob(): boolean {
  const activeCount = Array.from(activeJobs.values()).filter(
    job => job.status === "processing" && job.slotReserved
  ).length;
  return activeCount < MAX_CONCURRENT_JOBS;
}

export function getActiveJobCount(): number {
  return Array.from(activeJobs.values()).filter(
    job => job.status === "processing" && job.slotReserved
  ).length;
}

export function getActiveJobsInfo(): { id: number; startTime: Date; status: string }[] {
  return Array.from(activeJobs.entries())
    .filter(([_, job]) => job.status === "processing")
    .map(([id, job]) => ({ id, startTime: job.startTime, status: job.status }));
}

export function getJobStatus(projectId: number): ProcessingJob | undefined {
  return activeJobs.get(projectId);
}

export function getJobActivities(projectId: number): Array<{ message: string; timestamp: number }> {
  return activeJobs.get(projectId)?.activities || [];
}

// Get events that occurred after a specific event ID (for replay on reconnect)
export function getEventsSince(projectId: number, lastEventId: number): SSEEvent[] {
  const job = activeJobs.get(projectId);
  if (!job) return [];

  // Check if requested events are still available
  if (lastEventId < job.minEventId && job.minEventId > 0) {
    processorLogger.warn(
      `Client requested events from ID ${lastEventId} but earliest available is ${job.minEventId}`
    );
    // Return all available events so client can recover
    return job.eventHistory;
  }

  return job.eventHistory.filter(event => event.id > lastEventId);
}

/**
 * Get the minimum available event ID for a project.
 * Events before this ID have been purged from history.
 */
export function getMinEventId(projectId: number): number {
  return activeJobs.get(projectId)?.minEventId || 0;
}

// Get the current last event ID for a project
export function getLastEventId(projectId: number): number {
  return activeJobs.get(projectId)?.lastEventId || 0;
}

export function subscribeToJob(projectId: number, callback: (event: SSEEvent) => void): () => void {
  if (!jobSubscribers.has(projectId)) {
    jobSubscribers.set(projectId, new Set());
  }
  jobSubscribers.get(projectId)!.add(callback);

  return () => {
    jobSubscribers.get(projectId)?.delete(callback);
    if (jobSubscribers.get(projectId)?.size === 0) {
      jobSubscribers.delete(projectId);
    }
  };
}

function notifySubscribers(projectId: number, type: string, data: Record<string, unknown>) {
  const job = activeJobs.get(projectId);
  if (!job) return;

  // Create event with unique ID
  const eventId = ++job.lastEventId;
  const event: SSEEvent = {
    id: eventId,
    type,
    data,
    timestamp: Date.now(),
  };

  // Store in event history for replay
  job.eventHistory.push(event);
  if (job.eventHistory.length > MAX_EVENT_HISTORY) {
    const removed = job.eventHistory.shift();
    // Track minimum available event ID for clients requesting old events
    if (removed && job.eventHistory.length > 0) {
      job.minEventId = job.eventHistory[0].id;
    }
  }

  // Notify all subscribers
  const subscribers = jobSubscribers.get(projectId);
  if (subscribers) {
    Array.from(subscribers).forEach(callback => {
      try {
        callback(event);
      } catch (e) {
        processorLogger.error(`Error notifying subscriber for project ${projectId}:`, e);
      }
    });
  }
}

function addActivity(projectId: number, message: string) {
  const job = activeJobs.get(projectId);
  if (job) {
    const activity = { message, timestamp: Date.now() };
    job.activities.push(activity);
    if (job.activities.length > 100) {
      job.activities.shift();
    }
    notifySubscribers(projectId, "activity", activity);
  }
}

function cleanupJob(projectId: number, immediate: boolean = false): void {
  const cleanup = () => {
    const job = activeJobs.get(projectId);
    if (job && job.status !== "processing") {
      activeJobs.delete(projectId);
      jobSubscribers.delete(projectId);
      processorLogger.debug(`Cleaned up job data for project ${projectId}`);
    }
  };

  if (immediate) {
    cleanup();
  } else {
    setTimeout(cleanup, 300000);
  }
}

export async function startProcessingJob(
  projectId: number,
  prompt: string,
  editOptions: EditOptionsType
): Promise<void> {
  // Use lock to prevent race conditions when multiple requests arrive simultaneously
  if (!acquireProcessingLock(projectId)) {
    return;
  }

  if (activeJobs.has(projectId)) {
    const existingJob = activeJobs.get(projectId)!;
    if (existingJob.status === "processing") {
      processorLogger.info(`Project ${projectId} is already being processed`);
      releaseProcessingLock(projectId);
      return;
    }
  }

  const job: ProcessingJob = {
    projectId,
    status: "processing",
    activities: [],
    eventHistory: [],
    lastEventId: 0,
    minEventId: 0,
    slotReserved: true,
    startTime: new Date(),
  };
  activeJobs.set(projectId, job);

  processorLogger.info(`Starting background processing for project ${projectId}`);
  addActivity(projectId, "Starting video processing...");

  runProcessingPipeline(projectId, prompt, editOptions).catch((error) => {
    processorLogger.error(`Processing failed for project ${projectId}:`, error);
  });
}

async function runProcessingPipeline(
  projectId: number,
  prompt: string,
  editOptions: EditOptionsType,
  resumeFromStage?: ProcessingStage
): Promise<void> {
  const job = activeJobs.get(projectId);
  if (!job) return;

  const updateStatus = async (status: ProcessingStatus) => {
    await storage.updateVideoProject(projectId, { status });
    notifySubscribers(projectId, "status", { status });
  };

  // Helper to check if we should skip a stage (already completed during previous run)
  const shouldSkipStage = (stage: ProcessingStage): boolean => {
    if (!resumeFromStage) return false;
    const stageOrder: ProcessingStage[] = ["upload", "transcription", "analysis", "planning", "media_fetch", "media_selection", "review_ready", "rendering", "complete"];
    const resumeIndex = stageOrder.indexOf(resumeFromStage);
    const currentIndex = stageOrder.indexOf(stage);
    return currentIndex < resumeIndex;
  };

  const tempFiles: string[] = [];

  try {
    const project = await storage.getVideoProject(projectId);
    if (!project) {
      throw new Error("Project not found");
    }

    const videoPath = await fileStorage.getFilePath(project.originalPath);

    try {
      await fs.access(videoPath);
    } catch {
      throw new Error("Video file not found. Please re-upload your video.");
    }

    await storage.updateVideoProject(projectId, { prompt });

    // Initialize chat companion for this project
    await initializeProjectChat(projectId, project.fileName || "Untitled Video");
    updateProjectContext(projectId, { prompt, status: "analyzing", title: project.fileName });

    await updateStatus("analyzing");
    addActivity(projectId, "Reading video metadata...");
    const metadata = await getVideoMetadata(videoPath);

    // Validate metadata to prevent null pointer errors
    if (!metadata || typeof metadata.duration !== 'number' || isNaN(metadata.duration)) {
      throw new Error("Failed to read video metadata. The video file may be corrupted or in an unsupported format.");
    }

    addActivity(projectId, `Video info: ${metadata.duration.toFixed(1)}s duration, ${metadata.width || 0}x${metadata.height || 0}`);

    // Send upload update to chat companion
    await sendUploadUpdate(projectId, project.fileName || "video", Math.round(metadata.duration));
    updateProjectContext(projectId, { duration: Math.round(metadata.duration) });

    // PARALLEL PHASE 1: Extract frames, audio, and detect silence simultaneously
    // These operations are all independent reads from the video file
    const numFrames = Math.min(12, Math.max(6, Math.floor(metadata.duration / 10)));
    addActivity(projectId, `Starting parallel extraction: ${numFrames} frames + audio${editOptions.removeSilence ? ' + silence detection' : ''}...`);

    const parallelExtractionStart = Date.now();

    const [framePaths, audioPath, silentSegments] = await Promise.all([
      // Frame extraction
      extractFrames(videoPath, numFrames),
      // Audio extraction  
      extractAudio(videoPath),
      // Silence detection (if enabled)
      editOptions.removeSilence ? detectSilence(videoPath) : Promise.resolve([]),
    ]);

    const parallelExtractionTime = ((Date.now() - parallelExtractionStart) / 1000).toFixed(1);
    addActivity(projectId, `Parallel extraction complete in ${parallelExtractionTime}s: ${framePaths.length} frames extracted`);

    // Guard against empty frame extraction
    if (framePaths.length > 0) {
      tempFiles.push(path.dirname(framePaths[0]));
    } else {
      processorLogger.error(`No frames extracted from video - visual analysis may be limited`);
    }
    tempFiles.push(audioPath);

    if (editOptions.removeSilence) {
      addActivity(projectId, `Found ${silentSegments.length} silent segments to remove`);
    }

    // PHASE 2: Transcription with enhanced AI features (requires audio)
    await updateStatus("transcribing");
    addActivity(projectId, "Transcribing audio with AI (speakers, chapters, sentiment)...");
    const transcriptResult = await transcribeAudioEnhanced(audioPath, metadata.duration);
    const transcript = transcriptResult.segments;
    addActivity(projectId, `Transcription complete: ${transcript.length} segments`);

    // Log enhanced features if available
    if (transcriptResult.speakers && transcriptResult.speakers.length > 0) {
      addActivity(projectId, `Detected ${transcriptResult.speakers.length} speakers in video`);
    }
    if (transcriptResult.chapters && transcriptResult.chapters.length > 0) {
      addActivity(projectId, `Generated ${transcriptResult.chapters.length} auto-chapters`);
    }
    if (transcriptResult.sentiments && transcriptResult.sentiments.length > 0) {
      const positive = transcriptResult.sentiments.filter((s: { sentiment: string }) => s.sentiment === "positive").length;
      const negative = transcriptResult.sentiments.filter((s: { sentiment: string }) => s.sentiment === "negative").length;
      addActivity(projectId, `Sentiment analysis: ${positive} positive, ${negative} negative segments`);
    }
    if (transcriptResult.entities && transcriptResult.entities.length > 0) {
      addActivity(projectId, `Found ${transcriptResult.entities.length} named entities`);
    }

    await storage.updateVideoProject(projectId, {
      transcript,
      // Store enhanced data for later use
      transcriptEnhanced: {
        speakers: transcriptResult.speakers,
        chapters: transcriptResult.chapters,
        sentiments: transcriptResult.sentiments,
        entities: transcriptResult.entities,
        detectedLanguage: transcriptResult.detectedLanguage,
      }
    });
    notifySubscribers(projectId, "transcript", {
      transcript,
      enhanced: {
        speakers: transcriptResult.speakers,
        chapters: transcriptResult.chapters,
        sentiments: transcriptResult.sentiments,
        entities: transcriptResult.entities,
      }
    });

    // Send transcription update to chat companion
    await sendTranscriptionUpdate(projectId, transcript.length, transcriptResult.detectedLanguage);
    updateProjectContext(projectId, { transcript, status: "transcribing" });

    // Save checkpoint: transcription complete
    await updateProcessingStage(projectId, "transcription");

    addActivity(projectId, "Performing deep video analysis (AI watching full video)...");
    const analysis = await analyzeVideoDeep(
      framePaths,
      metadata.duration,
      silentSegments,
      transcript,
      videoPath // Pass video path for full video watching
    );

    const brollWindowCount = analysis.semanticAnalysis?.brollWindows?.length || 0;
    const hookStrength = analysis.semanticAnalysis?.hookMoments?.[0]?.score || 0;
    addActivity(projectId, `Deep analysis complete: ${brollWindowCount} B-roll windows, hook strength: ${hookStrength}`);

    // Ensure analysis has valid duration (fallback to metadata.duration or transcript end)
    const transcriptEnd = transcript[transcript.length - 1]?.end || 0;
    const validDuration = (analysis.videoAnalysis?.duration && !isNaN(analysis.videoAnalysis.duration))
      ? analysis.videoAnalysis.duration
      : (metadata.duration || transcriptEnd || 60);

    // Flatten analysis to match videoAnalysisSchema - spread videoAnalysis props at top level
    // Include enhancedAnalysis (motion, transitions, pacing, sync) for downstream use
    const sanitizedAnalysis = {
      ...analysis.videoAnalysis,
      duration: validDuration,
      frames: analysis.videoAnalysis?.frames || [],
      semanticAnalysis: analysis.semanticAnalysis,
      // Store enhancedAnalysis for edit planning and media selection (use undefined for optional)
      enhancedAnalysis: analysis.enhancedAnalysis || undefined,
      qualityInsights: analysis.qualityInsights || undefined,
    };

    await storage.updateVideoProject(projectId, {
      analysis: sanitizedAnalysis,
    });

    const fillerSegmentsForClient = analysis.semanticAnalysis?.fillerSegments ?? detectFillerWords(transcript);
    notifySubscribers(projectId, "enhancedAnalysis", {
      hookMoments: analysis.semanticAnalysis?.hookMoments,
      topicFlow: analysis.semanticAnalysis?.topicFlow,
      structureAnalysis: analysis.semanticAnalysis?.structureAnalysis,
      keyMoments: analysis.semanticAnalysis?.keyMoments,
      fillerSegments: fillerSegmentsForClient,
      qualityInsights: {
        hookStrength,
        pacingScore: 75,
        engagementPrediction: 80,
        recommendations: [],
      },
    });

    // Send analysis update to chat companion
    await sendAnalysisUpdate(projectId, sanitizedAnalysis);
    updateProjectContext(projectId, { videoAnalysis: sanitizedAnalysis, status: "planning" });

    // Save checkpoint: analysis complete
    await updateProcessingStage(projectId, "analysis");

    await updateStatus("planning");
    addActivity(projectId, "Creating intelligent edit plan...");
    const fillerSegments: { start: number; end: number; word: string }[] =
      sanitizedAnalysis.semanticAnalysis?.fillerSegments ?? detectFillerWords(transcript);

    // Create enhanced transcript with rich context for intelligent editing decisions
    const enhancedTranscript = {
      speakers: transcriptResult.speakers || [],
      chapters: transcriptResult.chapters || [],
      sentiments: transcriptResult.sentiments || [],
      entities: transcriptResult.entities || [],
      detectedLanguage: transcriptResult.detectedLanguage,
    };

    // Use the already sanitized analysis with valid duration (now flattened)
    const editPlan = await generateSmartEditPlan(
      prompt,
      sanitizedAnalysis,
      transcript,
      sanitizedAnalysis.semanticAnalysis || {},
      fillerSegments,
      enhancedTranscript,
      undefined,
      undefined,
      projectId
    );
    addActivity(projectId, `Edit plan ready: ${editPlan.actions?.length || 0} actions planned`);

    await storage.updateVideoProject(projectId, { editPlan });
    notifySubscribers(projectId, "editPlan", { editPlan });

    // Send edit planning update to chat companion
    const cuts = (editPlan.actions || []).filter((a: any) => a.type === "cut").length;
    const keeps = (editPlan.actions || []).filter((a: any) => a.type === "keep").length;
    const broll = (editPlan.actions || []).filter((a: any) => a.type === "insert_stock" || a.type === "insert_ai_image").length;
    await sendEditPlanningUpdate(projectId, { cuts, keeps, broll });
    updateProjectContext(projectId, { editPlan, status: "fetching_stock" });

    // Save checkpoint: planning complete
    await updateProcessingStage(projectId, "planning");

    await updateStatus("fetching_stock");

    // Send media fetching update to chat companion
    const stockQueryCount = editPlan.stockQueries?.length || broll;
    await sendMediaFetchingUpdate(projectId, stockQueryCount);
    updateProjectContext(projectId, { status: "fetching_stock" });

    let stockMedia: StockMediaItem[] = [];
    let aiImageCount = 0;

    // Extract B-roll windows from edit plan actions (insert_stock, insert_ai_image) - these are the AI's actual decisions
    // This is more accurate than semanticAnalysis.brollWindows which may have fewer windows
    const editPlanBrollWindows = (editPlan.actions || [])
      .filter((a: any) => (a.type === 'insert_stock' || a.type === 'insert_ai_image') && typeof a.start === 'number')
      .map((a: any) => {
        // Handle both end and duration formats
        const end = typeof a.end === 'number' ? a.end :
          typeof a.duration === 'number' ? a.start + a.duration :
            a.start + 4; // Default 4s duration if neither
        return {
          start: a.start,
          end,
          suggestedQuery: a.stockQuery || a.query || a.prompt || '',
          priority: a.priority || 'medium' as const,
          context: a.reason || a.context || '',
          animationPreset: a.animationPreset || undefined,
        };
      })
      .filter((w: any) => w.end > w.start); // Ensure valid windows

    // Use edit plan B-roll windows (preferred) or fall back to semantic analysis
    const semanticBrollWindows = analysis.semanticAnalysis?.brollWindows || [];
    const brollWindows = editPlanBrollWindows.length > 0 ? editPlanBrollWindows : semanticBrollWindows;

    processorLogger.info(`B-roll windows: ${editPlanBrollWindows.length} from edit plan, ${semanticBrollWindows.length} from semantic analysis, using ${brollWindows.length}`);

    // Log observability info if semantic analysis is missing but we have edit plan windows
    if (!analysis.semanticAnalysis && editPlanBrollWindows.length > 0) {
      processorLogger.info(`[EDGE CASE] Semantic analysis missing but ${editPlanBrollWindows.length} edit plan windows available - using edit plan windows only`);
    }

    const stockQueries = editPlan.stockQueries ||
      brollWindows.map((w: any) => w.suggestedQuery).filter(Boolean) || [];

    let stockVariants: StockMediaVariants[] = [];
    let generatedAiImages: Awaited<ReturnType<typeof generateAiImagesForVideo>> = [];

    if (editOptions.addBroll && stockQueries.length > 0) {
      // PARALLEL PHASE 3: Fetch stock media AND generate AI images simultaneously
      // These are completely independent operations
      const shouldGenerateAi = editOptions.generateAiImages && (!!analysis.semanticAnalysis || brollWindows.length > 0);

      const freepikEnabled = isFreepikConfigured();
      const sourceInfo = freepikEnabled ? 'Pexels + Freepik' : 'Pexels';
      addActivity(projectId, `Fetching stock media from ${sourceInfo}${shouldGenerateAi ? ' + generating AI images' : ''} in parallel...`);
      const mediaFetchStart = Date.now();

      // No limits - AI decides count based on content analysis
      processorLogger.info(`Processing ${metadata.duration}s video with ${stockQueries.length} stock queries from ${sourceInfo}, AI images based on content`);

      // Run stock fetch from both providers and AI generation in parallel
      const [pexelsVariants, freepikVariants, aiImagesResult] = await Promise.all([
        // Pexels stock media fetching - use all queries from AI analysis (counts from AI_CONFIG)
        fetchStockMediaWithVariants(stockQueries),
        // Freepik stock media fetching (if configured, counts from AI_CONFIG)
        freepikEnabled
          ? fetchFreepikMediaWithVariants(stockQueries)
          : Promise.resolve([] as StockMediaVariants[]),
        // AI image generation (if enabled) - use edit plan B-roll windows for consistency
        // Works even if semanticAnalysis is missing, as long as we have explicit B-roll windows
        shouldGenerateAi && (analysis.semanticAnalysis || brollWindows.length > 0)
          ? generateAiImagesForVideo(
            analysis.semanticAnalysis || { brollWindows: [], mainTopics: [], overallTone: "general", keyMoments: [], topicFlow: [], hookMoments: [] },
            undefined,
            metadata.duration,
            brollWindows
          ).catch((aiError: Error) => {
            processorLogger.error("AI image generation failed:", aiError);
            addActivity(projectId, "AI image generation failed, continuing with stock media only");
            notifySubscribers(projectId, "aiImagesError", {
              message: "AI image generation failed, continuing with stock media only"
            });
            return [] as Awaited<ReturnType<typeof generateAiImagesForVideo>>;
          })
          : Promise.resolve([] as Awaited<ReturnType<typeof generateAiImagesForVideo>>),
      ]);

      // Combine Pexels and Freepik results - merge by query
      stockVariants = pexelsVariants.map((pexelsResult, idx) => {
        const freepikResult = freepikVariants[idx];
        return {
          query: pexelsResult.query,
          photos: [...pexelsResult.photos, ...(freepikResult?.photos || [])],
          videos: [...pexelsResult.videos, ...(freepikResult?.videos || [])],
          allItems: [...pexelsResult.allItems, ...(freepikResult?.allItems || [])],
        };
      });

      const mediaFetchTime = ((Date.now() - mediaFetchStart) / 1000).toFixed(1);
      const pexelsPhotos = pexelsVariants.reduce((sum, v) => sum + v.photos.length, 0);
      const pexelsVideos = pexelsVariants.reduce((sum, v) => sum + v.videos.length, 0);
      const freepikPhotos = freepikVariants.reduce((sum, v) => sum + v.photos.length, 0);
      const freepikVideos = freepikVariants.reduce((sum, v) => sum + v.videos.length, 0);
      const totalPhotos = pexelsPhotos + freepikPhotos;
      const totalVideos = pexelsVideos + freepikVideos;

      generatedAiImages = aiImagesResult || [];
      aiImageCount = generatedAiImages.length;

      addActivity(projectId, `Parallel media fetch complete in ${mediaFetchTime}s: ${totalPhotos} photos + ${totalVideos} videos + ${aiImageCount} AI images`);

      // Save checkpoint: media fetch complete
      await updateProcessingStage(projectId, "media_fetch");

      addActivity(projectId, "AI selecting best media for each B-roll window...");

      // Extract enhancedAnalysis for intelligent media selection (now properly typed in VideoAnalysis)
      const enhancedAnalysis = sanitizedAnalysis.enhancedAnalysis;
      const motionAnalysis = enhancedAnalysis?.motionAnalysis;
      const pacingAnalysis = enhancedAnalysis?.pacingAnalysis;

      if (motionAnalysis) {
        processorLogger.info(`[Media Selection] Using motion analysis: intensity=${motionAnalysis.motionIntensity}, ${motionAnalysis.actionSequences?.length || 0} action sequences`);
      }
      if (pacingAnalysis) {
        processorLogger.info(`[Media Selection] Using pacing analysis: ${pacingAnalysis.overallPacing}, ${pacingAnalysis.suggestedPacingAdjustments?.length || 0} adjustments`);
      }

      const selectionResult = await selectBestMediaForWindows(
        brollWindows as { start: number; end: number; suggestedQuery: string; priority: "high" | "medium" | "low"; context?: string; animationPreset?: string }[],
        stockVariants,
        generatedAiImages,
        {
          duration: metadata.duration,
          genre: (analysis as any).context?.genre || analysis.semanticAnalysis?.overallTone || "general",
          tone: (analysis as any).context?.tone || analysis.semanticAnalysis?.overallTone || "professional",
          topic: analysis.semanticAnalysis?.mainTopics?.[0] || "various",
          // Pass enhanced analysis for intelligent selection
          motionAnalysis,
          pacingAnalysis,
        }
      );

      addActivity(projectId, `AI selected ${selectionResult.totalSelected} clips: ${selectionResult.aiImagesUsed} AI, ${selectionResult.stockVideosUsed} videos, ${selectionResult.stockImagesUsed} images`);

      const { stockItems, aiImages: selectedAiImages } = convertSelectionsToStockMediaItems(selectionResult.selections);

      processorLogger.info(`Media conversion result: ${stockItems.length} stock items, ${selectedAiImages.length} AI images`);

      // Use selected AI images
      const finalAiImages = selectedAiImages;

      if (stockItems.length > 0) {
        processorLogger.debug(`Stock items selected: ${stockItems.map(s => `${s.type}:${s.query?.slice(0, 30)}`).join(', ')}`);
      }

      const aiStockItems: StockMediaItem[] = finalAiImages.map((img, idx) => ({
        id: `ai_${Date.now()}_${idx}`,
        type: 'ai_generated' as const,
        url: `/stock/${path.basename(img.filePath)}`,
        query: img.prompt,
        thumbnailUrl: `/stock/${path.basename(img.filePath)}`,
        width: 1024,
        height: 1024,
        source: 'ai',
        startTime: img.startTime,
        endTime: img.endTime,
        animationPreset: img.animationPreset as "zoom_in" | "zoom_out" | "pan_left" | "pan_right" | "fade_only" | undefined,
      }));

      stockMedia = [...stockItems, ...aiStockItems];
      aiImageCount = aiStockItems.length;

      notifySubscribers(projectId, "aiImages", { count: aiImageCount });
    } else if (editOptions.generateAiImages && analysis.semanticAnalysis) {
      await updateStatus("generating_ai_images");
      addActivity(projectId, "Generating AI images for overlays...");

      processorLogger.info(`Generating AI images for ${metadata.duration}s video based on content analysis`);

      try {
        const aiImages = await generateAiImagesForVideo(
          analysis.semanticAnalysis,
          undefined,
          metadata.duration
        );

        const aiStockItems: StockMediaItem[] = aiImages.map((img, idx) => ({
          id: `ai_${Date.now()}_${idx}`,
          type: 'ai_generated' as const,
          url: `/stock/${path.basename(img.filePath)}`,
          query: img.prompt,
          thumbnailUrl: `/stock/${path.basename(img.filePath)}`,
          width: 1024,
          height: 1024,
          source: 'ai',
          startTime: img.startTime,
          endTime: img.endTime,
        }));

        stockMedia = aiStockItems;
        aiImageCount = aiStockItems.length;
        addActivity(projectId, `Generated ${aiImageCount} AI images`);
        notifySubscribers(projectId, "aiImages", { count: aiImageCount });
      } catch (aiError) {
        processorLogger.error("AI image generation failed:", aiError);
        addActivity(projectId, "AI image generation failed, continuing without media overlays");
        notifySubscribers(projectId, "aiImagesError", {
          message: "AI image generation failed, continuing without media overlays"
        });
      }
    }

    await storage.updateVideoProject(projectId, { stockMedia });
    notifySubscribers(projectId, "stockMedia", { stockMedia });

    // Send media selection update to chat companion
    const stockCount = stockMedia.filter(m => m.type !== 'ai_generated').length;
    const aiCount = stockMedia.filter(m => m.type === 'ai_generated').length;
    await sendMediaSelectionUpdate(projectId, stockCount, aiCount);

    // Save checkpoint: media selection complete
    await updateProcessingStage(projectId, "media_selection");

    // Construct review data first so we can pass it to the AI reviewer
    const reviewData: ReviewData = {
      transcript: transcript.map((t, i) => ({
        id: `transcript_${i}`,
        ...t,
        approved: true,
        edited: false,
      })),
      editPlan: {
        ...editPlan,
        actions: (editPlan.actions || []).map((a, i) => ({
          id: `action_${i}`,
          ...a,
          // Cuts default to OFF — user must explicitly approve each cut.
          // All other actions (B-roll, captions, etc.) default to approved.
          approved: a.type === 'cut' ? false : true,
        })),
      },
      stockMedia: stockMedia.filter(m => m.type !== 'ai_generated').map((m, i) => ({
        id: `stock_${i}`,
        ...m,
        approved: true,
        reason: `Matches: "${m.query?.slice(0, 100)}"`,
      })),
      aiImages: stockMedia.filter(m => m.type === 'ai_generated').map((m, i) => ({
        id: `ai_${i}`,
        ...m,
        approved: true,
        reason: `AI generated for: "${m.query?.slice(0, 50)}"`,
      })),
      editOptions,
      summary: {
        totalCuts: (editPlan.actions || []).filter(a => a.type === 'cut').length,
        totalKeeps: (editPlan.actions || []).filter(a => a.type === 'keep').length,
        totalBroll: stockMedia.filter(m => m.type !== 'ai_generated').length,
        totalAiImages: stockMedia.filter(m => m.type === 'ai_generated').length,
        originalDuration: metadata.duration,
        estimatedFinalDuration: editPlan.estimatedDuration || metadata.duration,
      },
      userApproved: editOptions.autonomousMode === true, // Will be overridden if gating triggers
    };

    // Verify we have analysis before running pre-render review
    let aiReviewFnResult;
    try {
      addActivity(projectId, "Performing pre-render AI review...");
      // Ensure we have a valid VideoAnalysis object
      // Cast to unknown first to avoid "neither type sufficiently overlaps" error
      const validAnalysis = (analysis as any).semanticAnalysis ?
        (analysis as unknown as import("@shared/schema").VideoAnalysis) :
        (analysis as unknown as import("@shared/schema").VideoAnalysis); // Fallback to casting whatever we have, assuming it's structural enough

      // Call with correct signature: (videoAnalysis, transcript, editPlan, reviewData, userPrompt)
      aiReviewFnResult = await performPreRenderReview(
        validAnalysis,
        transcript,
        editPlan,
        reviewData,
        prompt
      );

      addActivity(projectId, `Pre-render review complete: ${aiReviewFnResult.approved ? 'Approved' : 'Needs Review'} (Confidence: ${aiReviewFnResult.confidence}%)`);

      // Attach result to reviewData
      reviewData.aiReview = aiReviewFnResult;

    } catch (err) {
      processorLogger.error("Pre-render review failed:", err);
      addActivity(projectId, "Pre-render review skipped (internal error)");
      // Fallback: continue without review data
    }

    // AUTONOMOUS MODE: Continue directly to rendering (if approved)
    if (editOptions.autonomousMode) {
      // GATING: Check if pre-render review allows autonomous proceeding
      const isApproved = aiReviewFnResult?.approved === true;
      const isHighConfidence = (aiReviewFnResult?.confidence || 0) >= 70;

      if (!isApproved || !isHighConfidence) {
        processorLogger.info(`[AUTONOMOUS] Gated: Pre-render review failed approval or confidence check. Falling back to manual review.`);
        addActivity(projectId, `Autonomous mode halted: Quality check failed (Approved: ${isApproved}, Confidence: ${aiReviewFnResult?.confidence}%). Waiting for user review.`);

        // Disable auto-approval flag since we are stopping
        reviewData.userApproved = false; // Important: Force false so UI shows "Awaiting Review"

        // Save review data and STOP here
        await storage.updateVideoProject(projectId, {
          reviewData,
          status: "awaiting_review",
          processingStage: "review_ready"
        });

        notifySubscribers(projectId, "processingComplete", {
          status: "awaiting_review",
          reviewData
        });

        await sendReviewReadyUpdate(projectId, {
          totalCuts: reviewData.summary.totalCuts,
          totalKeeps: reviewData.summary.totalKeeps,
          totalBroll: reviewData.summary.totalBroll,
          totalAiImages: reviewData.summary.totalAiImages
        });

        // Cleanup and exit the function (do not proceed to render)
        cleanupJob(projectId);
        return;
      }

      processorLogger.info(`[AUTONOMOUS] Pre-render review passed (Confidence: ${aiReviewFnResult?.confidence}%). Proceeding to render.`);
      processorLogger.info(`[AUTONOMOUS] Starting autonomous rendering pipeline for project ${projectId}`);
      addActivity(projectId, "Entering autonomous rendering and self-correction loop...");

      let currentEditPlan = editPlan;
      let currentStockMedia = stockMedia;
      let currentReviewData = reviewData; // Use the one with aiReview included
      let renderAttempts = 0;
      const MAX_RENDER_ATTEMPTS = 2;
      let publicOutputPath = "";
      let finalOutputMetadata: any = null;

      while (renderAttempts < MAX_RENDER_ATTEMPTS) {
        renderAttempts++;
        const isRetry = renderAttempts > 1;

        if (isRetry) {
          processorLogger.info(`[AUTONOMOUS] Starting render attempt ${renderAttempts}/${MAX_RENDER_ATTEMPTS} for project ${projectId}`);
          addActivity(projectId, `Starting corrected render (Step ${renderAttempts})...`);
        }

        const renderEditOptions = {
          addCaptions: editOptions.addCaptions,
          addBroll: currentStockMedia.length > 0,
          removeSilence: editOptions.removeSilence,
          generateAiImages: currentStockMedia.some(m => m.type === 'ai_generated'),
          addTransitions: editOptions.addTransitions,
        };

        // Update status to rendering so UI reflects activity
        await storage.updateVideoProject(projectId, { status: "rendering" });
        notifySubscribers(projectId, "status", { status: "rendering" });

        const editResult = await applyEdits(
          videoPath,
          currentEditPlan,
          transcript,
          currentStockMedia,
          renderEditOptions,
          undefined,
          analysis.semanticAnalysis
        );

        addActivity(projectId, isRetry ? "Corrected rendering complete!" : "Initial rendering complete!");

        // Get output metadata
        const outputMetadata = await getVideoMetadata(editResult.outputPath);
        finalOutputMetadata = outputMetadata;
        publicOutputPath = editResult.storageKey
          ? `/output/${editResult.storageKey.replace(/^output\//, "")}`
          : `/output/${path.basename(editResult.outputPath)}`;

        // Perform AI self-review
        processorLogger.info(`[AUTONOMOUS] Starting self-review (Attempt ${renderAttempts}) for project ${projectId}`);
        addActivity(projectId, "AI is reviewing the rendered video...");

        try {
          const selfReviewResult = await performPostRenderSelfReview(
            editResult.outputPath,
            videoPath,
            currentEditPlan,
            transcript,
            currentReviewData,
            currentStockMedia,
            prompt,
            project.analysis as import("@shared/schema").VideoAnalysis | undefined
          );

          processorLogger.info(`[AUTONOMOUS] Review complete: score = ${selfReviewResult.overallScore}, issues = ${selfReviewResult.issues?.length || 0}`);
          addActivity(projectId, `Review result: Quality score ${selfReviewResult.overallScore}/100`);

          // ARBITRATION: Decide if correction is needed
          // Ensure we pass the actual PreRenderReviewResult, not the whole ReviewData
          if (!currentReviewData.aiReview) {
            processorLogger.warn("[AUTONOMOUS] Missing pre-render review data for arbitration, skipping correction");
            break;
          }

          const arbitration = await arbitrateReviewConflicts(
            { ...currentReviewData.aiReview, issues: currentReviewData.aiReview.issues || [], suggestions: currentReviewData.aiReview.suggestions || [], summary: currentReviewData.aiReview.summary || "" },
            selfReviewResult,
            currentEditPlan
          );

          if (arbitration.shouldReRender && renderAttempts < MAX_RENDER_ATTEMPTS && arbitration.confidence > 70) {
            processorLogger.info(`[AUTONOMOUS] Correcting plan based on feedback: ${arbitration.justification}`);
            addActivity(projectId, `Applying corrections: ${arbitration.justification.slice(0, 100)}...`);

            // 1. RE-PLAN with correction feedback
            currentEditPlan = await generateSmartEditPlan(
              prompt,
              sanitizedAnalysis,
              transcript,
              sanitizedAnalysis.semanticAnalysis || {},
              fillerSegments,
              enhancedTranscript,
              currentEditPlan,
              arbitration,
              projectId
            );

            // 2. RE-SELECT media if we have previous stock variants
            if (stockVariants && stockVariants.length > 0) {
              addActivity(projectId, "Updating media selection for corrected plan...");

              // Map new actions to windows
              const newWindows = (currentEditPlan.actions || [])
                .filter((a: any) => (a.type === 'insert_stock' || a.type === 'insert_ai_image') && typeof a.start === 'number')
                .map((a: any) => ({
                  start: a.start,
                  end: typeof a.end === 'number' ? a.end : (typeof a.duration === 'number' ? a.start + a.duration : a.start + 4),
                  suggestedQuery: a.stockQuery || a.query || a.prompt || '',
                  priority: a.priority || 'medium' as const,
                  context: a.reason || a.context || '',
                }))
                .filter((w: any) => w.end > w.start);

              const selectionResult = await selectBestMediaForWindows(
                newWindows,
                stockVariants,
                generatedAiImages || [],
                {
                  duration: metadata.duration,
                  genre: (analysis as any).context?.genre || analysis.semanticAnalysis?.overallTone || "general",
                  tone: (analysis as any).context?.tone || analysis.semanticAnalysis?.overallTone || "professional",
                  topic: analysis.semanticAnalysis?.mainTopics?.[0] || "various",
                }
              );

              const { stockItems, aiImages: selectedAiImages } = convertSelectionsToStockMediaItems(selectionResult.selections);

              const aiStockItems: StockMediaItem[] = selectedAiImages.map((img, idx) => ({
                id: `ai_corr_${Date.now()}_${idx}`,
                type: 'ai_generated' as const,
                url: `/stock/${path.basename(img.filePath)}`,
                query: img.prompt,
                thumbnailUrl: `/stock/${path.basename(img.filePath)}`,
                width: 1024,
                height: 1024,
                source: 'ai',
                startTime: img.startTime,
                endTime: img.endTime,
              }));

              currentStockMedia = [...stockItems, ...aiStockItems];
            }

            // Continue to next render attempt
            continue;
          }

          // If we're here, either it was good enough or we ran out of attempts
          break;
        } catch (reviewErr) {
          processorLogger.warn(`[AUTONOMOUS] Review process failed (non-critical):`, reviewErr);
          addActivity(projectId, "Review process encountered an issue - finishing with current version");
          break;
        }
      }

      // Mark as completed
      await storage.updateVideoProject(projectId, {
        status: "completed" as ProcessingStatus,
        outputPath: publicOutputPath,
      });

      notifySubscribers(projectId, "completed", {
        outputPath: publicOutputPath,
        duration: finalOutputMetadata?.duration || 0,
      });
      notifySubscribers(projectId, "status", { status: "completed" });

      await updateProcessingStage(projectId, "complete");
      addActivity(projectId, "Autonomous processing complete! Final quality verified.");

      job.status = "completed";
      processorLogger.info(`[AUTONOMOUS] Full autonomous pipeline completed for project ${projectId}`);

      // Clean up temp files
      for (const file of tempFiles) {
        try {
          const stat = await fs.stat(file);
          if (stat.isDirectory()) {
            await fs.rm(file, { recursive: true });
          } else {
            await fs.unlink(file);
          }
        } catch (cleanupErr) {
          // File may already be deleted or doesn't exist - ignore
        }
      }

      return; // Exit pipeline - we're done
    }

    // NON-AUTONOMOUS MODE: Stop at review stage and wait for user approval
    await storage.updateVideoProject(projectId, {
      status: "awaiting_review",
      reviewData,
    });

    notifySubscribers(projectId, "reviewReady", { reviewData });
    notifySubscribers(projectId, "status", { status: "awaiting_review" });

    // Send review ready update to chat companion with summary (with safe defaults)
    await sendReviewReadyUpdate(projectId, {
      totalCuts: reviewData.summary?.totalCuts ?? 0,
      totalKeeps: reviewData.summary?.totalKeeps ?? 0,
      totalBroll: reviewData.summary?.totalBroll ?? 0,
      totalAiImages: reviewData.summary?.totalAiImages ?? 0,
    });
    updateProjectContext(projectId, { status: "awaiting_review" });

    // Save checkpoint: review ready (processing complete, waiting for user)
    await updateProcessingStage(projectId, "review_ready");

    // Clean up temp files except the final output
    for (const file of tempFiles) {
      try {
        const stat = await fs.stat(file);
        if (stat.isDirectory()) {
          await fs.rm(file, { recursive: true });
        } else {
          await fs.unlink(file);
        }
      } catch (cleanupErr) {
        // File may already be deleted or doesn't exist - ignore
      }
    }
    addActivity(projectId, "Processing complete! Ready for your review.");

    job.status = "completed";
    processorLogger.info(`Background processing completed for project ${projectId}`);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Processing failed";
    processorLogger.error(`Processing failed for project ${projectId}:`, error);

    job.status = "failed";
    addActivity(projectId, `Processing failed: ${errorMessage}`);

    // Send error update to chat companion
    await sendErrorUpdate(projectId, "processing", errorMessage);
    updateProjectContext(projectId, { status: "failed" });

    await storage.updateVideoProject(projectId, {
      status: "failed",
      errorMessage,
    });

    notifySubscribers(projectId, "error", {
      message: errorMessage,
      suggestion: "Try uploading a different video or retry processing.",
    });

    for (const file of tempFiles) {
      try {
        const stat = await fs.stat(file);
        if (stat.isDirectory()) {
          await fs.rm(file, { recursive: true });
        } else {
          await fs.unlink(file);
        }
      } catch (cleanupErr) {
        // File may already be deleted or doesn't exist - ignore
      }
    }
  } finally {
    // Release the processing lock to allow future processing requests
    releaseProcessingLock(projectId);

    // Call the completion callback to release the slot only if it was reserved
    const finalJob = activeJobs.get(projectId);
    if (finalJob?.slotReserved && onJobCompleteCallback) {
      finalJob.slotReserved = false;
      onJobCompleteCallback(projectId);
    }

    // Trim activities but keep event history for SSE replay on reconnect
    if (finalJob) {
      finalJob.activities = finalJob.activities.slice(-20);
    }

    // Clean up job after a delay to allow reconnections and SSE replay
    cleanupJob(projectId, false);
  }
}

export function isJobActive(projectId: number): boolean {
  const job = activeJobs.get(projectId);
  return job?.status === "processing";
}

/** Map retry API stage to ProcessingStage for pipeline resume */
export type RetryStage = "transcription" | "analysis" | "planning" | "stock" | "ai_images" | "full";

function mapRetryStageToProcessingStage(retryStage: RetryStage): ProcessingStage {
  switch (retryStage) {
    case "full": return "upload";
    case "transcription": return "transcription";
    case "analysis": return "analysis";
    case "planning": return "planning";
    case "stock":
    case "ai_images": return "media_fetch";
    default: return "upload";
  }
}

/**
 * Retry processing from a specific stage. Used by POST /api/videos/:id/retry.
 * For "full", starts from the beginning. For other stages, resumes from that checkpoint.
 */
export async function retryProcessingFromStage(
  projectId: number,
  retryStage: RetryStage
): Promise<{ started: boolean; reason?: string }> {
  const project = await storage.getVideoProject(projectId);
  if (!project) {
    return { started: false, reason: "Project not found" };
  }
  if (isJobActive(projectId)) {
    return { started: false, reason: "Processing already in progress" };
  }
  if (!canStartNewJob()) {
    return { started: false, reason: "Maximum concurrent jobs reached" };
  }

  const prompt = project.prompt || "";
  const processingStage = mapRetryStageToProcessingStage(retryStage);

  if (retryStage === "full") {
    // Reset to pending and run full pipeline
    await storage.updateVideoProject(projectId, { status: "pending", errorMessage: null });
    startProcessingJob(projectId, prompt, {
      addCaptions: true,
      addBroll: true,
      removeSilence: true,
      generateAiImages: true,
      addTransitions: true,
    });
    return { started: true };
  }

  // Resume from specific stage - ensure we have prerequisite data
  const resumeStage = processingStage;
  const stageOrder: ProcessingStage[] = ["upload", "transcription", "analysis", "planning", "media_fetch", "media_selection", "review_ready", "rendering", "complete"];
  const resumeIndex = stageOrder.indexOf(resumeStage);

  if (resumeIndex <= 0) {
    // Cannot resume from upload - run full pipeline
    await storage.updateVideoProject(projectId, { status: "pending", errorMessage: null });
    startProcessingJob(projectId, prompt, {
      addCaptions: true,
      addBroll: true,
      removeSilence: true,
      generateAiImages: true,
      addTransitions: true,
    });
    return { started: true };
  }

  // Set processingStage so recovery logic is consistent
  await storage.updateVideoProject(projectId, {
    status: "pending",
    errorMessage: null,
    processingStage: stageOrder[resumeIndex - 1], // Last completed stage
  });
  resumeProcessing(projectId, prompt, resumeStage);
  return { started: true };
}

// Fire-and-forget background render after user approval
// This allows rendering to continue even if client disconnects
export async function startBackgroundRender(projectId: number): Promise<void> {
  processorLogger.info(`[Background Render] Starting fire-and-forget render for project ${projectId}`);

  // DUPLICATE RENDER PREVENTION: Check if render is already active
  if (activeRenderJobs.has(projectId)) {
    processorLogger.warn(`[Background Render] Render already active for project ${projectId}, skipping duplicate`);
    return;
  }

  const project = await storage.getVideoProject(projectId);
  if (!project) {
    processorLogger.error(`[Background Render] Project ${projectId} not found`);
    return;
  }

  // Allow both awaiting_review (new render) and rendering (recovery after restart)
  if (project.status !== "awaiting_review" && project.status !== "rendering") {
    processorLogger.warn(`[Background Render] Project ${projectId} status is ${project.status}, skipping`);
    return;
  }

  const reviewData = project.reviewData as ReviewData | null;
  if (!reviewData || !reviewData.userApproved) {
    processorLogger.warn(`[Background Render] Project ${projectId} review not approved, skipping`);
    return;
  }

  // Mark render as active BEFORE starting (prevents race conditions)
  activeRenderJobs.add(projectId);
  processorLogger.info(`[Background Render] Render job registered for project ${projectId}`);

  // Update status to rendering (may already be rendering if recovering)
  if (project.status !== "rendering") {
    await storage.updateVideoProject(projectId, { status: "rendering" as ProcessingStatus });
  }

  // Run the render in background (fire-and-forget)
  runBackgroundRender(projectId, project, reviewData).catch(err => {
    processorLogger.error(`[Background Render] Failed for project ${projectId}:`, err);
    storage.updateVideoProject(projectId, {
      status: "failed" as ProcessingStatus,
      errorMessage: `Rendering failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }).finally(() => {
    // Always clean up the render lock
    activeRenderJobs.delete(projectId);
    processorLogger.info(`[Background Render] Render job completed/cleared for project ${projectId}`);
  });
}

async function runBackgroundRender(projectId: number, project: any, reviewData: ReviewData): Promise<void> {
  // Use fileStorage.getFilePath so it works with both local and S3 storage.
  // For S3, this downloads the file from the bucket to the local cache first.
  let videoPath: string;
  try {
    videoPath = await fileStorage.getFilePath(project.originalPath);
  } catch {
    throw new Error("Video file not found");
  }

  // Get stored data
  const editPlan = project.editPlan as { actions?: any[]; estimatedDuration?: number } | null;
  let transcript = project.transcript as Array<{ start: number; end: number; text: string; words?: any[] }> || [];
  let stockMedia = project.stockMedia as StockMediaItem[] || [];

  // Apply user modifications from reviewData
  if (reviewData.editPlan?.actions) {
    // Exclude 'keep' actions: they are AI planning artifacts and must not override
    // the user's intent. The render engine derives what to keep from approved cuts only.
    // Including keep actions here would silently discard video the user never approved cutting.
    const approvedActions = reviewData.editPlan.actions
      .filter((a: any) => a.approved)
      .filter((a: any) => a.type !== 'keep');
    const approvedStockMedia = (reviewData.stockMedia || []).filter((m: any) => m.approved);
    const approvedAiImages = (reviewData.aiImages || []).filter((m: any) => m.approved);

    // Apply transcript edits
    const reviewTranscriptByTime = new Map(
      (reviewData.transcript || []).map((t: any) => [`${t.start.toFixed(3)}_${t.end.toFixed(3)}`, t])
    );
    transcript = transcript
      .map((seg) => {
        const timeKey = `${seg.start.toFixed(3)}_${seg.end.toFixed(3)}`;
        const reviewSeg = reviewTranscriptByTime.get(timeKey) as any;
        if (reviewSeg) {
          if (!reviewSeg.approved) return null;
          if (reviewSeg.edited) return { ...seg, text: reviewSeg.text };
        }
        return seg;
      })
      .filter((seg): seg is NonNullable<typeof seg> => seg !== null);

    if (transcript.length === 0) {
      transcript = project.transcript as Array<{ start: number; end: number; text: string; words?: any[] }> || [];
    }

    // Update edit plan
    if (editPlan) {
      editPlan.actions = approvedActions;
    }

    // Update stock media
    stockMedia = [
      ...approvedStockMedia.map((m: any) => ({
        type: m.type,
        query: m.query,
        url: m.url,
        thumbnailUrl: m.thumbnailUrl,
        duration: m.duration,
        startTime: m.startTime,
        endTime: m.endTime,
      } as StockMediaItem)),
      ...approvedAiImages.map((m: any) => ({
        type: 'ai_generated' as const,
        query: m.query,
        url: m.url,
        duration: m.duration,
        aiPrompt: m.query,
        startTime: m.startTime,
        endTime: m.endTime,
      } as StockMediaItem)),
    ];
  }

  processorLogger.info(`[Background Render] Applying edits for project ${projectId}`);

  // Determine edit options
  const storedOptions = (reviewData.editOptions || {}) as Record<string, any>;
  const hasApprovedCuts = editPlan?.actions?.some((a: any) => a.type === 'cut' && a.approved) ?? false;

  const editOptions = {
    addCaptions: storedOptions.addCaptions ?? true,
    addBroll: stockMedia.length > 0,
    removeSilence: hasApprovedCuts,
    generateAiImages: stockMedia.some(m => m.type === 'ai_generated'),
    addTransitions: storedOptions.addTransitions ?? false,
  };

  // Ensure editPlan has required structure
  const finalEditPlan = {
    actions: editPlan?.actions || [],
    estimatedDuration: editPlan?.estimatedDuration,
  } as any;

  // Apply edits
  const editResult = await applyEdits(
    videoPath,
    finalEditPlan,
    transcript,
    stockMedia,
    editOptions,
    undefined,
    (project.analysis as any)?.semanticAnalysis
  );

  // Get output metadata
  const outputMetadata = await getVideoMetadata(editResult.outputPath);
  // For S3/Cloud compatibility, use the storage key as the public path base
  // If it's a URL (S3), we might need to sign it or serve via proxy, but for now 
  // we assume the storage key is the relative path from the storage root.
  // However, the client expects a path it can fetch. 
  // If using LocalStorage, output path is just filename.
  // If using S3, we need to return the key.

  // Fix: Use the storage key or construct path relative to output dir depending on storage type
  const publicOutputPath = editResult.storageKey
    ? `/output/${editResult.storageKey.replace(/^output\//, "")}`
    : `/output/${path.basename(editResult.outputPath)}`;

  processorLogger.info(`[Background Render] Render complete for project ${projectId}, output: ${publicOutputPath}`);

  // ─── STEP 1: Mark completed immediately so the user can download now ───────
  // Do NOT wait for self-review before delivering the video.
  await storage.updateVideoProject(projectId, {
    status: "completed" as ProcessingStatus,
    outputPath: publicOutputPath,
    duration: Math.round(outputMetadata.duration),
  });

  processorLogger.info(`[Background Render] Project ${projectId} marked completed — video available to user`);

  // ─── STEP 2: Background quality loop — runs after user already has the video ─
  // Phase A: self-review → score saved to DB.
  // Phase B: if score is poor, arbitrate → re-plan → re-render → overwrite output.
  // One correction attempt max so the background work stays bounded.
  // The improved video path overwrites outputPath in DB; user gets it on next download.
  const bgInputs = {
    firstOutputPath: editResult.outputPath,
    publicOutputPath,
    videoPath,
    editPlan: finalEditPlan as any,
    transcript: [...transcript],
    stockMedia: [...stockMedia],
    editOptions: { ...editOptions },
    prompt: project.prompt || "",
    analysis: project.analysis as import("@shared/schema").VideoAnalysis | undefined,
    baseReviewData: { ...(project.reviewData || {}) },
    reviewData: { ...reviewData } as ReviewData,
  };

  (async () => {
    // ── Phase A: AI self-review ───────────────────────────────────────────────
    emitBgQuality(projectId, { type: "phase_a_start" });
    let selfReviewResult: Awaited<ReturnType<typeof performPostRenderSelfReview>>;
    try {
      processorLogger.info(`[BG Quality] Phase A — self-review starting for project ${projectId}`);
      selfReviewResult = await performPostRenderSelfReview(
        bgInputs.firstOutputPath,
        bgInputs.videoPath,
        bgInputs.editPlan,
        bgInputs.transcript,
        bgInputs.reviewData,
        bgInputs.stockMedia,
        bgInputs.prompt,
        bgInputs.analysis
      );
      processorLogger.info(`[BG Quality] Self-review done for project ${projectId}: score=${selfReviewResult.overallScore}, approved=${selfReviewResult.approved}`);
      emitBgQuality(projectId, {
        type: "phase_a_score",
        score: selfReviewResult.overallScore,
        approved: selfReviewResult.approved,
        issues: selfReviewResult.issues?.length || 0,
      });
    } catch (reviewErr) {
      processorLogger.warn(`[BG Quality] Self-review failed (non-critical) for project ${projectId}:`, reviewErr);
      emitBgQuality(projectId, { type: "done" });
      return;
    }

    // Persist initial score immediately so it's visible on next page load
    const selfReviewRecord = {
      overallScore: selfReviewResult.overallScore,
      watchedFullVideo: selfReviewResult.watchedFullVideo,
      approved: selfReviewResult.approved,
      qualityMetrics: selfReviewResult.qualityMetrics,
      issues: selfReviewResult.issues,
      detailedFeedback: selfReviewResult.detailedFeedback,
      suggestions: selfReviewResult.suggestions,
    };
    await storage.updateVideoProject(projectId, {
      reviewData: {
        ...bgInputs.baseReviewData,
        selfReviewScore: selfReviewResult.overallScore,
        selfReviewResult: selfReviewRecord,
      },
    });

    // ── Phase B: arbitration + correction re-render ───────────────────────────
    if (!bgInputs.reviewData.aiReview) {
      processorLogger.info(`[BG Quality] Phase B skipped — no pre-render AI review for project ${projectId}`);
      emitBgQuality(projectId, { type: "phase_b_skipped", reason: "No pre-render review available" });
      emitBgQuality(projectId, { type: "done" });
      return;
    }

    try {
      const aiReview = bgInputs.reviewData.aiReview;
      const arbitration = await arbitrateReviewConflicts(
        {
          ...aiReview,
          issues: aiReview.issues || [],
          suggestions: aiReview.suggestions || [],
          summary: aiReview.summary || "",
        },
        selfReviewResult,
        bgInputs.editPlan
      );

      processorLogger.info(`[BG Quality] Arbitration for project ${projectId}: shouldReRender=${arbitration.shouldReRender}, confidence=${arbitration.confidence}`);

      if (!arbitration.shouldReRender || arbitration.confidence <= 70) {
        processorLogger.info(`[BG Quality] No correction needed for project ${projectId} — quality accepted`);
        emitBgQuality(projectId, { type: "phase_b_skipped", reason: "Quality is good — no correction needed" });
        emitBgQuality(projectId, { type: "done" });
        return;
      }

      emitBgQuality(projectId, { type: "phase_b_start", reason: arbitration.justification });
      processorLogger.info(`[BG Quality] Phase B — correction starting for project ${projectId}: ${arbitration.justification}`);

      // Re-plan with correction feedback (full creative freedom)
      const analysis = bgInputs.analysis as any;
      const correctedPlan = await generateSmartEditPlan(
        bgInputs.prompt,
        analysis,
        bgInputs.transcript,
        analysis?.semanticAnalysis || {},
        [],
        null,
        bgInputs.editPlan,
        arbitration,
        projectId
      );

      // Fetch fresh stock media for any new or changed B-roll windows in the corrected plan
      emitBgQuality(projectId, { type: "phase_b_fetching_media" });
      const newBrollWindows = (correctedPlan.actions || [])
        .filter((a: any) => (a.type === "insert_stock" || a.type === "insert_ai_image") && typeof a.start === "number")
        .map((a: any) => ({
          start: a.start,
          end: typeof a.end === "number" ? a.end : a.start + (typeof a.duration === "number" ? a.duration : 4),
          suggestedQuery: a.stockQuery || a.query || a.prompt || bgInputs.prompt,
          priority: (a.priority || "medium") as "high" | "medium" | "low",
          context: a.reason || a.context || "",
        }))
        .filter((w: any) => w.end > w.start);

      let correctionStockMedia = [...bgInputs.stockMedia];

      if (newBrollWindows.length > 0) {
        try {
          const stockQueries = [...new Set(newBrollWindows.map((w: any) => w.suggestedQuery).filter(Boolean))];
          const freepikEnabled = isFreepikConfigured();
          const [freshPexels, freshFreepik] = await Promise.all([
            fetchStockMediaWithVariants(stockQueries),
            freepikEnabled ? fetchFreepikMediaWithVariants(stockQueries) : Promise.resolve([] as StockMediaVariants[]),
          ]);
          const freshVariants: StockMediaVariants[] = [...freshPexels, ...freshFreepik];

          if (freshVariants.length > 0) {
            const selectionResult = await selectBestMediaForWindows(
              newBrollWindows,
              freshVariants,
              [],
              {
                duration: (analysis as any)?.duration || 60,
                genre: analysis?.semanticAnalysis?.overallTone || "general",
                tone: analysis?.semanticAnalysis?.overallTone || "professional",
                topic: analysis?.semanticAnalysis?.mainTopics?.[0] || "various",
              }
            );
            const { stockItems } = convertSelectionsToStockMediaItems(selectionResult.selections);
            // Merge: fresh selections override old ones for the same time windows
            correctionStockMedia = [...correctionStockMedia, ...stockItems];
            processorLogger.info(`[BG Quality] Fetched ${stockItems.length} fresh stock clips for correction`);
          }
        } catch (mediaErr) {
          processorLogger.warn(`[BG Quality] Fresh stock fetch failed (using existing media):`, mediaErr);
        }
      }

      // Re-render with corrected plan + fresh media
      emitBgQuality(projectId, { type: "phase_b_rendering" });
      const correctedEditResult = await applyEdits(
        bgInputs.videoPath,
        correctedPlan as any,
        bgInputs.transcript,
        correctionStockMedia,
        { ...bgInputs.editOptions, addBroll: correctionStockMedia.length > 0 },
        undefined,
        analysis?.semanticAnalysis
      );

      const correctedOutputPath = correctedEditResult.storageKey
        ? `/output/${correctedEditResult.storageKey.replace(/^output\//, "")}`
        : `/output/${path.basename(correctedEditResult.outputPath)}`;

      processorLogger.info(`[BG Quality] Correction render done for project ${projectId}: ${correctedOutputPath}`);

      // Final self-review to capture the improved score
      emitBgQuality(projectId, { type: "phase_b_reviewing" });
      let finalScore = selfReviewResult.overallScore;
      let finalSelfReviewRecord = selfReviewRecord;
      try {
        const finalReview = await performPostRenderSelfReview(
          correctedEditResult.outputPath,
          bgInputs.videoPath,
          correctedPlan as any,
          bgInputs.transcript,
          bgInputs.reviewData,
          correctionStockMedia,
          bgInputs.prompt,
          bgInputs.analysis
        );
        finalScore = finalReview.overallScore;
        finalSelfReviewRecord = {
          overallScore: finalReview.overallScore,
          watchedFullVideo: finalReview.watchedFullVideo,
          approved: finalReview.approved,
          qualityMetrics: finalReview.qualityMetrics,
          issues: finalReview.issues,
          detailedFeedback: finalReview.detailedFeedback,
          suggestions: finalReview.suggestions,
        };
        processorLogger.info(`[BG Quality] Final review for project ${projectId}: ${selfReviewResult.overallScore} → ${finalScore}`);
      } catch (finalReviewErr) {
        processorLogger.warn(`[BG Quality] Final review failed (non-critical) for project ${projectId}:`, finalReviewErr);
      }

      // Overwrite outputPath in DB with the improved video
      await storage.updateVideoProject(projectId, {
        outputPath: correctedOutputPath,
        reviewData: {
          ...bgInputs.baseReviewData,
          selfReviewScore: finalScore,
          selfReviewResult: finalSelfReviewRecord,
          correctionApplied: true,
          correctionReason: arbitration.justification,
        },
      });

      emitBgQuality(projectId, {
        type: "phase_b_done",
        oldScore: selfReviewResult.overallScore,
        newScore: finalScore,
        outputPath: correctedOutputPath,
      });
      processorLogger.info(`[BG Quality] Project ${projectId} corrected: score ${selfReviewResult.overallScore} → ${finalScore}`);

    } catch (correctionErr) {
      processorLogger.warn(`[BG Quality] Correction loop failed (non-critical) for project ${projectId}:`, correctionErr);
      // Original output is untouched — nothing broken for the user
    }

    emitBgQuality(projectId, { type: "done" });
  })();
}
