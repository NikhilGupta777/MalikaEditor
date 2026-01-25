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
  generateAiImages: booleanQueryParam(false),
  addTransitions: booleanQueryParam(false),
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
} from "./services/aiService";
import type { SemanticAnalysis, StockMediaItem, ProcessingStatus } from "@shared/schema";
import { editPlanSchema } from "@shared/schema";
import { fetchStockMedia } from "./services/pexelsService";
import { requireAuth, type AuthenticatedRequest } from "./middleware/auth";
import { registerAuthRoutes } from "./routes/auth";

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

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  await ensureDirs();
  
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
    
    // Validate query parameters
    const queryResult = processQuerySchema.safeParse(req.query);
    if (!queryResult.success) {
      return res.status(400).json({ error: formatZodError(queryResult.error) });
    }
    
    const { prompt, addCaptions, addBroll, removeSilence, generateAiImages, addTransitions } = queryResult.data;
    
    const editOptions: EditOptions = {
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

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    // Create AbortController for cancelling operations on client disconnect
    const abortController = new AbortController();
    const abortSignal = abortController.signal;
    let connectionClosed = false;
    
    req.on("close", () => {
      connectionClosed = true;
      abortController.abort();
      routesLogger.info(`Client disconnected during video processing (project ${id}), aborting operations...`);
    });

    // Helper to check if operation should be aborted
    const checkAborted = () => {
      if (abortSignal.aborted) {
        throw new Error("ABORTED: Client disconnected");
      }
    };

    const sendEvent = (type: string, data: Record<string, unknown>) => {
      if (!connectionClosed) {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
      }
    };

    const heartbeatInterval = setInterval(() => {
      if (!connectionClosed) {
        res.write(": heartbeat\n\n");
      }
    }, 15000);

    const updateStatus = async (status: ProcessingStatus) => {
      if (abortSignal.aborted) return; // Don't update status if aborted
      await storage.updateVideoProject(id, { status });
      sendEvent("status", { status });
    };

    const sendActivity = (message: string, details?: Record<string, unknown>) => {
      sendEvent("activity", { message, timestamp: Date.now(), ...details });
    };

    let tempFiles: string[] = [];
    let transcript: { start: number; end: number; text: string }[] = [];

    try {
      await storage.updateVideoProject(id, { prompt });

      await updateStatus("analyzing");
      sendActivity("Reading video metadata...");
      const metadata = await getVideoMetadata(videoPath);
      sendActivity(`Video info: ${metadata.duration.toFixed(1)}s duration, ${metadata.width}x${metadata.height}`, { duration: metadata.duration });
      checkAborted();

      const numFrames = Math.min(12, Math.max(6, Math.floor(metadata.duration / 10)));
      sendActivity(`Extracting ${numFrames} key frames for AI analysis...`);
      const framePaths = await extractFrames(videoPath, numFrames);
      sendActivity(`Extracted ${framePaths.length} frames successfully`);
      tempFiles.push(path.dirname(framePaths[0]));
      checkAborted();

      let silentSegments: { start: number; end: number }[] = [];
      if (editOptions.removeSilence) {
        sendActivity("Scanning audio for silent segments...");
        silentSegments = await detectSilence(videoPath);
        sendActivity(`Found ${silentSegments.length} silent segments to remove`, { silentCount: silentSegments.length });
        checkAborted();
      }

      await updateStatus("transcribing");
      sendActivity("Extracting audio track...");
      const audioPath = await extractAudio(videoPath);
      tempFiles.push(audioPath);
      checkAborted();

      sendActivity("Running speech-to-text AI (this may take a moment)...");
      transcript = await transcribeAudio(audioPath);
      sendActivity(`Transcribed ${transcript.length} speech segments with timestamps`, { segments: transcript.length });
      checkAborted();

      // Use deep video analysis for comprehensive AI-powered insights
      sendActivity("Starting deep AI video analysis...");
      sendActivity("AI is watching your video to understand content, emotions, and key moments...");
      routesLogger.info("Performing deep video analysis...");
      const deepAnalysisResult = await analyzeVideoDeep(
        framePaths,
        metadata.duration,
        silentSegments,
        transcript
      );
      checkAborted();

      const { videoAnalysis: analysis, semanticAnalysis, fillerSegments, qualityInsights } = deepAnalysisResult;
      
      sendActivity(`AI detected ${semanticAnalysis.keyMoments?.length || 0} key moments in your video`);
      sendActivity(`Found ${fillerSegments.length} filler words (um, uh, like...)`, { fillerCount: fillerSegments.length });
      sendActivity(`Hook strength score: ${qualityInsights.hookStrength}/100`, { hookScore: qualityInsights.hookStrength });
      if (semanticAnalysis.mainTopics?.length > 0) {
        sendActivity(`Main topics identified: ${semanticAnalysis.mainTopics.slice(0, 3).join(", ")}`);
      }
      if (semanticAnalysis.brollWindows?.length > 0) {
        sendActivity(`Identified ${semanticAnalysis.brollWindows.length} opportunities for B-roll`, { brollOpportunities: semanticAnalysis.brollWindows.length });
      }

      // Detect language and translate if needed for non-English content
      if (transcript.length > 0) {
        const detectedLanguage = detectTranscriptLanguage(transcript);
        if (analysis.context) {
          analysis.context.languageDetected = detectedLanguage;
        }
      }

      await storage.updateVideoProject(id, {
        analysis: { ...analysis, semanticAnalysis },
        transcript,
        duration: Math.round(metadata.duration),
      });

      // Send transcript to frontend for interactive editing
      sendEvent("transcript", { transcript });

      // Send enhanced analysis data to frontend including filler segments and quality insights
      sendEvent("enhancedAnalysis", {
        fillerSegments,
        qualityInsights,
        hookScore: qualityInsights.hookStrength,
        structureAnalysis: semanticAnalysis.structureAnalysis,
        topicFlow: semanticAnalysis.topicFlow,
        hookMoments: semanticAnalysis.hookMoments,
        keyMoments: semanticAnalysis.keyMoments,
      });

      await updateStatus("planning");
      sendActivity("Creating intelligent edit plan using multi-pass AI system...");
      sendActivity("Pass 1: Analyzing narrative structure (intro/body/outro)...");
      
      routesLogger.info("Deep analysis complete:", {
        topics: semanticAnalysis.mainTopics,
        brollWindows: semanticAnalysis.brollWindows.length,
        fillerCount: fillerSegments.length,
        hookStrength: qualityInsights.hookStrength,
      });
      
      const enhancedPrompt = `${prompt}
      
User has selected these options:
- Add Captions: ${editOptions.addCaptions ? "Yes" : "No"}
- Add B-Roll Stock Footage: ${editOptions.addBroll ? "Yes" : "No"}  
- Remove Silent Parts: ${editOptions.removeSilence ? "Yes" : "No"}
- Generate AI Images: ${editOptions.generateAiImages ? "Yes" : "No"}

Please create an edit plan that follows these preferences. Do NOT include any transition effects - transitions are not supported.`;

      checkAborted();
      sendActivity("Pass 2: Scoring content quality and engagement levels...");
      sendActivity("Pass 3: Optimizing B-roll placement and distribution...");
      // Use smart multi-pass edit planning for better results
      const editPlan = await generateSmartEditPlan(
        enhancedPrompt,
        analysis,
        transcript,
        semanticAnalysis,
        fillerSegments
      );
      checkAborted();
      
      sendActivity("Pass 4: Quality review - validating edit plan...");
      sendActivity(`Edit plan created with ${editPlan.actions?.length || 0} edit actions`, { actionCount: editPlan.actions?.length || 0 });
      const stockQueryCount = editPlan.stockQueries?.length || 0;
      if (stockQueryCount > 0) {
        sendActivity(`Generated ${stockQueryCount} B-roll search queries`);
      }

      await storage.updateVideoProject(id, { editPlan });
      sendEvent("editPlan", { editPlan });

      let stockMedia: StockMediaItem[] = [];
      if (editOptions.addBroll) {
        await updateStatus("fetching_stock");
        const stockQueries = editPlan.stockQueries || [];
        sendActivity(`Searching Pexels for ${stockQueries.length} B-roll clips...`);
        for (let i = 0; i < Math.min(3, stockQueries.length); i++) {
          sendActivity(`Searching: "${stockQueries[i].substring(0, 50)}..."`);
        }
        checkAborted();
        stockMedia = await fetchStockMedia(stockQueries);
        sendActivity(`Found ${stockMedia.length} stock media clips`, { stockCount: stockMedia.length });
        checkAborted();
        await storage.updateVideoProject(id, { stockMedia });
        sendEvent("stockMedia", { stockMedia });
      }
      
      // Generate AI images if option is enabled and semantic analysis is available
      let aiGeneratedImages: StockMediaItem[] = [];
      if (editOptions.generateAiImages && semanticAnalysis && semanticAnalysis.brollWindows.length > 0) {
        await updateStatus("generating_ai_images");
        sendActivity("Preparing to generate custom AI images...");
        checkAborted();
        routesLogger.info("Generating AI images based on video content...");
        
        try {
          // Calculate optimal number of AI images based on video duration
          // Target: ~1 AI image per 8-10 seconds of video, minimum 3, maximum 12
          const videoDuration = metadata.duration;
          const optimalImages = Math.min(12, Math.max(3, Math.ceil(videoDuration / 8)));
          sendActivity(`Targeting ${optimalImages} AI images for ${videoDuration.toFixed(0)}s video...`);
          routesLogger.info(`Video is ${videoDuration.toFixed(1)}s, targeting ${optimalImages} AI images`);
          
          sendActivity("Sending image prompts to Gemini AI...");
          const generatedImages = await generateAiImagesForVideo(
            semanticAnalysis,
            analysis.context,
            optimalImages,
            videoDuration  // Pass video duration for distribution logic
          );
          checkAborted();
          
          // Convert to StockMediaItem format and save to files with timing info
          for (let i = 0; i < generatedImages.length; i++) {
            const img = generatedImages[i];
            const ext = img.mimeType.includes("png") ? "png" : "jpg";
            const imagePath = path.join(OUTPUT_DIR, `ai_image_${id}_${i}.${ext}`);
            
            // Save base64 to file
            await fs.writeFile(imagePath, Buffer.from(img.base64Data, "base64"));
            
            // Timing comes directly from the generated image (derived from filtered candidates)
            aiGeneratedImages.push({
              type: "ai_generated",
              query: img.prompt,
              url: imagePath, // Local path for processing
              aiPrompt: img.prompt,
              generatedAt: Date.now(),
              startTime: img.startTime,
              endTime: img.endTime,
              duration: img.duration,
            });
            
            routesLogger.debug(`AI image ${i}: "${img.prompt.substring(0, 40)}..." at ${img.startTime.toFixed(1)}s-${img.endTime.toFixed(1)}s`);
          }
          
          sendActivity(`Successfully generated ${aiGeneratedImages.length} AI images`, { aiImageCount: aiGeneratedImages.length });
          routesLogger.info(`Generated ${aiGeneratedImages.length} AI images`);
          sendEvent("aiImages", { count: aiGeneratedImages.length });
          
          // Add AI images to stock media for B-roll overlay
          stockMedia = [...stockMedia, ...aiGeneratedImages];
          await storage.updateVideoProject(id, { stockMedia });
        } catch (aiError) {
          sendActivity("AI image generation encountered an issue, continuing with stock media...");
          routesLogger.error("AI image generation failed, continuing with stock media:", aiError);
          sendEvent("aiImagesError", { error: "AI image generation failed, using stock media only" });
        }
      }

      await updateStatus("editing");
      sendActivity("Preparing to apply all edit actions...");
      checkAborted();
      await updateStatus("rendering");
      sendActivity("Starting FFmpeg rendering engine...");
      sendActivity("Cutting segments, adding overlays, and encoding video...");

      const editResult = await applyEdits(
        videoPath, 
        editPlan, 
        transcript,
        stockMedia,
        editOptions,
        undefined, // outputFileName - use default
        semanticAnalysis
      );
      checkAborted(); // Check after rendering
      
      sendActivity("Video rendering complete! Finalizing output...");
      
      // Send SSE event with AI image placement stats
      if (editOptions.generateAiImages) {
        sendActivity(`Applied ${editResult.aiImagesApplied} AI images, ${editResult.stockMediaApplied} stock clips`);
        sendEvent("aiImageStats", {
          applied: editResult.aiImagesApplied,
          skipped: editResult.aiImagesSkipped,
          stockApplied: editResult.stockMediaApplied,
          totalOverlays: editResult.brollOverlaysTotal,
        });
      }
      
      sendActivity("Verifying output video...");
      const outputMetadata = await getVideoMetadata(editResult.outputPath);

      const publicOutputPath = `/output/${path.basename(editResult.outputPath)}`;
      sendActivity(`Output video: ${Math.round(outputMetadata.duration)}s, ready for download!`);
      await storage.updateVideoProject(id, {
        status: "completed",
        outputPath: publicOutputPath,
        duration: Math.round(outputMetadata.duration),
      });

      sendEvent("complete", {
        outputPath: publicOutputPath,
        duration: Math.round(outputMetadata.duration),
        aiImageStats: editOptions.generateAiImages ? {
          applied: editResult.aiImagesApplied,
          skipped: editResult.aiImagesSkipped,
        } : undefined,
      });

      await cleanupTempFiles(tempFiles);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Processing failed";
      const isAborted = errorMessage.includes("ABORTED") || abortSignal.aborted;
      
      if (isAborted) {
        // Client disconnected - don't mark as failed, just clean up
        routesLogger.info(`Processing aborted for project ${id} due to client disconnect. Cleaning up resources...`);
        await storage.updateVideoProject(id, {
          status: "cancelled",
          errorMessage: "Processing cancelled: client disconnected",
        });
        // Don't send error event since client is gone
      } else {
        // Actual processing error
        routesLogger.error("Processing error:", error);
        
        const friendlyError = formatErrorForSSE(error instanceof Error ? error : new Error(errorMessage));
        
        await storage.updateVideoProject(id, {
          status: "failed",
          errorMessage: friendlyError.error,
        });

        sendEvent("error", {
          error: friendlyError.error,
          suggestion: friendlyError.suggestion,
          errorType: friendlyError.errorType,
        });
      }

      await cleanupTempFiles(tempFiles);
    } finally {
      clearInterval(heartbeatInterval);
      if (!connectionClosed) {
        res.end();
      }
    }
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

  return httpServer;
}
