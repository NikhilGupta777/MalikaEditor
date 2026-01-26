import { storage } from "../storage";
import { getVideoMetadata, extractFrames, extractAudio, detectSilence } from "./videoProcessor";
import { analyzeVideoDeep, generateSmartEditPlan, transcribeAudio } from "./ai";
import { generateAiImagesForVideo } from "./ai/imageGeneration";
import { fetchStockMedia } from "./pexelsService";
import type { ProcessingStatus, ReviewData, StockMediaItem } from "@shared/schema";
import path from "path";
import fs from "fs/promises";

interface EditOptionsType {
  addCaptions: boolean;
  addBroll: boolean;
  removeSilence: boolean;
  generateAiImages: boolean;
  addTransitions: boolean;
}

let onJobCompleteCallback: ((projectId: number) => void) | null = null;

export function setOnJobComplete(callback: (projectId: number) => void) {
  onJobCompleteCallback = callback;
}

const processorLogger = {
  info: (...args: unknown[]) => console.log(`${new Date().toLocaleTimeString()} [INFO] [background-processor]`, ...args),
  error: (...args: unknown[]) => console.error(`${new Date().toLocaleTimeString()} [ERROR] [background-processor]`, ...args),
  debug: (...args: unknown[]) => console.log(`${new Date().toLocaleTimeString()} [DEBUG] [background-processor]`, ...args),
};

const UPLOADS_DIR = "/tmp/uploads";
const OUTPUT_DIR = "/tmp/output";

interface ProcessingJob {
  projectId: number;
  status: "queued" | "processing" | "completed" | "failed";
  activities: Array<{ message: string; timestamp: number }>;
  abortController?: AbortController;
  slotReserved: boolean;
}

const activeJobs = new Map<number, ProcessingJob>();
const jobSubscribers = new Map<number, Set<(event: { type: string; data: Record<string, unknown> }) => void>>();

export function getJobStatus(projectId: number): ProcessingJob | undefined {
  return activeJobs.get(projectId);
}

export function getJobActivities(projectId: number): Array<{ message: string; timestamp: number }> {
  return activeJobs.get(projectId)?.activities || [];
}

