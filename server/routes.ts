import type { Express, Request, Response } from "express";
import { type Server } from "http";
import multer from "multer";
import path from "path";
import { promises as fs } from "fs";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { storage } from "./storage";
import { createLogger } from "./utils/logger";
import { formatErrorForSSE, getUserFriendlyError } from "./utils/errorMessages";
import { validateVideoMagicBytes } from "./utils/fileValidation";
import { AI_CONFIG } from "./config/ai";

// Zod schemas for query/path parameter validation
const idParamSchema = z.object({
  id: z.coerce.number().int().positive("ID must be a positive integer"),
});

const booleanQueryParam = (defaultValue: boolean) =>
  z.string().optional().transform(v => {
    if (v === undefined) return defaultValue;
    return v === "true";
  });

const processQuerySchema = z.object({
  prompt: z.string().min(1, "Prompt is required"),
  addCaptions: booleanQueryParam(true),
  addBroll: booleanQueryParam(true),
  removeSilence: booleanQueryParam(true),
  generateAiImages: booleanQueryParam(true),
  addTransitions: booleanQueryParam(false),
  skipReview: booleanQueryParam(false),
  reconnect: booleanQueryParam(false),
});

// Helper to format Zod errors for user-friendly 400 responses
function formatZodError(error: z.ZodError): string {
  return error.errors.map(e => `${e.path.join(".")}: ${e.message}`).join(", ");
}

const routesLogger = createLogger("routes");
import {
  getVideoMetadata,
  extractFrames,
  extractAudio,
  detectSilence,
  applyEdits,
  cleanupTempFiles,
  UPLOADS_DIR,
  OUTPUT_DIR,
  ensureDirs,
  type EditOptions,
} from "./services/videoProcessor";
import {
  analyzeVideoFrames,
  transcribeAudio,
  generateEditPlan,
  analyzeTranscriptSemantics,
  generateAiImagesForVideo,
  detectTranscriptLanguage,
  translateTranscriptToEnglish,
  analyzeVideoDeep,
  generateSmartEditPlan,
  detectFillerWords,
  performPreRenderReview,
  performPostRenderSelfReview,
  shouldAutoCorrect,
  generateCorrectionPlan,
  applyCorrectionPlan,
  shouldTriggerReRender,
  storePattern,
} from "./services/aiService";
import type { SemanticAnalysis, StockMediaItem, ProcessingStatus, ReviewData, ReviewMediaItem, ReviewEditAction, ReviewTranscriptSegment, EditOptionsType } from "@shared/schema";
import { editPlanSchema, reviewDataSchema } from "@shared/schema";
import { fetchStockMedia } from "./services/pexelsService";
import { requireAuth, type AuthenticatedRequest } from "./middleware/auth";
import { registerAuthRoutes } from "./routes/auth";
import {
  initializeProjectChat,
  updateProjectContext,
  getProjectMessages,
  addUserMessage,
  answerUserQuestion,
  sendUploadUpdate,
  sendTranscriptionUpdate,
  sendAnalysisUpdate,
  sendEditPlanningUpdate,
  sendMediaFetchingUpdate,
  sendMediaSelectionUpdate,
  sendReviewReadyUpdate,
  sendRenderingUpdate,
  sendSelfReviewUpdate,
  sendCorrectionUpdate,
  sendCompletionUpdate,
  sendErrorUpdate,
} from "./services/chatCompanion";
import { 
  startProcessingJob as startBackgroundProcessing, 
  subscribeToJob, 
  getJobActivities, 
  isJobActive,
  setOnJobComplete,
  canStartNewJob,
  getActiveJobCount,
  getActiveJobsInfo,
  getEventsSince,
  getLastEventId,
  MAX_CONCURRENT_JOBS
} from "./services/backgroundProcessor";

// Use unified slot management from backgroundProcessor
function canStartProcessing(): boolean {
  return canStartNewJob();
}

function getProcessingStatus(): { current: number; max: number; jobs: { id: number; startTime: Date; status: string }[] } {
  return {
    current: getActiveJobCount(),
    max: MAX_CONCURRENT_JOBS,
    jobs: getActiveJobsInfo()
  };
}

const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, cb) => {
      await ensureDirs();
      cb(null, UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
      const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
      cb(null, uniqueName);
    },
  }),
  limits: {
    fileSize: 1024 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("video/")) {
      cb(null, true);
    } else {
      cb(new Error("Only video files are allowed"));
    }
  },
});

function getSecurePath(baseDir: string, requestedPath: string): string | null {
  try {
    const decodedPath = decodeURIComponent(requestedPath);
    if (decodedPath.includes('\x00')) {
      return null;
    }
    if (decodedPath.includes('..')) {
      return null;
    }
    const normalizedPath = path.normalize(decodedPath);
    if (normalizedPath.includes('..')) {
      return null;
    }
    const cleanPath = normalizedPath.replace(/^[\/\\]+/, '');
    if (cleanPath.includes('..')) {
      return null;
    }
    const resolvedBase = path.resolve(baseDir);
    const resolvedFile = path.resolve(baseDir, cleanPath);
    const finalResolved = path.resolve(resolvedFile);
    if (finalResolved.includes('..')) {
      return null;
    }
    if (!finalResolved.startsWith(resolvedBase + path.sep) && finalResolved !== resolvedBase) {
      return null;
    }
    return finalResolved;
  } catch {
    return null;
  }
}

// Helper function to prepare review data for user approval
function prepareReviewData(
  transcript: Array<{ start: number; end: number; text: string; words?: Array<{ word: string; start: number; end: number }> }>,
  editPlan: { actions?: Array<any>; estimatedDuration?: number },
  stockMedia: StockMediaItem[],
  originalDuration: number,
  editOptions?: EditOptions
): ReviewData {
  // Convert transcript to review format with IDs
  const reviewTranscript: ReviewTranscriptSegment[] = transcript.map((seg, idx) => ({
    id: `transcript_${idx}`,
    start: seg.start,
    end: seg.end,
    text: seg.text,
    words: seg.words,
    approved: true,
    edited: false,
  }));

  // Convert edit actions to review format with IDs and reasons
  const reviewActions: ReviewEditAction[] = (editPlan.actions || []).map((action, idx) => ({
    id: `action_${idx}`,
    type: action.type,
    start: action.start,
    end: action.end,
    duration: action.duration,
    text: action.text,
    reason: action.reason || getDefaultReason(action.type),
    approved: true,
  }));

  // Separate stock media and AI images
  const reviewStockMedia: ReviewMediaItem[] = stockMedia
    .filter(m => m.type !== 'ai_generated')
    .map((m, idx) => ({
      id: `stock_${idx}`,
      type: m.type as 'image' | 'video' | 'ai_generated',
      query: m.query,
      url: m.url,
      thumbnailUrl: m.thumbnailUrl,
      duration: m.duration,
      startTime: m.startTime,
      endTime: m.endTime,
      reason: `Matches: "${m.query}"`,
      approved: true,
    }));

  const reviewAiImages: ReviewMediaItem[] = stockMedia
    .filter(m => m.type === 'ai_generated')
    .map((m, idx) => ({
      id: `ai_${idx}`,
      type: 'ai_generated' as const,
      query: m.aiPrompt || m.query,
      url: m.url,
      duration: m.duration,
      startTime: m.startTime,
      endTime: m.endTime,
      reason: `AI generated for: "${m.aiPrompt?.substring(0, 50) || m.query}"`,
      approved: true,
    }));

  // Calculate summary statistics
  const cuts = reviewActions.filter(a => a.type === 'cut');
  const keeps = reviewActions.filter(a => a.type === 'keep');
  const totalCutDuration = cuts.reduce((sum, c) => sum + ((c.end || 0) - (c.start || 0)), 0);
  const estimatedFinalDuration = editPlan.estimatedDuration || (originalDuration - totalCutDuration);

  return {
    transcript: reviewTranscript,
    editPlan: {
      actions: reviewActions,
      estimatedDuration: estimatedFinalDuration,
      originalDuration,
    },
    stockMedia: reviewStockMedia,
    aiImages: reviewAiImages,
    summary: {
      originalDuration,
      estimatedFinalDuration: Math.max(0, estimatedFinalDuration),
      totalCuts: cuts.length,
      totalKeeps: keeps.length,
      totalBroll: reviewStockMedia.length,
      totalAiImages: reviewAiImages.length,
    },
    userApproved: false,
    editOptions: editOptions ? {
      addCaptions: editOptions.addCaptions ?? true,
      addBroll: editOptions.addBroll ?? true,
      removeSilence: editOptions.removeSilence ?? true,
      generateAiImages: editOptions.generateAiImages ?? false,
      addTransitions: editOptions.addTransitions ?? false,
    } : undefined,
  };
}

