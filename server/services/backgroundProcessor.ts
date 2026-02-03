import { storage } from "../storage";
import { getVideoMetadata, extractFrames, extractAudio, detectSilence, applyEdits } from "./videoProcessor";
import { analyzeVideoDeep, generateSmartEditPlan, transcribeAudioEnhanced, detectFillerWords } from "./ai";
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
const LOCK_TIMEOUT_MS = 30 * 60 * 1000;
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
function startStaleJobCleanup(): void {
  if (staleJobCleanupInterval) return; // Already started

  staleJobCleanupInterval = setInterval(() => {
    const now = Date.now();
    let cleanedCount = 0;

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
          storage.updateVideoProject(projectId, {
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

            storage.updateVideoProject(projectId, {
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
  }, STALE_JOB_CLEANUP_INTERVAL_MS);
}

/**
 * Stop the stale job cleanup interval.
 * Call this during graceful shutdown to prevent memory leaks.
 */
export function stopStaleJobCleanup(): void {
  if (staleJobCleanupInterval) {
    clearInterval(staleJobCleanupInterval);
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
async function resumeProcessing(projectId: number, prompt: string, resumeFromStage: ProcessingStage): Promise<void> {
  if (!canStartNewJob()) {
    processorLogger.warn(`Cannot resume project ${projectId}: max concurrent jobs reached, will retry later`);
    // Retry in 30 seconds
    setTimeout(() => resumeProcessing(projectId, prompt, resumeFromStage), 30000);
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
  const editOptions: EditOptionsType = {
    addCaptions: true,
    addBroll: true,
    removeSilence: true,
    generateAiImages: true,
    addTransitions: true,
  };

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

    const videoPath = path.join(UPLOADS_DIR, path.basename(project.originalPath));

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
      enhancedTranscript
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

    if (editOptions.addBroll && stockQueries.length > 0) {
      // PARALLEL PHASE 3: Fetch stock media AND generate AI images simultaneously
      // These are completely independent operations
      const shouldGenerateAi = editOptions.generateAiImages && analysis.semanticAnalysis;

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
      const stockVariants: StockMediaVariants[] = pexelsVariants.map((pexelsResult, idx) => {
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

      const generatedAiImages = aiImagesResult || [];
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
        brollWindows as { start: number; end: number; suggestedQuery: string; priority: "high" | "medium" | "low"; context?: string }[],
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

      // Guardrail: Check if AI images were generated but not selected
      // If no AI images were selected despite generation, force-include the best ones
      let finalAiImages = selectedAiImages;
      if (generatedAiImages.length > 0 && selectedAiImages.length === 0) {
        processorLogger.warn(`GUARDRAIL: ${generatedAiImages.length} AI images generated but 0 selected - forcing inclusion of top candidates`);

        // Take up to 3 generated images based on which have the best timing spread
        const sortedByStart = [...generatedAiImages].sort((a, b) => a.startTime - b.startTime);
        const numToInclude = Math.min(3, sortedByStart.length);

        // Try to spread them across the video
        if (numToInclude === 1) {
          finalAiImages = sortedByStart.slice(0, 1);
        } else if (numToInclude === 2) {
          // Take first and last
          finalAiImages = [sortedByStart[0], sortedByStart[sortedByStart.length - 1]];
        } else {
          // Take first, middle, and last for good distribution
          const middleIdx = Math.floor(sortedByStart.length / 2);
          finalAiImages = [sortedByStart[0], sortedByStart[middleIdx], sortedByStart[sortedByStart.length - 1]];
        }

        processorLogger.info(`GUARDRAIL: Force-included ${finalAiImages.length} AI images at times: ${finalAiImages.map(img => img.startTime.toFixed(1) + 's').join(', ')}`);
        addActivity(projectId, `Recovered ${finalAiImages.length} AI images via fallback selection`);
      }

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
          approved: true,
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
      userApproved: editOptions.autonomousMode === true, // Auto-approve in autonomous mode
    };

    // AUTONOMOUS MODE: Continue directly to rendering without stopping for user review
    if (editOptions.autonomousMode) {
      processorLogger.info(`[AUTONOMOUS] Auto - approving all edits and proceeding to render for project ${projectId}`);
      addActivity(projectId, "Autonomous mode: Auto-approving all edits and proceeding to render...");

      await storage.updateVideoProject(projectId, {
        status: "rendering" as ProcessingStatus,
        reviewData,
      });
      notifySubscribers(projectId, "status", { status: "rendering" });

      // Perform autonomous rendering
      await updateStatus("rendering");
      addActivity(projectId, "Starting autonomous rendering...");

      const finalEditPlan = {
        ...editPlan,
        actions: editPlan.actions || [],
      };

      const renderEditOptions = {
        addCaptions: editOptions.addCaptions,
        addBroll: stockMedia.length > 0,
        removeSilence: editOptions.removeSilence,
        generateAiImages: stockMedia.some(m => m.type === 'ai_generated'),
        addTransitions: editOptions.addTransitions,
      };

      const editResult = await applyEdits(
        videoPath,
        finalEditPlan,
        transcript,
        stockMedia,
        renderEditOptions,
        undefined,
        analysis.semanticAnalysis
      );

      addActivity(projectId, "Autonomous rendering complete!");

      // Get output metadata
      const outputMetadata = await getVideoMetadata(editResult.outputPath);
      const publicOutputPath = editResult.storageKey
        ? `/output/${editResult.storageKey.replace(/^output\//, "")}`
        : `/output/${path.basename(editResult.outputPath)}`;

      addActivity(projectId, `Final video: ${Math.round(outputMetadata.duration)}s`);

      // Perform AI self-review in background
      processorLogger.info(`[AUTONOMOUS] Starting self - review for project ${projectId}`);
      addActivity(projectId, "AI is reviewing the rendered video...");

      try {
        const selfReviewResult = await performPostRenderSelfReview(
          editResult.outputPath,
          videoPath,
          finalEditPlan,
          transcript,
          reviewData,
          stockMedia,
          prompt,
          project.analysis as import("@shared/schema").VideoAnalysis | undefined
        );

        processorLogger.info(`[AUTONOMOUS] Self - review complete: score = ${selfReviewResult.overallScore}, issues = ${selfReviewResult.issues?.length || 0} `);
        addActivity(projectId, `Self - review complete: Quality score ${selfReviewResult.overallScore}/100`);

        // ARBITRATION: Decide if correction is needed
        if (reviewData) {
          const arbitration = await arbitrateReviewConflicts(
            reviewData as any,
            selfReviewResult,
            finalEditPlan
          );

          if (arbitration.shouldReRender && arbitration.confidence > 80) {
            processorLogger.info(`[AUTONOMOUS] Arbitrator triggered RE-RENDER for project ${projectId}: ${arbitration.justification}`);
            addActivity(projectId, `Arbitrator suggesting correction: ${arbitration.justification}`);
            // In a full implementation, we would recursively call runProcessingPipeline with the new correctionPlan
            // For now, we'll log it and mark it as 'needs_correction' or similar
          }
        }

        // Log self-review results (stored in project analysis for reference)
        processorLogger.info(`[AUTONOMOUS] Self-review stored for project ${projectId}`);
      } catch (reviewErr) {
        processorLogger.warn(`[AUTONOMOUS] Self-review failed (non-critical):`, reviewErr);
        addActivity(projectId, "Self-review skipped - continuing to completion");
      }

      // Mark as completed
      await storage.updateVideoProject(projectId, {
        status: "completed" as ProcessingStatus,
        outputPath: publicOutputPath,
      });

      notifySubscribers(projectId, "completed", {
        outputPath: publicOutputPath,
        duration: outputMetadata.duration,
      });
      notifySubscribers(projectId, "status", { status: "completed" });

      await updateProcessingStage(projectId, "complete");
      addActivity(projectId, "Autonomous processing complete! Video ready for download.");

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
  const videoPath = path.join(UPLOADS_DIR, path.basename(project.originalPath));

  try {
    await fs.access(videoPath);
  } catch {
    throw new Error("Video file not found");
  }

  // Get stored data
  const editPlan = project.editPlan as { actions?: any[]; estimatedDuration?: number } | null;
  let transcript = project.transcript as Array<{ start: number; end: number; text: string; words?: any[] }> || [];
  let stockMedia = project.stockMedia as StockMediaItem[] || [];

  // Apply user modifications from reviewData
  if (reviewData.editPlan?.actions) {
    const approvedActions = reviewData.editPlan.actions.filter((a: any) => a.approved);
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
  const publicOutputPath = `/output/${path.basename(editResult.outputPath)}`;

  processorLogger.info(`[Background Render] Complete for project ${projectId}, output: ${publicOutputPath}`);

  // Perform self-review in background and persist results
  let selfReviewData: { selfReviewScore?: number; selfReviewResult?: any } = {};
  try {
    const selfReviewResult = await performPostRenderSelfReview(
      editResult.outputPath,
      videoPath,
      finalEditPlan,
      transcript,
      reviewData,
      stockMedia,
      project.prompt || "",
      project.analysis as import("@shared/schema").VideoAnalysis | undefined
    );
    processorLogger.info(`[Background Render] Self-review complete: score=${selfReviewResult.overallScore}`);

    // Persist self-review results to reviewData for future reference
    selfReviewData = {
      selfReviewScore: selfReviewResult.overallScore,
      selfReviewResult: {
        overallScore: selfReviewResult.overallScore,
        watchedFullVideo: selfReviewResult.watchedFullVideo,
        approved: selfReviewResult.approved,
        qualityMetrics: selfReviewResult.qualityMetrics,
        issues: selfReviewResult.issues,
        detailedFeedback: selfReviewResult.detailedFeedback,
        suggestions: selfReviewResult.suggestions,
      },
    };
  } catch (reviewErr) {
    processorLogger.warn(`[Background Render] Self-review failed (non-critical):`, reviewErr);
  }

  // Mark as completed and store self-review if available
  const updateData: any = {
    status: "completed" as ProcessingStatus,
    outputPath: publicOutputPath,
  };

  // Merge self-review data into reviewData if available
  if (selfReviewData.selfReviewScore !== undefined) {
    const existingReviewData = project.reviewData || {};
    updateData.reviewData = {
      ...existingReviewData,
      selfReviewScore: selfReviewData.selfReviewScore,
      selfReviewResult: selfReviewData.selfReviewResult,
    };
  }

  await storage.updateVideoProject(projectId, updateData);

  processorLogger.info(`[Background Render] Project ${projectId} completed successfully`);
}