export function subscribeToJob(projectId: number, callback: (event: { type: string; data: Record<string, unknown> }) => void): () => void {
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
  const subscribers = jobSubscribers.get(projectId);
  if (subscribers) {
    Array.from(subscribers).forEach(callback => {
      try {
        callback({ type, data });
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

export async function startProcessingJob(
  projectId: number,
  prompt: string,
  editOptions: EditOptionsType
): Promise<void> {
  if (activeJobs.has(projectId)) {
    const existingJob = activeJobs.get(projectId)!;
    if (existingJob.status === "processing") {
      processorLogger.info(`Project ${projectId} is already being processed`);
      return;
    }
  }

  const job: ProcessingJob = {
    projectId,
    status: "processing",
    activities: [],
    slotReserved: true,
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
  editOptions: EditOptionsType
): Promise<void> {
  const job = activeJobs.get(projectId);
  if (!job) return;

  const updateStatus = async (status: ProcessingStatus) => {
    await storage.updateVideoProject(projectId, { status });
    notifySubscribers(projectId, "status", { status });
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

    await updateStatus("analyzing");
    addActivity(projectId, "Reading video metadata...");
    const metadata = await getVideoMetadata(videoPath);
    addActivity(projectId, `Video info: ${metadata.duration.toFixed(1)}s duration, ${metadata.width}x${metadata.height}`);

    const numFrames = Math.min(12, Math.max(6, Math.floor(metadata.duration / 10)));
    addActivity(projectId, `Extracting ${numFrames} key frames for AI analysis...`);
    const framePaths = await extractFrames(videoPath, numFrames);
    addActivity(projectId, `Extracted ${framePaths.length} frames successfully`);
    tempFiles.push(path.dirname(framePaths[0]));

    let silentSegments: { start: number; end: number }[] = [];
    if (editOptions.removeSilence) {
      addActivity(projectId, "Scanning audio for silent segments...");
      silentSegments = await detectSilence(videoPath);
      addActivity(projectId, `Found ${silentSegments.length} silent segments to remove`);
    }

    await updateStatus("transcribing");
    addActivity(projectId, "Extracting audio track...");
    const audioPath = await extractAudio(videoPath);
    tempFiles.push(audioPath);

    addActivity(projectId, "Transcribing audio with AI...");
    const transcript = await transcribeAudio(audioPath, metadata.duration);
    addActivity(projectId, `Transcription complete: ${transcript.length} segments`);

    await storage.updateVideoProject(projectId, { transcript });
    notifySubscribers(projectId, "transcript", { transcript });

    addActivity(projectId, "Performing deep video analysis...");
    const analysis = await analyzeVideoDeep(
      framePaths,
      metadata.duration,
      silentSegments,
      transcript
    );

    const brollWindows = analysis.semanticAnalysis?.brollWindows?.length || 0;
    const hookStrength = analysis.semanticAnalysis?.hookMoments?.[0]?.score || 0;
    addActivity(projectId, `Deep analysis complete: ${brollWindows} B-roll windows, hook strength: ${hookStrength}`);

    await storage.updateVideoProject(projectId, {
      analysis: { 
        ...analysis, 
        semanticAnalysis: analysis.semanticAnalysis 
      },
    });

    notifySubscribers(projectId, "enhancedAnalysis", {
      hookMoments: analysis.semanticAnalysis?.hookMoments,
      topicFlow: analysis.semanticAnalysis?.topicFlow,
      structureAnalysis: analysis.semanticAnalysis?.structureAnalysis,
      keyMoments: analysis.semanticAnalysis?.keyMoments,
      fillerSegments: [],
      qualityInsights: {
        hookStrength,
        pacingScore: 75,
        engagementPrediction: 80,
        recommendations: [],
      },
    });

    await updateStatus("planning");
    addActivity(projectId, "Creating intelligent edit plan...");
    const fillerSegments: { start: number; end: number; word: string }[] = [];
    const editPlan = await generateSmartEditPlan(
      prompt,
      analysis,
      transcript,
      analysis.semanticAnalysis || {},
      fillerSegments
    );
    addActivity(projectId, `Edit plan ready: ${editPlan.actions?.length || 0} actions planned`);

    await storage.updateVideoProject(projectId, { editPlan });
    notifySubscribers(projectId, "editPlan", { editPlan });

    await updateStatus("fetching_stock");
    addActivity(projectId, "Fetching stock media for B-roll...");
    let stockMedia: StockMediaItem[] = [];
    if (editOptions.addBroll) {
      const stockQueries = editPlan.stockQueries || 
        analysis.semanticAnalysis?.brollWindows?.map(w => w.suggestedQuery) || [];
      
      if (stockQueries.length > 0) {
        stockMedia = await fetchStockMedia(stockQueries.slice(0, 3));
        addActivity(projectId, `Found ${stockMedia.length} stock media items`);
      }
    }

    await storage.updateVideoProject(projectId, { stockMedia });
    notifySubscribers(projectId, "stockMedia", { stockMedia });

    let aiImageCount = 0;
    if (editOptions.generateAiImages && analysis.semanticAnalysis) {
      await updateStatus("generating_ai_images");
      addActivity(projectId, "Generating AI images for overlays...");
      
      try {
        const aiImages = await generateAiImagesForVideo(
          analysis.semanticAnalysis,
          undefined,
          3,
          metadata.duration
        );
        
        const aiStockItems: StockMediaItem[] = aiImages.map(img => ({
          id: img.id || `ai_${Date.now()}`,
          type: 'ai_generated' as const,
          url: img.localPath || '',
          query: img.prompt,
          thumbnailUrl: img.localPath || '',
          width: 1024,
          height: 1024,
          source: 'imagen',
          startTime: img.startTime,
          endTime: img.endTime,
        }));
        
        stockMedia = [...stockMedia, ...aiStockItems];
        aiImageCount = aiStockItems.length;
        addActivity(projectId, `Generated ${aiImageCount} AI images`);
        
        await storage.updateVideoProject(projectId, { stockMedia });
        notifySubscribers(projectId, "aiImages", { count: aiImageCount });
      } catch (aiError) {
        processorLogger.error("AI image generation failed:", aiError);
        addActivity(projectId, "AI image generation failed, continuing with stock media only");
        notifySubscribers(projectId, "aiImagesError", { 
          message: "AI image generation failed, continuing with stock media only" 
        });
      }
    }

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
      userApproved: false,
    };

    await storage.updateVideoProject(projectId, {
      status: "awaiting_review",
      reviewData,
    });

    notifySubscribers(projectId, "reviewReady", { reviewData });
    notifySubscribers(projectId, "status", { status: "awaiting_review" });
    addActivity(projectId, "Processing complete! Ready for your review.");

    job.status = "completed";
    processorLogger.info(`Background processing completed for project ${projectId}`);

    for (const file of tempFiles) {
      try {
        const stat = await fs.stat(file);
        if (stat.isDirectory()) {
          await fs.rm(file, { recursive: true });
        } else {
          await fs.unlink(file);
        }
      } catch {
      }
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Processing failed";
    processorLogger.error(`Processing failed for project ${projectId}:`, error);
    
    job.status = "failed";
    addActivity(projectId, `Processing failed: ${errorMessage}`);
    
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
      } catch {
      }
    }
  } finally {
    // Call the completion callback to release the slot only if it was reserved
    const job = activeJobs.get(projectId);
    if (job?.slotReserved && onJobCompleteCallback) {
      job.slotReserved = false;
      onJobCompleteCallback(projectId);
    }
    
    // Clean up job after a delay to allow reconnections
    setTimeout(() => {
      if (activeJobs.get(projectId)?.status !== "processing") {
        activeJobs.delete(projectId);
        jobSubscribers.delete(projectId);
        processorLogger.debug(`Cleaned up job data for project ${projectId}`);
      }
    }, 300000);
  }
}

export function isJobActive(projectId: number): boolean {
  const job = activeJobs.get(projectId);
  return job?.status === "processing";
}
