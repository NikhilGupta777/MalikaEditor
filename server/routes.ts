import type { Express, Response } from "express";
import { type Server } from "http";
import multer from "multer";
import path from "path";
import { promises as fs } from "fs";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { storage } from "./storage";
import { createLogger } from "./utils/logger";

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
} from "./services/aiService";
import type { SemanticAnalysis, StockMediaItem } from "@shared/schema";
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
        res.status(500).json({
          error: error instanceof Error ? error.message : "Upload failed",
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

  app.get("/api/videos/:id/process", async (req: Request, res: Response) => {
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

    const updateStatus = async (status: string) => {
      if (abortSignal.aborted) return; // Don't update status if aborted
      await storage.updateVideoProject(id, { status });
      sendEvent("status", { status });
    };

    let tempFiles: string[] = [];
    let transcript: { start: number; end: number; text: string }[] = [];

    try {
      await storage.updateVideoProject(id, { prompt });

      await updateStatus("analyzing");
      const metadata = await getVideoMetadata(videoPath);
      checkAborted(); // Check after metadata extraction

      const numFrames = Math.min(12, Math.max(6, Math.floor(metadata.duration / 10)));
      const framePaths = await extractFrames(videoPath, numFrames);
      tempFiles.push(path.dirname(framePaths[0]));
      checkAborted(); // Check after frame extraction

      let silentSegments: { start: number; end: number }[] = [];
      if (editOptions.removeSilence) {
        silentSegments = await detectSilence(videoPath);
        checkAborted(); // Check after silence detection
      }

      await updateStatus("transcribing");
      const audioPath = await extractAudio(videoPath);
      tempFiles.push(audioPath);
      checkAborted(); // Check after audio extraction

      transcript = await transcribeAudio(audioPath);
      checkAborted(); // Check after transcription (expensive AI call)

      const analysis = await analyzeVideoFrames(
        framePaths,
        metadata.duration,
        silentSegments
      );
      checkAborted(); // Check after frame analysis (expensive AI call)

      await storage.updateVideoProject(id, {
        analysis,
        transcript,
        duration: Math.round(metadata.duration),
      });

      await updateStatus("planning");
      
      // Perform semantic transcript analysis for context-aware B-roll and AI images
      let semanticAnalysis: SemanticAnalysis | undefined;
      const needsSemanticAnalysis = editOptions.addBroll || editOptions.generateAiImages;
      
      if (needsSemanticAnalysis) {
        if (transcript.length > 0) {
          // Detect transcript language
          const detectedLanguage = detectTranscriptLanguage(transcript);
          
          // Persist detected language in video context
          if (analysis.context) {
            analysis.context.languageDetected = detectedLanguage;
          }
          
          // Translate to English if non-English (for Gemini semantic analysis)
          let transcriptForAnalysis = transcript;
          if (detectedLanguage !== "en") {
            routesLogger.info(`Transcript is in ${detectedLanguage}, translating to English for semantic analysis...`);
            transcriptForAnalysis = await translateTranscriptToEnglish(transcript, detectedLanguage);
            
            // Verify translation produced English text
            const translatedLanguage = detectTranscriptLanguage(transcriptForAnalysis);
            if (translatedLanguage !== "en") {
              routesLogger.warn(`Translation may have failed: detected ${translatedLanguage} instead of English`);
            }
          }
          
          routesLogger.info("Performing semantic transcript analysis...");
          checkAborted(); // Check before semantic analysis
          // Use translated transcript for analysis, but original timestamps are preserved
          semanticAnalysis = await analyzeTranscriptSemantics(
            transcriptForAnalysis,
            analysis.context,
            metadata.duration
          );
          checkAborted(); // Check after semantic analysis
        } else {
          // Fallback: Generate B-roll windows from video analysis when no transcript available
          routesLogger.info("No transcript available, creating fallback semantic analysis from video context...");
          const videoContext = analysis.context;
          const toneMap: { [key: string]: "serious" | "inspirational" | "educational" | "casual" | "professional" | "entertaining" } = {
            "serious": "serious", "calm": "casual", "inspirational": "inspirational",
            "casual": "casual", "professional": "professional", "humorous": "entertaining", "dramatic": "serious"
          };
          semanticAnalysis = {
            mainTopics: ["video content"],
            overallTone: toneMap[videoContext?.tone || "casual"] || "casual",
            keyMoments: [],
            brollWindows: [
              // Create evenly-spaced B-roll opportunities based on video duration
              { start: Math.min(5, metadata.duration * 0.1), end: Math.min(10, metadata.duration * 0.15), priority: "high" as const, suggestedQuery: videoContext?.genre || "professional footage", context: "Opening visual", reason: "Visual enhancement" },
              { start: metadata.duration * 0.3, end: metadata.duration * 0.35, priority: "medium" as const, suggestedQuery: videoContext?.suggestedEditStyle || "dynamic scene", context: "Mid-video visual", reason: "Content support" },
              { start: metadata.duration * 0.6, end: metadata.duration * 0.65, priority: "medium" as const, suggestedQuery: videoContext?.tone || "engaging content", context: "Later section visual", reason: "Engagement boost" },
            ],
            extractedKeywords: [],
            contentSummary: analysis.summary || "Video content analysis",
          };
        }
        
        routesLogger.info("Semantic analysis complete:", {
          topics: semanticAnalysis!.mainTopics,
          brollWindows: semanticAnalysis!.brollWindows.length,
          keywords: semanticAnalysis!.extractedKeywords.length,
        });
        
        // Store semantic analysis in the video analysis
        await storage.updateVideoProject(id, {
          analysis: { ...analysis, semanticAnalysis }
        });
      }
      
      const enhancedPrompt = `${prompt}
      
User has selected these options:
- Add Captions: ${editOptions.addCaptions ? "Yes" : "No"}
- Add B-Roll Stock Footage: ${editOptions.addBroll ? "Yes" : "No"}  
- Remove Silent Parts: ${editOptions.removeSilence ? "Yes" : "No"}
- Generate AI Images: ${editOptions.generateAiImages ? "Yes" : "No"}

Please create an edit plan that follows these preferences. Do NOT include any transition effects - transitions are not supported.`;

      checkAborted(); // Check before edit plan generation
      const editPlan = await generateEditPlan(enhancedPrompt, analysis, transcript, semanticAnalysis);
      checkAborted(); // Check after edit plan generation

      await storage.updateVideoProject(id, { editPlan });
      sendEvent("editPlan", { editPlan });

      let stockMedia: StockMediaItem[] = [];
      if (editOptions.addBroll) {
        await updateStatus("fetching_stock");
        checkAborted(); // Check before stock media fetch
        const stockQueries = editPlan.stockQueries || [];
        stockMedia = await fetchStockMedia(stockQueries);
        checkAborted(); // Check after stock media fetch
        await storage.updateVideoProject(id, { stockMedia });
        sendEvent("stockMedia", { stockMedia });
      }
      
      // Generate AI images if option is enabled and semantic analysis is available
      let aiGeneratedImages: StockMediaItem[] = [];
      if (editOptions.generateAiImages && semanticAnalysis && semanticAnalysis.brollWindows.length > 0) {
        await updateStatus("generating_ai_images");
        checkAborted(); // Check before AI image generation
        routesLogger.info("Generating AI images based on video content...");
        
        try {
          // Calculate optimal number of AI images based on video duration
          // Target: ~1 AI image per 8-10 seconds of video, minimum 3, maximum 12
          const videoDuration = metadata.duration;
          const optimalImages = Math.min(12, Math.max(3, Math.ceil(videoDuration / 8)));
          routesLogger.info(`Video is ${videoDuration.toFixed(1)}s, targeting ${optimalImages} AI images`);
          
          const generatedImages = await generateAiImagesForVideo(
            semanticAnalysis,
            analysis.context,
            optimalImages,
            videoDuration  // Pass video duration for distribution logic
          );
          checkAborted(); // Check after AI image generation (expensive operation)
          
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
          
          routesLogger.info(`Generated ${aiGeneratedImages.length} AI images`);
          sendEvent("aiImages", { count: aiGeneratedImages.length });
          
          // Add AI images to stock media for B-roll overlay
          stockMedia = [...stockMedia, ...aiGeneratedImages];
          await storage.updateVideoProject(id, { stockMedia });
        } catch (aiError) {
          routesLogger.error("AI image generation failed, continuing with stock media:", aiError);
          sendEvent("aiImagesError", { error: "AI image generation failed, using stock media only" });
        }
      }

      await updateStatus("editing");
      checkAborted(); // Check before final rendering (most expensive operation)
      await updateStatus("rendering");

      const editResult = await applyEdits(
        videoPath, 
        editPlan, 
        transcript,
        stockMedia,
        editOptions
      );
      checkAborted(); // Check after rendering
      
      // Send SSE event with AI image placement stats
      if (editOptions.generateAiImages) {
        sendEvent("aiImageStats", {
          applied: editResult.aiImagesApplied,
          skipped: editResult.aiImagesSkipped,
          stockApplied: editResult.stockMediaApplied,
          totalOverlays: editResult.brollOverlaysTotal,
        });
      }
      
      const outputMetadata = await getVideoMetadata(editResult.outputPath);

      const publicOutputPath = `/output/${path.basename(editResult.outputPath)}`;
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
        
        await storage.updateVideoProject(id, {
          status: "failed",
          errorMessage,
        });

        sendEvent("error", {
          error: errorMessage,
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