function getDefaultReason(actionType: string): string {
  switch (actionType) {
    case 'cut': return 'Removing to improve pacing';
    case 'keep': return 'Important content to retain';
    case 'insert_stock': return 'Adding visual variety with B-roll';
    case 'insert_ai_image': return 'AI-generated visual for context';
    default: return 'Edit action';
  }
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  await ensureDirs();
  
  // Log when background processor jobs complete (slots are managed internally now)
  setOnJobComplete((projectId) => {
    routesLogger.info(`Processing job completed for project ${projectId}`);
  });
  
  // Health check endpoint - no authentication required for load balancer checks
  app.get("/api/health", (req, res) => {
    res.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: "1.0.0",
    });
  });
  
  registerAuthRoutes(app);

  app.use("/uploads", async (req, res, next) => {
    const filePath = getSecurePath(UPLOADS_DIR, req.path);
    if (!filePath) {
      return res.status(403).json({ error: "Access denied" });
    }
    try {
      await fs.access(filePath);
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.mp4') {
        res.setHeader("Content-Type", "video/mp4");
      } else if (ext === '.webm') {
        res.setHeader("Content-Type", "video/webm");
      } else if (ext === '.mov') {
        res.setHeader("Content-Type", "video/quicktime");
      }
      res.sendFile(filePath);
    } catch {
      next();
    }
  });

  app.use("/output", async (req, res, next) => {
    const filePath = getSecurePath(OUTPUT_DIR, req.path);
    if (!filePath) {
      return res.status(403).json({ error: "Access denied" });
    }
    try {
      await fs.access(filePath);
      res.setHeader("Content-Type", "video/mp4");
      res.sendFile(filePath);
    } catch {
      next();
    }
  });

  app.post(
    "/api/videos/upload",
    requireAuth,
    upload.single("video"),
    async (req: Request, res: Response) => {
      try {
        if (!req.file) {
          return res.status(400).json({ error: "No video file uploaded" });
        }

        const filePath = req.file.path;
        
        const magicBytesResult = await validateVideoMagicBytes(filePath);
        if (!magicBytesResult.valid) {
          await fs.unlink(filePath).catch(() => {});
          return res.status(400).json({
            error: magicBytesResult.error || "Invalid video file format",
            suggestion: "Please upload a valid video file (MP4, MOV, WebM, or AVI)",
          });
        }

        const metadata = await getVideoMetadata(filePath);

        // Check video duration limit (default: 30 minutes = 1800 seconds)
        const maxDurationSeconds = parseInt(process.env.MAX_VIDEO_DURATION_SECONDS || "1800", 10);
        if (metadata.duration > maxDurationSeconds) {
          // Clean up the uploaded file since it exceeds the limit
          await fs.unlink(filePath).catch(() => {});
          const maxMinutes = Math.floor(maxDurationSeconds / 60);
          const videoMinutes = Math.floor(metadata.duration / 60);
          const videoSeconds = Math.round(metadata.duration % 60);
          return res.status(400).json({
            error: `Video duration (${videoMinutes}m ${videoSeconds}s) exceeds the maximum allowed duration of ${maxMinutes} minutes. Please upload a shorter video.`,
          });
        }

        const project = await storage.createVideoProject({
          fileName: req.file.originalname,
          originalPath: `/uploads/${path.basename(filePath)}`,
          status: "pending",
          duration: Math.round(metadata.duration),
        });

        res.json({
          id: project.id,
          originalPath: project.originalPath,
          duration: project.duration,
        });
      } catch (error) {
        routesLogger.error("Upload error:", error);
        const friendlyError = getUserFriendlyError(error instanceof Error ? error : new Error("Upload failed"));
        res.status(500).json({
          error: friendlyError.message,
          suggestion: friendlyError.suggestion,
          errorType: friendlyError.errorType,
        });
      }
    }
  );

  // Get video project history (returns all projects for history panel)
  // IMPORTANT: This route must be BEFORE /api/videos/:id to avoid :id matching "history"
  app.get("/api/videos/history", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const projects = await storage.getAllVideoProjects();
      const historyItems = projects.map(p => ({
        id: p.id,
        title: p.fileName,
        status: p.status,
        duration: p.duration,
        createdAt: p.createdAt.toISOString(),
        expiresAt: p.expiresAt.toISOString(),
        outputPath: p.outputPath || undefined,
      }));
      res.json(historyItems);
    } catch (error) {
      routesLogger.error("Failed to get video history:", error);
      res.status(500).json({ error: "Failed to get video history" });
    }
  });

  app.get("/api/videos/:id", async (req: Request, res: Response) => {
    try {
      const paramResult = idParamSchema.safeParse(req.params);
      if (!paramResult.success) {
        return res.status(400).json({ error: formatZodError(paramResult.error) });
      }
      const { id } = paramResult.data;
      
      const project = await storage.getVideoProject(id);

      if (!project) {
        return res.status(404).json({ error: "Project not found" });
      }

      res.json(project);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to get project",
      });
    }
  });

  app.put("/api/videos/:id/editplan", async (req: Request, res: Response) => {
    try {
      const paramResult = idParamSchema.safeParse(req.params);
      if (!paramResult.success) {
        return res.status(400).json({ error: formatZodError(paramResult.error) });
      }
      const { id } = paramResult.data;

      const { editPlan } = req.body;
      if (!editPlan) {
        return res.status(400).json({ error: "editPlan is required" });
      }

      // Validate editPlan structure
      const editPlanResult = editPlanSchema.safeParse(editPlan);
      if (!editPlanResult.success) {
        return res.status(400).json({ error: formatZodError(editPlanResult.error) });
      }

      const project = await storage.getVideoProject(id);
      if (!project) {
        return res.status(404).json({ error: "Project not found" });
      }

      await storage.updateVideoProject(id, { editPlan: editPlanResult.data });
      
      const updatedProject = await storage.getVideoProject(id);
      res.json({ editPlan: updatedProject?.editPlan });
    } catch (error) {
      routesLogger.error("Edit plan update error:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to update edit plan",
      });
    }
  });

  app.get("/api/videos/:id/process", requireAuth, async (req: Request, res: Response) => {
    // Validate path parameters
    const paramResult = idParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      return res.status(400).json({ error: formatZodError(paramResult.error) });
    }
    const { id } = paramResult.data;
    
    // Check multi-processing limit
    if (!canStartProcessing() && !isJobActive(id)) {
      const status = getProcessingStatus();
      return res.status(429).json({ 
        error: `Maximum ${MAX_CONCURRENT_JOBS} videos can be processed at once. Please wait for a slot.`,
        processingStatus: status
      });
    }
    
    // Validate query parameters
    const queryResult = processQuerySchema.safeParse(req.query);
    if (!queryResult.success) {
      return res.status(400).json({ error: formatZodError(queryResult.error) });
    }
    
    const { prompt, addCaptions, addBroll, removeSilence, generateAiImages, addTransitions, reconnect } = queryResult.data;
    
    const editOptions = {
      addCaptions,
      addBroll,
      removeSilence,
      generateAiImages,
      addTransitions,
    };

    const project = await storage.getVideoProject(id);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

    const videoPath = path.join(
      UPLOADS_DIR,
      path.basename(project.originalPath)
    );
    
    try {
      await fs.access(videoPath);
    } catch {
      return res.status(404).json({ error: "Video file not found. Please re-upload your video." });
    }

    // Setup SSE for real-time updates
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    
    // Disable request timeout for long-running SSE connection
    req.setTimeout(0);

    let connectionClosed = false;
    
    // Parse Last-Event-ID from header or query param for replay support
    // (EventSource API doesn't support custom headers, so we also check query param)
    const lastEventIdHeader = req.headers["last-event-id"];
    const lastEventIdQuery = req.query.lastEventId;
    const lastEventIdRaw = lastEventIdQuery || lastEventIdHeader;
    const clientLastEventId = lastEventIdRaw ? parseInt(lastEventIdRaw as string, 10) : 0;

    // Send event with ID for replay support
    const sendEventWithId = (eventId: number, type: string, data: Record<string, unknown>) => {
      if (!connectionClosed) {
        res.write(`id: ${eventId}\n`);
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
      }
    };
    
    // Send event without ID (for initial messages)
    const sendEvent = (type: string, data: Record<string, unknown>) => {
      if (!connectionClosed) {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
      }
    };

    const heartbeatInterval = setInterval(() => {
      if (!connectionClosed) {
        res.write(": heartbeat\n\n");
      }
    }, AI_CONFIG.processing.sseHeartbeatMs);

    const jobAlreadyRunning = isJobActive(id);
    const completedStatuses = ["awaiting_review", "completed", "failed", "cancelled"];
    const isAlreadyCompleted = completedStatuses.includes(project.status);
    
    // Detect stale processing state: DB shows in-progress but no job in memory
    // This happens when server restarts while processing was ongoing
    const inProgressStatuses = ["analyzing", "transcribing", "planning", "fetching_stock", "generating_ai_images", "editing"];
    const isStaleProcessing = inProgressStatuses.includes(project.status) && !jobAlreadyRunning;

    // Handle stale processing state - don't restart from scratch silently
    if (isStaleProcessing) {
      routesLogger.info(`Detected stale processing state for project ${id} (status: ${project.status}, no active job)`);
      
      // Check what data we already have to determine recovery options
      const hasTranscript = project.transcript && Array.isArray(project.transcript) && project.transcript.length > 0;
      const hasEditPlan = project.editPlan && typeof project.editPlan === 'object';
      const hasStockMedia = project.stockMedia && Array.isArray(project.stockMedia) && project.stockMedia.length > 0;
      
      // Always inform user about interrupted processing - whether reconnect or not
      // This prevents silent restart from scratch
      sendEvent("activity", { message: "Processing was interrupted and needs to be restarted.", timestamp: Date.now() });
      sendEvent("status", { status: project.status });
      
      sendEvent("staleRecovery", { 
        interrupted: true,
        lastStatus: project.status,
        hasTranscript,
        hasEditPlan,
        hasStockMedia,
        message: "Processing was interrupted. Click 'Retry Processing' to restart."
      });
      
      clearInterval(heartbeatInterval);
      res.end();
      return;
    }

    // If reconnecting, only subscribe to existing job - don't start new processing
    if (reconnect && jobAlreadyRunning) {
      routesLogger.info(`Reconnecting to existing processing job for project ${id}, lastEventId: ${clientLastEventId}`);
      sendEvent("activity", { message: "Reconnecting to your processing session...", timestamp: Date.now() });
      
      // Send current project status
      sendEvent("status", { status: project.status });
      
      // Replay missed events since client's last known event ID
      if (clientLastEventId > 0) {
        const missedEvents = getEventsSince(id, clientLastEventId);
        routesLogger.info(`Replaying ${missedEvents.length} missed events for project ${id}`);
        for (const event of missedEvents) {
          sendEventWithId(event.id, event.type, event.data);
        }
      } else {
        // No last event ID - send recent activities as fallback
        const activities = getJobActivities(id);
        for (const activity of activities.slice(-10)) {
          sendEvent("activity", activity);
        }
      }
    } else if (reconnect && isAlreadyCompleted) {
      // Reconnect request but project already completed - just send status
      routesLogger.info(`Reconnect for already-completed project ${id} (status: ${project.status})`);
      sendEvent("status", { status: project.status });
      if (project.status === "awaiting_review" && project.reviewData) {
        sendEvent("reviewReady", { reviewData: project.reviewData });
      }
      clearInterval(heartbeatInterval);
      res.end();
      return;
    } else if (!jobAlreadyRunning && !isAlreadyCompleted) {
      // Start new background processing job only if not already completed
      if (!canStartProcessing()) {
        clearInterval(heartbeatInterval);
        return res.status(429).json({ 
          error: "Processing slot no longer available. Please try again.",
          processingStatus: getProcessingStatus()
        });
      }
      
      routesLogger.info(`Starting background processing for project ${id}`);
      startBackgroundProcessing(id, prompt, editOptions);
    } else if (jobAlreadyRunning) {
      // Job is running but this is not a reconnect - subscribe to updates
      routesLogger.info(`Subscribing to in-progress job for project ${id}`);
      sendEvent("activity", { message: "Resuming your processing session...", timestamp: Date.now() });
    } else {
      // Project is already complete - don't start processing
      routesLogger.info(`Project ${id} already in terminal state: ${project.status}`);
      sendEvent("status", { status: project.status });
      clearInterval(heartbeatInterval);
      res.end();
      return;
    }

    // Subscribe to job updates - this will receive events from background processor
    const unsubscribe = subscribeToJob(id, (event) => {
      if (!connectionClosed) {
        // Send event with ID for client-side tracking and replay support
        sendEventWithId(event.id, event.type, event.data);
        
        // End SSE when processing is complete or failed
        if (event.type === "status" && 
            ["awaiting_review", "completed", "failed"].includes(event.data.status as string)) {
          setTimeout(() => {
            if (!connectionClosed) {
              clearInterval(heartbeatInterval);
              res.end();
            }
          }, 500);
        }
      }
    });

    // Handle client disconnect - processing continues in background
    req.on("close", () => {
      connectionClosed = true;
      unsubscribe();
      clearInterval(heartbeatInterval);
      routesLogger.info(`Client disconnected from project ${id}, processing continues in background`);
    });
  });

  // Approve review and continue rendering
  app.post("/api/videos/:id/approve-review", requireAuth, async (req: Request, res: Response) => {
    const paramResult = idParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      return res.status(400).json({ error: formatZodError(paramResult.error) });
    }
    const { id } = paramResult.data;

    const project = await storage.getVideoProject(id);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

    if (project.status !== "awaiting_review") {
      return res.status(400).json({ error: "Project is not awaiting review" });
    }

    // Get the updated review data from request body
    const { reviewData: updatedReviewData } = req.body;
    
    if (updatedReviewData) {
      // Validate the review data
      const parseResult = reviewDataSchema.safeParse(updatedReviewData);
      if (!parseResult.success) {
        return res.status(400).json({ error: "Invalid review data", details: parseResult.error });
      }
      
      // DETAILED LOGGING: Track what user approved
      const validatedData = parseResult.data;
      const allActions = validatedData.editPlan.actions;
      const cutActions = allActions.filter(a => a.type === 'cut');
      const approvedCuts = cutActions.filter(a => a.approved);
      
      routesLogger.info(`[Approve-Review] ========== STORING REVIEW DATA ==========`);
      routesLogger.info(`[Approve-Review] Project ID: ${id}`);
      routesLogger.info(`[Approve-Review] Total actions: ${allActions.length}`);
      routesLogger.info(`[Approve-Review] Cut actions: ${cutActions.length} total`);
      routesLogger.info(`[Approve-Review] Approved cuts: ${approvedCuts.length}`);
      if (approvedCuts.length > 0) {
        approvedCuts.forEach((c, i) => 
          routesLogger.info(`  [Approved Cut ${i}] ${c.start?.toFixed(2)}s - ${c.end?.toFixed(2)}s`)
        );
      } else {
        routesLogger.info(`[Approve-Review] NO CUTS APPROVED - Video will remain at original length`);
      }
      
      // Store the updated review data with userApproved=true
      await storage.updateVideoProject(id, { 
        reviewData: { ...parseResult.data, userApproved: true },
      });
    } else {
      // Even without updated review data, mark as approved using existing review data
      const existingReviewData = project.reviewData as ReviewData | null;
      if (existingReviewData) {
        await storage.updateVideoProject(id, {
          reviewData: { ...existingReviewData, userApproved: true },
        });
      } else {
        return res.status(400).json({ error: "No review data found. Please re-process the video." });
      }
    }

    // Automatically trigger background rendering (fire-and-forget)
    // This ensures rendering continues even if client disconnects
    const { startBackgroundRender } = await import("./services/backgroundProcessor");
    startBackgroundRender(id).catch(err => {
      routesLogger.error(`[Approve-Review] Failed to start background render for ${id}:`, err);
    });
    
    res.json({ 
      success: true, 
      message: "Review approved. Rendering has started automatically.",
      projectId: id 
    });
  });

  // Render video after review approval (SSE endpoint)
  app.get("/api/videos/:id/render", requireAuth, async (req: Request, res: Response) => {
    const paramResult = idParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      return res.status(400).json({ error: formatZodError(paramResult.error) });
    }
    const { id } = paramResult.data;
    
    // Parse quality mode from query params
    const qualityMode = (req.query.qualityMode as string) || "balanced";
    const validQualities = ["preview", "balanced", "quality"] as const;
    const renderQuality = validQualities.includes(qualityMode as any) 
      ? (qualityMode as "preview" | "balanced" | "quality")
      : "balanced";

    const project = await storage.getVideoProject(id);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

    // Check if this is a reconnection request
    const reconnect = req.query.reconnect === "true";
    
    // Allow reconnection if project is mid-render
    if (project.status === "rendering" && reconnect) {
      routesLogger.info(`Render reconnection for project ${id} (status: rendering)`);
      
      // Set up SSE for status updates
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      
      let connectionClosed = false;
      
      const sendEvent = (type: string, data: Record<string, unknown>) => {
        if (!connectionClosed) {
          res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
        }
      };
      
      const heartbeatInterval = setInterval(() => {
        if (!connectionClosed) {
          res.write(": heartbeat\n\n");
        }
      }, AI_CONFIG.processing.sseHeartbeatMs);
      
      // Send current status
      sendEvent("status", { status: project.status });
      sendEvent("activity", { message: "Reconnected to render in progress...", timestamp: Date.now() });
      
      // Poll for status changes since we can't subscribe to a running render job
      const pollInterval = setInterval(async () => {
        if (connectionClosed) return;
        
        try {
          const currentProject = await storage.getVideoProject(id);
          if (!currentProject) {
            sendEvent("error", { error: "Project not found" });
            clearInterval(pollInterval);
            clearInterval(heartbeatInterval);
            res.end();
            return;
          }
          
          if (currentProject.status === "completed") {
            const publicOutputPath = currentProject.outputPath || "";
            sendEvent("complete", {
              outputPath: publicOutputPath,
              duration: currentProject.duration,
            });
            clearInterval(pollInterval);
            clearInterval(heartbeatInterval);
            if (!connectionClosed) res.end();
          } else if (currentProject.status === "failed") {
            sendEvent("error", {
              error: currentProject.errorMessage || "Rendering failed",
            });
            clearInterval(pollInterval);
            clearInterval(heartbeatInterval);
            if (!connectionClosed) res.end();
          }
        } catch (err) {
          routesLogger.error(`Render poll error for project ${id}:`, err);
        }
      }, 2000); // Poll every 2 seconds
      
      req.on("close", () => {
        connectionClosed = true;
        clearInterval(pollInterval);
        clearInterval(heartbeatInterval);
        routesLogger.info(`Render reconnection closed for project ${id}`);
      });
      
      return;
    }
    
    // Allow rendering from awaiting_review or completed status (re-render)
    if (project.status !== "awaiting_review" && project.status !== "completed") {
      return res.status(400).json({ error: "Project must be awaiting review or completed to render" });
    }

    // Enforce review approval for awaiting_review status
    if (project.status === "awaiting_review") {
      const reviewData = project.reviewData as ReviewData | null;
      if (!reviewData) {
        return res.status(409).json({ error: "Review data is missing. Please re-process the video." });
      }
      if (!reviewData.userApproved) {
        return res.status(409).json({ error: "Please approve the review before rendering." });
      }
    }

    const videoPath = path.join(UPLOADS_DIR, path.basename(project.originalPath));
    
    try {
      await fs.access(videoPath);
    } catch {
      return res.status(404).json({ error: "Video file not found. Please re-upload your video." });
    }

    // Set up SSE response
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    
    // Disable request timeout for long-running render SSE connection
    req.setTimeout(0);

    const abortController = new AbortController();
    let connectionClosed = false;

    req.on("close", () => {
      connectionClosed = true;
      // DO NOT abort rendering on client disconnect - rendering must continue in background
      // abortController is only used for cleanup, not for stopping the render
      routesLogger.info(`Client disconnected during render (project ${id}), SSE stream closed - rendering continues in background`);
    });

    const sendEvent = (type: string, data: Record<string, unknown>) => {
      if (!connectionClosed) {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
      }
    };

    const heartbeatInterval = setInterval(() => {
      if (!connectionClosed) {
        res.write(": heartbeat\n\n");
      }
    }, AI_CONFIG.processing.sseHeartbeatMs);

    const sendActivity = (message: string, details?: Record<string, unknown>) => {
      sendEvent("activity", { message, timestamp: Date.now(), ...details });
    };

    try {
      // Get stored data from project
      const editPlan = project.editPlan as { actions?: any[]; estimatedDuration?: number } | null;
      let transcript = project.transcript as Array<{ start: number; end: number; text: string; words?: any[] }> || [];
      const reviewData = project.reviewData as ReviewData | null;
      let stockMedia = project.stockMedia as StockMediaItem[] || [];
      
      // If we have review data, apply user modifications
      if (reviewData && reviewData.userApproved) {
        // VALIDATION: Ensure reviewData has required arrays before accessing
        if (!reviewData.editPlan || !Array.isArray(reviewData.editPlan.actions)) {
          routesLogger.warn(`[Render] Invalid reviewData: missing editPlan.actions for project ${id}`);
          sendEvent("error", { error: "Review data is corrupted. Please re-process the video." });
          clearInterval(heartbeatInterval);
          res.end();
          return;
        }
        if (!Array.isArray(reviewData.transcript)) {
          routesLogger.warn(`[Render] Invalid reviewData: missing transcript array for project ${id}`);
          // Fall back to original transcript
          reviewData.transcript = [];
        }
        if (!Array.isArray(reviewData.stockMedia)) {
          reviewData.stockMedia = [];
        }
        if (!Array.isArray(reviewData.aiImages)) {
          reviewData.aiImages = [];
        }
        
        // DETAILED LOGGING: Track exactly what we received
        const allActions = reviewData.editPlan.actions;
        const cutActions = allActions.filter(a => a.type === 'cut');
        const approvedCutActions = cutActions.filter(a => a.approved);
        const rejectedCutActions = cutActions.filter(a => !a.approved);
        
        routesLogger.info(`[Render] ========== REVIEW DATA RECEIVED ==========`);
        routesLogger.info(`[Render] Total actions: ${allActions.length}`);
        routesLogger.info(`[Render] Cut actions: ${cutActions.length} (${approvedCutActions.length} approved, ${rejectedCutActions.length} rejected)`);
        if (approvedCutActions.length > 0) {
          routesLogger.info(`[Render] APPROVED CUTS that WILL be applied:`);
          approvedCutActions.forEach((c, i) => 
            routesLogger.info(`  [${i}] ${c.start?.toFixed(2)}s - ${c.end?.toFixed(2)}s: ${c.reason || 'no reason'}`)
          );
        }
        if (rejectedCutActions.length > 0) {
          routesLogger.info(`[Render] REJECTED cuts that will be IGNORED:`);
          rejectedCutActions.forEach((c, i) => 
            routesLogger.info(`  [${i}] ${c.start?.toFixed(2)}s - ${c.end?.toFixed(2)}s: ${c.reason || 'no reason'}`)
          );
        }
        sendActivity(`Review data: ${approvedCutActions.length}/${cutActions.length} cuts approved`);
        
        // Filter out rejected items
        const approvedActions = reviewData.editPlan.actions.filter(a => a.approved);
        const approvedStockMedia = reviewData.stockMedia.filter(m => m.approved);
        const approvedAiImages = reviewData.aiImages.filter(m => m.approved);
        
        // Apply transcript edits from user (approved segments with updated text)
        // Use start+end timestamps as stable identifiers for matching
        const reviewTranscriptByTime = new Map(
          reviewData.transcript.map(t => [`${t.start.toFixed(3)}_${t.end.toFixed(3)}`, t])
        );
        
        // Update transcript with user edits and filter out rejected segments
        transcript = transcript
          .map((seg) => {
            const timeKey = `${seg.start.toFixed(3)}_${seg.end.toFixed(3)}`;
            const reviewSeg = reviewTranscriptByTime.get(timeKey);
            if (reviewSeg) {
              // Skip if not approved
              if (!reviewSeg.approved) {
                return null;
              }
              // Apply text edits if modified
              if (reviewSeg.edited) {
                return { ...seg, text: reviewSeg.text };
              }
            }
            return seg;
          })
          .filter((seg): seg is NonNullable<typeof seg> => seg !== null);
        
        sendActivity(`Applied transcript edits: ${reviewData.transcript.filter(t => t.edited).length} segments modified, ${reviewData.transcript.filter(t => !t.approved).length} rejected`);
        
        // Update edit plan with only approved actions
        if (editPlan) {
          editPlan.actions = approvedActions;
        }
        
        // Update stock media with only approved items
        stockMedia = [
          ...approvedStockMedia.map(m => ({
            type: m.type,
            query: m.query,
            url: m.url,
            thumbnailUrl: m.thumbnailUrl,
            duration: m.duration,
            startTime: m.startTime,
            endTime: m.endTime,
          } as StockMediaItem)),
          ...approvedAiImages.map(m => ({
            type: 'ai_generated' as const,
            query: m.query,
            url: m.url,
            duration: m.duration,
            aiPrompt: m.query,
            startTime: m.startTime,
            endTime: m.endTime,
          } as StockMediaItem)),
        ];
        
        sendActivity(`Applying ${approvedActions.length} approved edit actions...`);
        
        // Handle edge case: all actions rejected - keep original video without cuts
        if (approvedActions.length === 0) {
          sendActivity("All edit actions were rejected. Output will be the original video with captions only.");
        }
        
        // Handle edge case: all transcript rejected - use original transcript for captions
        if (transcript.length === 0) {
          const originalTranscript = project.transcript as Array<{ start: number; end: number; text: string; words?: any[] }> || [];
          transcript = originalTranscript;
          sendActivity("All transcript segments were rejected. Using original transcript for captions.");
        }
        
        // Handle edge case: all media rejected - proceed without b-roll
        if (stockMedia.length === 0) {
          sendActivity("All media was rejected. Proceeding without B-roll overlays.");
        }
        
        // Record user feedback for AI learning (persisted to database)
        try {
          const videoAnalysis = project.analysis as any;
          let savedCount = 0;
          for (const action of reviewData.editPlan.actions) {
            await storage.saveEditFeedback({
              projectId: id,
              editActionId: action.id || `action_${(action.start ?? 0).toFixed(2)}_${(action.end ?? 0).toFixed(2)}`,
              actionType: action.type,
              wasApproved: action.approved ? 1 : 0,
              wasModified: 0,
              originalStart: action.start !== undefined && action.start !== null ? Math.round(action.start * 1000) : null,
              originalEnd: action.end !== undefined && action.end !== null ? Math.round(action.end * 1000) : null,
              modifiedStart: null,
              modifiedEnd: null,
              userReason: null,
              contextGenre: videoAnalysis?.videoAnalysis?.context?.genre || null,
              contextTone: videoAnalysis?.videoAnalysis?.context?.tone || null,
              contextDuration: videoAnalysis?.videoAnalysis?.duration ? Math.round(videoAnalysis.videoAnalysis.duration) : null,
            });
            savedCount++;
          }
          routesLogger.info(`[Render] Persisted feedback for ${savedCount}/${reviewData.editPlan.actions.length} actions to database`);
          sendActivity(`Recorded ${savedCount} edit decisions for AI learning`);
        } catch (feedbackErr) {
          routesLogger.warn("[Render] Failed to persist feedback (non-critical):", feedbackErr);
        }
        
        // Perform AI pre-render review
        try {
          const videoAnalysis = project.analysis as any;
          if (videoAnalysis?.videoAnalysis && transcript.length > 0) {
            sendActivity("Running AI quality review on your edits...");
            const aiReview = await performPreRenderReview(
              videoAnalysis.videoAnalysis,
              transcript,
              { actions: reviewData.editPlan.actions } as any,
              reviewData,
              project.prompt || ""
            );
            
            // Store AI review result in review data (fetch latest to avoid overwriting)
            const latestProject = await storage.getVideoProject(id);
            const latestReviewData = latestProject?.reviewData as ReviewData | null;
            if (latestReviewData) {
              await storage.updateVideoProject(id, {
                reviewData: { ...latestReviewData, aiReview } as any,
              });
            }
            
            if (aiReview.confidence < 50) {
              sendActivity(`AI Review: Low confidence (${aiReview.confidence}%) - ${aiReview.summary}`);
            } else {
              sendActivity(`AI Review: ${aiReview.confidence}% confidence - ${aiReview.summary}`);
            }
            
            if (aiReview.issues && aiReview.issues.length > 0) {
              const highIssues = aiReview.issues.filter(i => i.severity === "high");
              if (highIssues.length > 0) {
                sendActivity(`AI found ${highIssues.length} potential issue(s): ${highIssues[0].description}`);
              }
            }
          }
        } catch (reviewErr) {
          routesLogger.warn("[Render] AI pre-render review failed (non-critical):", reviewErr);
          sendActivity("AI review skipped - proceeding with rendering...");
        }
      }

      if (!editPlan || !editPlan.actions) {
        throw new Error("No edit plan found. Please run analysis first.");
      }
      
      // Ensure editPlan has proper structure for applyEdits
      const finalEditPlan = {
        ...editPlan,
        actions: editPlan.actions || [],
      };

      // Get edit options from the stored analysis
      const analysis = project.analysis as { semanticAnalysis?: SemanticAnalysis } | null;
      const semanticAnalysis = analysis?.semanticAnalysis;

      await storage.updateVideoProject(id, { status: "editing" as ProcessingStatus });
      sendEvent("status", { status: "editing" });
      sendActivity("Preparing to apply all edit actions...");

      await storage.updateVideoProject(id, { status: "rendering" as ProcessingStatus });
      sendEvent("status", { status: "rendering" });
      sendActivity("Starting FFmpeg rendering engine...");
      sendActivity("Cutting segments, adding overlays, and encoding video...");
      
      // Send rendering update to chat companion
      sendRenderingUpdate(id);
      updateProjectContext(id, { status: "rendering" });

      // Get original editOptions from review data, or use defaults
      const storedOptions: Partial<EditOptionsType> = reviewData?.editOptions || {};
      
      // CRITICAL: Only apply cuts if there are explicitly approved cut actions
      // If user rejected all cut actions, we keep the entire video
      const hasApprovedCuts = finalEditPlan.actions?.some(a => a.type === 'cut') ?? false;
      const hasApprovedKeeps = finalEditPlan.actions?.some(a => a.type === 'keep') ?? false;
      
      routesLogger.info(`[Render] Cut decisions - hasApprovedCuts: ${hasApprovedCuts}, hasApprovedKeeps: ${hasApprovedKeeps}, totalActions: ${finalEditPlan.actions?.length || 0}`);
      if (hasApprovedCuts) {
        const cutActions = finalEditPlan.actions?.filter(a => a.type === 'cut') || [];
        routesLogger.info(`[Render] Applying ${cutActions.length} cut actions:`);
        cutActions.forEach((c, i) => routesLogger.info(`  [${i}] Cut ${c.start?.toFixed(2)}s - ${c.end?.toFixed(2)}s: ${c.reason || 'no reason'}`));
      } else {
        routesLogger.info(`[Render] No cut actions approved - keeping entire video`);
      }
      
      const editOptions: EditOptions = {
        addCaptions: storedOptions.addCaptions ?? true,
        addBroll: stockMedia.length > 0,
        removeSilence: hasApprovedCuts, // Only remove silence if user approved cut actions
        generateAiImages: stockMedia.some(m => m.type === 'ai_generated'),
        addTransitions: storedOptions.addTransitions ?? false,
        renderQuality,
      };
      
      routesLogger.info(`[Render] Final editOptions: ${JSON.stringify(editOptions)}`);

      const editResult = await applyEdits(
        videoPath,
        finalEditPlan,
        transcript,
        stockMedia,
        editOptions,
        undefined,
        semanticAnalysis
      );

      sendActivity("Video rendering complete! Finalizing output...");

      // Verify output
      const outputMetadata = await getVideoMetadata(editResult.outputPath);
      const publicOutputPath = `/output/${path.basename(editResult.outputPath)}`;
      
      sendActivity(`Output video: ${Math.round(outputMetadata.duration)}s`);
      sendActivity("Video ready for download!");
      
      // AI SELF-REVIEW: Fire-and-forget background task (truly non-blocking)
      // Store the output path for background self-review
      const outputPathForReview = editResult.outputPath;
      const projectIdForReview = id;
      const promptForReview = project.prompt || "Edit this video";
      const videoAnalysisForReview = (project.analysis as { videoAnalysis?: unknown })?.videoAnalysis as import("@shared/schema").VideoAnalysis | undefined;
      
      // Only run self-review if we have valid reviewData
      if (reviewData && reviewData.userApproved) {
        // Fire-and-forget: don't await this
        (async () => {
          try {
            routesLogger.info(`[SelfReview] Starting background self-review for project ${projectIdForReview}`);
            
            const selfReviewResult = await performPostRenderSelfReview(
              outputPathForReview,
              videoPath,
              finalEditPlan,
              transcript,
              reviewData,
              stockMedia,
              promptForReview,
              videoAnalysisForReview
            );
            
            routesLogger.info(`[SelfReview] Completed: Score ${selfReviewResult.overallScore}/100, Approved: ${selfReviewResult.approved}, Issues: ${selfReviewResult.issues.length}`);
            
            // Send self-review update to chat companion
            sendSelfReviewUpdate(projectIdForReview, selfReviewResult.overallScore, selfReviewResult.issues.length);
            
            // PHASE 3: Iterative Correction Loop with Actual Re-Rendering
            const MAX_ITERATIONS = 2;
            let currentIteration = 1;
            let currentOutputPath = outputPathForReview;
            let currentEditPlan = finalEditPlan;
            let currentStockMedia = stockMedia;
            let lastSelfReview = selfReviewResult;
            
            while (currentIteration < MAX_ITERATIONS) {
              const reRenderCheck = shouldTriggerReRender(lastSelfReview, currentIteration);
              
              if (!reRenderCheck.shouldReRender) {
                routesLogger.info(`[SelfReview] No re-render needed: ${reRenderCheck.reason}`);
                break;
              }
              
              routesLogger.info(`[SelfReview] ═══════════════════════════════════════════════════════`);
              routesLogger.info(`[SelfReview] AUTO-CORRECTION ITERATION ${currentIteration + 1}/${MAX_ITERATIONS}`);
              routesLogger.info(`[SelfReview] Reason: ${reRenderCheck.reason}`);
              routesLogger.info(`[SelfReview] ═══════════════════════════════════════════════════════`);
              
              try {
                // Generate correction plan based on self-review issues
                const correctionPlan = await generateCorrectionPlan(
                  lastSelfReview,
                  currentEditPlan,
                  currentStockMedia
                );
                
                if (correctionPlan.actions.length === 0) {
                  routesLogger.info(`[SelfReview] No actionable corrections - stopping iteration`);
                  break;
                }
                
                // Apply corrections to edit plan and stock media
                const appliedCorrections = applyCorrectionPlan(
                  correctionPlan,
                  currentEditPlan,
                  currentStockMedia,
                  lastSelfReview
                );
                
                // Send correction update to chat companion with actual correction count
                sendCorrectionUpdate(projectIdForReview, currentIteration + 1, appliedCorrections.appliedCount);
                
                routesLogger.info(`[SelfReview] Applied ${appliedCorrections.appliedCount} corrections`);
                
                // Actually re-render with corrected data
                routesLogger.info(`[SelfReview] Starting corrected re-render...`);
                
                const correctedEditResult = await applyEdits(
                  videoPath,
                  appliedCorrections.modifiedEditPlan,
                  transcript,
                  appliedCorrections.modifiedStockMedia,
                  editOptions,
                  undefined,
                  semanticAnalysis
                );
                
                routesLogger.info(`[SelfReview] Re-render complete: ${correctedEditResult.outputPath}`);
                
                // Update project with new output
                const newPublicPath = `/output/${path.basename(correctedEditResult.outputPath)}`;
                await storage.updateVideoProject(projectIdForReview, {
                  outputPath: newPublicPath,
                });
                
                // Run self-review on new output
                routesLogger.info(`[SelfReview] Running self-review on corrected output...`);
                
                const newSelfReview = await performPostRenderSelfReview(
                  correctedEditResult.outputPath,
                  videoPath,
                  appliedCorrections.modifiedEditPlan,
                  transcript,
                  reviewData,
                  appliedCorrections.modifiedStockMedia,
                  promptForReview,
                  videoAnalysisForReview
                );
                
                const improvement = newSelfReview.overallScore - lastSelfReview.overallScore;
                routesLogger.info(`[SelfReview] Iteration ${currentIteration + 1} result: ${newSelfReview.overallScore}/100 (${improvement >= 0 ? "+" : ""}${improvement} points)`);
                
                // Update state for next iteration
                currentOutputPath = correctedEditResult.outputPath;
                currentEditPlan = appliedCorrections.modifiedEditPlan;
                currentStockMedia = appliedCorrections.modifiedStockMedia;
                lastSelfReview = newSelfReview;
                currentIteration++;
                
                // Store iteration results
                const existingAnalysis = (await storage.getVideoProject(projectIdForReview))?.analysis || {};
                await storage.updateVideoProject(projectIdForReview, {
                  analysis: {
                    ...(typeof existingAnalysis === "object" ? existingAnalysis : {}),
                    selfReviewIterations: {
                      totalIterations: currentIteration,
                      lastScore: newSelfReview.overallScore,
                      improvement: improvement,
                      completedAt: new Date().toISOString(),
                    },
                    selfReview: {
                      overallScore: newSelfReview.overallScore,
                      approved: newSelfReview.approved,
                      watchedFullVideo: newSelfReview.watchedFullVideo,
                      issueCount: newSelfReview.issues.length,
                      qualityMetrics: newSelfReview.qualityMetrics,
                      issues: newSelfReview.issues,
                      recommendations: newSelfReview.recommendedActions,
                      completedAt: new Date().toISOString(),
                    },
                  },
                });
                
              } catch (correctionError) {
                routesLogger.warn(`[SelfReview] Correction iteration failed: ${correctionError instanceof Error ? correctionError.message : String(correctionError)}`);
                break;
              }
            }
            
            if (currentIteration >= MAX_ITERATIONS) {
              routesLogger.info(`[SelfReview] Maximum iterations (${MAX_ITERATIONS}) reached`);
            }
            
            routesLogger.info(`[SelfReview] Final score after ${currentIteration} iteration(s): ${lastSelfReview.overallScore}/100`);
            routesLogger.info(`[SelfReview] Approved: ${lastSelfReview.approved}`);
            routesLogger.info(`[SelfReview] ═══════════════════════════════════════════════════════`);
            
            // Persist self-review results to project for future reference and Phase 3 correction loop
            try {
              const existingAnalysis = (await storage.getVideoProject(projectIdForReview))?.analysis || {};
              await storage.updateVideoProject(projectIdForReview, {
                analysis: {
                  ...(typeof existingAnalysis === "object" ? existingAnalysis : {}),
                  selfReview: {
                    overallScore: selfReviewResult.overallScore,
                    approved: selfReviewResult.approved,
                    watchedFullVideo: selfReviewResult.watchedFullVideo,
                    issueCount: selfReviewResult.issues.length,
                    qualityMetrics: selfReviewResult.qualityMetrics,
                    issues: selfReviewResult.issues,
                    recommendations: selfReviewResult.recommendedActions,
                    completedAt: new Date().toISOString(),
                  },
                },
              });
              routesLogger.info(`[SelfReview] Persisted results to project ${projectIdForReview}`);
            } catch (persistError) {
              routesLogger.warn(`[SelfReview] Could not persist results: ${persistError}`);
            }
            
            routesLogger.info(`[SelfReview] Quality metrics: audioSync=${selfReviewResult.qualityMetrics.audioVideoSync}, visual=${selfReviewResult.qualityMetrics.visualQuality}, pacing=${selfReviewResult.qualityMetrics.pacingFlow}`);
            
            // PHASE 4: AI Learning System - Store successful patterns when score is good
            const finalScore = lastSelfReview?.overallScore ?? selfReviewResult.overallScore;
            if (finalScore >= 70 && reviewData) {
              try {
                routesLogger.info(`[Learning] Storing successful patterns (score: ${finalScore}/100)...`);
                const storedPatterns = storePattern(
                  reviewData,
                  lastSelfReview || selfReviewResult,
                  videoAnalysisForReview,
                  promptForReview
                );
                routesLogger.info(`[Learning] Stored ${storedPatterns.length} patterns from successful edit`);
              } catch (learningError) {
                routesLogger.warn(`[Learning] Failed to store patterns: ${learningError instanceof Error ? learningError.message : String(learningError)}`);
              }
            } else {
              routesLogger.debug(`[Learning] Skipped pattern storage: score ${finalScore}/100 below threshold or reviewData unavailable`);
            }
            
          } catch (selfReviewError) {
            routesLogger.warn(`[SelfReview] Background self-review failed: ${selfReviewError instanceof Error ? selfReviewError.message : String(selfReviewError)}`);
          }
        })().catch(err => {
          routesLogger.debug(`[SelfReview] Background task error: ${err}`);
        });
        
        sendActivity("Self-review started in background...");
      } else {
        routesLogger.debug(`[SelfReview] Skipped: reviewData not available or not approved`);
      }
      
      await storage.updateVideoProject(id, {
        status: "completed" as ProcessingStatus,
        outputPath: publicOutputPath,
        duration: Math.round(outputMetadata.duration),
      });

      sendEvent("complete", {
        outputPath: publicOutputPath,
        duration: Math.round(outputMetadata.duration),
        selfReviewStarted: reviewData && reviewData.userApproved ? true : false,
        aiImageStats: editOptions.generateAiImages ? {
          applied: editResult.aiImagesApplied,
          skipped: editResult.aiImagesSkipped,
        } : undefined,
      });
      
      // Send completion update to chat companion
      sendCompletionUpdate(id);
      updateProjectContext(id, { status: "completed" });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Rendering failed";
      
      // Client disconnect should NOT cancel rendering - it continues in background
      // Only treat as actual error if it's not a disconnect-related issue
      if (connectionClosed) {
        // Client disconnected - rendering continues in background, don't mark as failed
        routesLogger.info(`Client disconnected during render for project ${id}. Rendering continues in background.`);
        // Don't update status - let the background render complete normally
      } else {
        // Actual rendering error
        routesLogger.error("Render error:", error);
        
        const friendlyError = formatErrorForSSE(error instanceof Error ? error : new Error(errorMessage));
        
        await storage.updateVideoProject(id, {
          status: "failed" as ProcessingStatus,
          errorMessage: friendlyError.error,
        });

        sendEvent("error", {
          error: friendlyError.error,
          suggestion: friendlyError.suggestion,
          errorType: friendlyError.errorType,
        });
      }
    } finally {
      clearInterval(heartbeatInterval);
      if (!connectionClosed) {
        res.end();
      }
    }
  });

  // Get review data for a project
  app.get("/api/videos/:id/review", requireAuth, async (req: Request, res: Response) => {
    const paramResult = idParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      return res.status(400).json({ error: formatZodError(paramResult.error) });
    }
    const { id } = paramResult.data;

    const project = await storage.getVideoProject(id);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

    if (!project.reviewData) {
      return res.status(404).json({ error: "No review data available" });
    }

    res.json({
      reviewData: project.reviewData,
      status: project.status,
      transcript: project.transcript,
      transcriptEnhanced: project.transcriptEnhanced, // Speaker diarization, chapters, sentiment, entities
      editPlan: project.editPlan,
      stockMedia: project.stockMedia,
    });
  });

  // Enhanced analysis endpoint - returns full analysis data
  app.get("/api/videos/:id/analysis", async (req: Request, res: Response) => {
    try {
      const paramResult = idParamSchema.safeParse(req.params);
      if (!paramResult.success) {
        return res.status(400).json({ error: formatZodError(paramResult.error) });
      }
      const { id } = paramResult.data;

      const project = await storage.getVideoProject(id);
      if (!project) {
        return res.status(404).json({ error: "Project not found" });
      }

      const analysis = project.analysis as {
        scenes?: unknown[];
        emotionFlow?: unknown[];
        speakers?: unknown[];
        keyMoments?: unknown[];
        semanticAnalysis?: {
          fillerSegments?: unknown[];
          hookMoments?: unknown[];
          structureAnalysis?: unknown;
          topicFlow?: unknown[];
          mainTopics?: string[];
          overallTone?: string;
          keyMoments?: unknown[];
          brollWindows?: unknown[];
          extractedKeywords?: string[];
          contentSummary?: string;
        };
        context?: unknown;
        frames?: unknown[];
        summary?: string;
        narrativeStructure?: unknown;
        brollOpportunities?: unknown[];
      } | null;

      if (!analysis) {
        return res.status(404).json({ error: "Analysis not available. Process the video first." });
      }

      const semanticAnalysis = analysis.semanticAnalysis;

      // Compute filler segments from semantic analysis or detect them
      let fillerSegments: { start: number; end: number; word: string }[] = [];
      if (semanticAnalysis?.fillerSegments) {
        fillerSegments = semanticAnalysis.fillerSegments as { start: number; end: number; word: string }[];
      } else if (project.transcript) {
        // Re-detect filler words from transcript if not stored
        fillerSegments = detectFillerWords(project.transcript as { start: number; end: number; text: string }[]);
      }

      // Compute quality insights
      const hookMoments = semanticAnalysis?.hookMoments as { timestamp: number; score: number; reason: string }[] || [];
      const hookStrength = hookMoments.length > 0 
        ? Math.max(...hookMoments.map(h => h.score)) 
        : 50;

      const qualityInsights = {
        hookStrength,
        fillerCount: fillerSegments.length,
        topicsCount: semanticAnalysis?.mainTopics?.length || 0,
        brollWindowsCount: semanticAnalysis?.brollWindows?.length || 0,
        recommendations: [] as string[],
      };

      // Add recommendations based on analysis
      if (hookStrength < 60) {
        qualityInsights.recommendations.push("Consider adding a stronger hook in the first 3-5 seconds");
      }
      if (fillerSegments.length > 5) {
        qualityInsights.recommendations.push("Consider removing filler words for smoother delivery");
      }

      res.json({
        videoAnalysis: {
          scenes: analysis.scenes || [],
          emotionFlow: analysis.emotionFlow || [],
          speakers: analysis.speakers || [],
          keyMoments: analysis.keyMoments || [],
          context: analysis.context,
          frames: analysis.frames || [],
          summary: analysis.summary,
          narrativeStructure: analysis.narrativeStructure,
          brollOpportunities: analysis.brollOpportunities || [],
        },
        semanticAnalysis: {
          fillerSegments,
          hookMoments: semanticAnalysis?.hookMoments || [],
          structureAnalysis: semanticAnalysis?.structureAnalysis || null,
          topicFlow: semanticAnalysis?.topicFlow || [],
          mainTopics: semanticAnalysis?.mainTopics || [],
          overallTone: semanticAnalysis?.overallTone || "casual",
          keyMoments: semanticAnalysis?.keyMoments || [],
          brollWindows: semanticAnalysis?.brollWindows || [],
          extractedKeywords: semanticAnalysis?.extractedKeywords || [],
          contentSummary: semanticAnalysis?.contentSummary || "",
        },
        qualityInsights,
        transcript: project.transcript || [],
      });
    } catch (error) {
      routesLogger.error("Analysis fetch error:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to get analysis",
      });
    }
  });

  app.get("/api/videos", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const projects = await storage.getAllVideoProjects();
      res.json(projects);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to get projects",
      });
    }
  });

  // ============================================================================
  // PROJECT HISTORY ROUTES
  // ============================================================================

  // Get active (non-expired) projects for history panel
  app.get("/api/projects/history", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const projects = await storage.getActiveProjects();
      const projectsWithTimeLeft = projects.map(p => ({
        id: p.id,
        fileName: p.fileName,
        status: p.status,
        duration: p.duration,
        createdAt: p.createdAt,
        expiresAt: p.expiresAt,
        timeLeftMs: Math.max(0, new Date(p.expiresAt).getTime() - Date.now()),
        hasOutput: !!p.outputPath,
      }));
      res.json(projectsWithTimeLeft);
    } catch (error) {
      routesLogger.error("Failed to get project history:", error);
      res.status(500).json({ error: "Failed to get project history" });
    }
  });

  // Delete a project
  app.delete("/api/projects/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = idParamSchema.parse(req.params);
      await storage.deleteVideoProject(id);
      res.json({ success: true, message: "Project deleted" });
    } catch (error) {
      routesLogger.error("Failed to delete project:", error);
      res.status(500).json({ error: "Failed to delete project" });
    }
  });

  // Delete a video project
  app.delete("/api/videos/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const paramResult = idParamSchema.safeParse(req.params);
      if (!paramResult.success) {
        return res.status(400).json({ error: formatZodError(paramResult.error) });
      }
      const { id } = paramResult.data;
      
      const project = await storage.getVideoProject(id);
      if (!project) {
        return res.status(404).json({ error: "Project not found" });
      }
      
      await storage.deleteVideoProject(id);
      res.json({ success: true, message: "Video project deleted" });
    } catch (error) {
      routesLogger.error("Failed to delete video project:", error);
      res.status(500).json({ error: "Failed to delete video project" });
    }
  });

  // Get processing status (for multi-processing limit)
  app.get("/api/processing/status", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    res.json(getProcessingStatus());
  });

  // ============================================================================
  // AUTOSAVE ROUTES
  // ============================================================================

  // Get autosaved review data for a project
  app.get("/api/videos/:id/autosave", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = idParamSchema.parse(req.params);
      const autosave = await storage.getAutosave(id);
      if (autosave) {
        res.json({ hasAutosave: true, reviewData: autosave });
      } else {
        res.json({ hasAutosave: false });
      }
    } catch (error) {
      routesLogger.error("Failed to get autosave:", error);
      res.status(500).json({ error: "Failed to get autosave" });
    }
  });

  // Save review data autosave
  app.post("/api/videos/:id/autosave", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = idParamSchema.parse(req.params);
      const { reviewData } = req.body;
      if (!reviewData) {
        return res.status(400).json({ error: "reviewData is required" });
      }
      await storage.saveAutosave(id, reviewData);
      res.json({ success: true });
    } catch (error) {
      routesLogger.error("Failed to save autosave:", error);
      res.status(500).json({ error: "Failed to save autosave" });
    }
  });

  // Delete autosave after approval
  app.delete("/api/videos/:id/autosave", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = idParamSchema.parse(req.params);
      await storage.deleteAutosave(id);
      res.json({ success: true });
    } catch (error) {
      routesLogger.error("Failed to delete autosave:", error);
      res.status(500).json({ error: "Failed to delete autosave" });
    }
  });

  // ============================================================================
  // CACHE ROUTES (for internal use)
  // ============================================================================

  // Get cached asset
  app.get("/api/cache/:type/:key", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const type = req.params.type as string;
      const key = req.params.key as string;
      const cached = await storage.getCachedAsset(type, key);
      if (cached) {
        res.json({ hit: true, data: cached });
      } else {
        res.json({ hit: false });
      }
    } catch (error) {
      res.status(500).json({ error: "Cache lookup failed" });
    }
  });

  // ============================================================================
  // AI CHAT COMPANION ROUTES
  // ============================================================================

  // Get chat messages for a project
  app.get("/api/videos/:id/chat", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = idParamSchema.parse(req.params);
      const messages = getProjectMessages(id);
      res.json({ messages });
    } catch (error) {
      routesLogger.error("Failed to get chat messages:", error);
      res.status(500).json({ error: "Failed to get chat messages" });
    }
  });

  // Send a message to the AI companion
  app.post("/api/videos/:id/chat", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = idParamSchema.parse(req.params);
      const { message } = req.body;
      
      if (!message || typeof message !== "string") {
        return res.status(400).json({ error: "Message is required" });
      }
      
      const project = await storage.getVideoProject(id);
      if (!project) {
        return res.status(404).json({ error: "Project not found" });
      }
      
      // Add user message
      addUserMessage(id, message);
      
      // Get AI response
      const answerMessage = await answerUserQuestion(id, message);
      
      // Return the new messages
      const recentMessages = getProjectMessages(id, 2);
      res.json({ messages: recentMessages });
    } catch (error) {
      routesLogger.error("Failed to process chat message:", error);
      res.status(500).json({ error: "Failed to process chat message" });
    }
  });

  // ============================================================================
  // RETRY/RECOVERY ROUTES
  // ============================================================================

  // Retry failed processing from a specific stage
  app.post("/api/videos/:id/retry", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = idParamSchema.parse(req.params);
      // Safely extract stage from body with default
      const stage = req.body?.stage || 'full'; // 'transcription', 'analysis', 'planning', 'stock', 'ai_images', 'full'
      
      const project = await storage.getVideoProject(id);
      if (!project) {
        return res.status(404).json({ error: "Project not found" });
      }
      
      // Reset project to pending state so it can be reprocessed
      await storage.updateVideoProject(id, {
        status: "pending",
        errorMessage: null,
      });
      
      res.json({ 
        success: true, 
        message: "Project reset for retry. Start processing again.",
        projectId: id,
        stage
      });
    } catch (error) {
      routesLogger.error("Failed to retry project:", error);
      res.status(500).json({ error: "Failed to retry project" });
    }
  });

  // Retry just the transcription step
  app.post("/api/videos/:id/retry-transcription", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = idParamSchema.parse(req.params);
      
      const project = await storage.getVideoProject(id);
      if (!project) {
        return res.status(404).json({ error: "Project not found" });
      }

      const videoPath = path.join(UPLOADS_DIR, path.basename(project.originalPath));
      
      try {
        await fs.access(videoPath);
      } catch {
        return res.status(404).json({ error: "Video file not found. Please re-upload your video." });
      }

      // Set up SSE response
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      let connectionClosed = false;
      req.on("close", () => {
        connectionClosed = true;
      });

      const sendEvent = (type: string, data: Record<string, unknown>) => {
        if (!connectionClosed) {
          res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
        }
      };

      try {
        // Update status to transcribing
        await storage.updateVideoProject(id, { 
          status: "transcribing",
          errorMessage: null,
        });
        sendEvent("status", { status: "transcribing" });
        sendEvent("activity", { message: "Re-running transcription...", timestamp: Date.now() });

        // Extract audio
        const audioPath = await extractAudio(videoPath);
        
        // Run transcription
        const transcript = await transcribeAudio(audioPath);
        
        // Clean up audio file
        await fs.unlink(audioPath).catch(() => {});

        // Update project with new transcript
        await storage.updateVideoProject(id, {
          transcript: transcript,
          status: "pending",
          errorMessage: null,
        });

        sendEvent("transcript", { transcript });
        sendEvent("activity", { message: "Transcription complete!", timestamp: Date.now() });
        sendEvent("complete", { 
          success: true, 
          transcript,
          message: "Transcription re-run successfully. You can now process the video again." 
        });

      } catch (error) {
        routesLogger.error("Retry transcription failed:", error);
        const errorMsg = error instanceof Error ? error.message : "Transcription retry failed";
        
        await storage.updateVideoProject(id, {
          status: "failed",
          errorMessage: errorMsg,
        });
        
        sendEvent("error", { 
          error: errorMsg,
          suggestion: "Please try again or upload a video with clearer audio"
        });
      }

      res.end();
    } catch (error) {
      routesLogger.error("Failed to retry transcription:", error);
      res.status(500).json({ error: "Failed to retry transcription" });
    }
  });

  return httpServer;
}
