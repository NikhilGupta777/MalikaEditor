import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import path from "path";
import { promises as fs } from "fs";
import { v4 as uuidv4 } from "uuid";
import { storage } from "./storage";
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
} from "./services/aiService";
import type { SemanticAnalysis } from "@shared/schema";
import { fetchStockMedia } from "./services/pexelsService";

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

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  await ensureDirs();

  app.use("/uploads", async (req, res, next) => {
    const requestedPath = path.normalize(req.path).replace(/^(\.\.[\/\\])+/, '');
    const filePath = path.join(UPLOADS_DIR, requestedPath);
    if (!filePath.startsWith(UPLOADS_DIR)) {
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
    const requestedPath = path.normalize(req.path).replace(/^(\.\.[\/\\])+/, '');
    const filePath = path.join(OUTPUT_DIR, requestedPath);
    if (!filePath.startsWith(OUTPUT_DIR)) {
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
        console.error("Upload error:", error);
        res.status(500).json({
          error: error instanceof Error ? error.message : "Upload failed",
        });
      }
    }
  );

  app.get("/api/videos/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) {
        return res.status(400).json({ error: "Invalid project ID" });
      }
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
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid project ID" });
    }
    const prompt = req.query.prompt as string;
    
    const editOptions: EditOptions = {
      addCaptions: req.query.addCaptions !== "false",
      addBroll: req.query.addBroll !== "false",
      removeSilence: req.query.removeSilence !== "false",
      generateAiImages: req.query.generateAiImages === "true",
      addTransitions: req.query.addTransitions === "true",
    };

    if (!prompt) {
      return res.status(400).json({ error: "Prompt is required" });
    }

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

    let connectionClosed = false;
    req.on("close", () => {
      connectionClosed = true;
    });

    const sendEvent = (type: string, data: any) => {
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
      await storage.updateVideoProject(id, { status });
      sendEvent("status", { status });
    };

    let tempFiles: string[] = [];
    let transcript: { start: number; end: number; text: string }[] = [];

    try {
      await storage.updateVideoProject(id, { prompt });

      await updateStatus("analyzing");
      const metadata = await getVideoMetadata(videoPath);

      const numFrames = Math.min(12, Math.max(6, Math.floor(metadata.duration / 10)));
      const framePaths = await extractFrames(videoPath, numFrames);
      tempFiles.push(path.dirname(framePaths[0]));

      let silentSegments: { start: number; end: number }[] = [];
      if (editOptions.removeSilence) {
        silentSegments = await detectSilence(videoPath);
      }

      await updateStatus("transcribing");
      const audioPath = await extractAudio(videoPath);
      tempFiles.push(audioPath);

      transcript = await transcribeAudio(audioPath);

      const analysis = await analyzeVideoFrames(
        framePaths,
        metadata.duration,
        silentSegments
      );

      await storage.updateVideoProject(id, {
        analysis,
        transcript,
        duration: Math.round(metadata.duration),
      });

      await updateStatus("planning");
      
      // Perform semantic transcript analysis for context-aware B-roll
      let semanticAnalysis: SemanticAnalysis | undefined;
      if (editOptions.addBroll && transcript.length > 0) {
        console.log("Performing semantic transcript analysis...");
        semanticAnalysis = await analyzeTranscriptSemantics(
          transcript,
          analysis.context,
          metadata.duration
        );
        console.log("Semantic analysis complete:", {
          topics: semanticAnalysis.mainTopics,
          brollWindows: semanticAnalysis.brollWindows.length,
          keywords: semanticAnalysis.extractedKeywords.length,
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
- Add Transitions: ${editOptions.addTransitions ? "Yes" : "No"}

Please create an edit plan that follows these preferences.`;

      const editPlan = await generateEditPlan(enhancedPrompt, analysis, transcript, semanticAnalysis);

      await storage.updateVideoProject(id, { editPlan });
      sendEvent("editPlan", { editPlan });

      let stockMedia: any[] = [];
      if (editOptions.addBroll) {
        await updateStatus("fetching_stock");
        const stockQueries = editPlan.stockQueries || [];
        stockMedia = await fetchStockMedia(stockQueries);
        await storage.updateVideoProject(id, { stockMedia });
        sendEvent("stockMedia", { stockMedia });
      }

      await updateStatus("editing");
      await updateStatus("rendering");

      const outputPath = await applyEdits(
        videoPath, 
        editPlan, 
        transcript,
        stockMedia,
        editOptions
      );
      const outputMetadata = await getVideoMetadata(outputPath);

      const publicOutputPath = `/output/${path.basename(outputPath)}`;
      await storage.updateVideoProject(id, {
        status: "completed",
        outputPath: publicOutputPath,
        duration: Math.round(outputMetadata.duration),
      });

      sendEvent("complete", {
        outputPath: publicOutputPath,
        duration: Math.round(outputMetadata.duration),
      });

      await cleanupTempFiles(tempFiles);
    } catch (error) {
      console.error("Processing error:", error);

      await storage.updateVideoProject(id, {
        status: "failed",
        errorMessage: error instanceof Error ? error.message : "Processing failed",
      });

      sendEvent("error", {
        error: error instanceof Error ? error.message : "Processing failed",
      });

      await cleanupTempFiles(tempFiles);
    } finally {
      clearInterval(heartbeatInterval);
      if (!connectionClosed) {
        res.end();
      }
    }
  });

  app.get("/api/videos", async (req: Request, res: Response) => {
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
