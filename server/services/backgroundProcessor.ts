import { storage } from "../storage";
import { getVideoMetadata, extractFrames, extractAudio, detectSilence } from "./videoProcessor";
import { analyzeVideoDeep, generateSmartEditPlan, transcribeAudio } from "./ai";
import { generateAiImagesForVideo } from "./ai/imageGeneration";
import { fetchStockMediaWithVariants } from "./pexelsService";
import { selectBestMediaForWindows, convertSelectionsToStockMediaItems } from "./ai/mediaSelector";
// Dynamic limits removed - AI decides counts based on content
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
  abortController?: AbortController;
  slotReserved: boolean;
  startTime: Date;
}

const MAX_EVENT_HISTORY = 100; // Keep last 100 events for replay
const activeJobs = new Map<number, ProcessingJob>();
const jobSubscribers = new Map<number, Set<(event: SSEEvent) => void>>();

// Slot management - export functions for routes.ts to use
export const MAX_CONCURRENT_JOBS = 3;

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
  return job.eventHistory.filter(event => event.id > lastEventId);
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
    job.eventHistory.shift();
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
    eventHistory: [],
    lastEventId: 0,
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
    tempFiles.push(path.dirname(framePaths[0]));
    tempFiles.push(audioPath);
    
    if (editOptions.removeSilence) {
      addActivity(projectId, `Found ${silentSegments.length} silent segments to remove`);
    }

    // PHASE 2: Transcription (requires audio)
    await updateStatus("transcribing");
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

    const brollWindowCount = analysis.semanticAnalysis?.brollWindows?.length || 0;
    const hookStrength = analysis.semanticAnalysis?.hookMoments?.[0]?.score || 0;
    addActivity(projectId, `Deep analysis complete: ${brollWindowCount} B-roll windows, hook strength: ${hookStrength}`);

    // Ensure analysis has valid duration (fallback to metadata.duration or transcript end)
    const transcriptEnd = transcript[transcript.length - 1]?.end || 0;
    const validDuration = (analysis.videoAnalysis?.duration && !isNaN(analysis.videoAnalysis.duration))
      ? analysis.videoAnalysis.duration
      : (metadata.duration || transcriptEnd || 60);
    
    const sanitizedAnalysis = {
      ...analysis,
      videoAnalysis: {
        ...analysis.videoAnalysis,
        duration: validDuration,
        frames: analysis.videoAnalysis?.frames || [],
      },
      semanticAnalysis: analysis.semanticAnalysis,
    };
    
    await storage.updateVideoProject(projectId, {
      analysis: sanitizedAnalysis,
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
    
    // Use the already sanitized analysis with valid duration
    const editPlan = await generateSmartEditPlan(
      prompt,
      sanitizedAnalysis.videoAnalysis,
      transcript,
      sanitizedAnalysis.semanticAnalysis || {},
      fillerSegments
    );
    addActivity(projectId, `Edit plan ready: ${editPlan.actions?.length || 0} actions planned`);

    await storage.updateVideoProject(projectId, { editPlan });
    notifySubscribers(projectId, "editPlan", { editPlan });

    await updateStatus("fetching_stock");
    let stockMedia: StockMediaItem[] = [];
    let aiImageCount = 0;
    
    const brollWindows = analysis.semanticAnalysis?.brollWindows || [];
    const stockQueries = editPlan.stockQueries || 
      brollWindows.map(w => w.suggestedQuery).filter(Boolean) || [];
    
    if (editOptions.addBroll && stockQueries.length > 0) {
      // PARALLEL PHASE 3: Fetch stock media AND generate AI images simultaneously
      // These are completely independent operations
      const shouldGenerateAi = editOptions.generateAiImages && analysis.semanticAnalysis;
      
      addActivity(projectId, `Fetching stock media${shouldGenerateAi ? ' + generating AI images' : ''} in parallel...`);
      const mediaFetchStart = Date.now();
      
      // No limits - AI decides count based on content analysis
      processorLogger.info(`Processing ${metadata.duration}s video with ${stockQueries.length} stock queries, AI images based on content`);
      
      // Run stock fetch and AI generation in parallel
      const [stockVariants, aiImagesResult] = await Promise.all([
        // Stock media fetching - use all queries from AI analysis
        fetchStockMediaWithVariants(stockQueries, 3, 3),
        // AI image generation (if enabled) - no limit, AI decides based on content
        shouldGenerateAi
          ? generateAiImagesForVideo(
              analysis.semanticAnalysis!,
              undefined,
              undefined, // No limit - generate for all AI-selected windows
              metadata.duration
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
      
      const mediaFetchTime = ((Date.now() - mediaFetchStart) / 1000).toFixed(1);
      const totalPhotos = stockVariants.reduce((sum, v) => sum + v.photos.length, 0);
      const totalVideos = stockVariants.reduce((sum, v) => sum + v.videos.length, 0);
      
      const generatedAiImages = aiImagesResult || [];
      aiImageCount = generatedAiImages.length;
      
      addActivity(projectId, `Parallel media fetch complete in ${mediaFetchTime}s: ${totalPhotos} photos + ${totalVideos} videos + ${aiImageCount} AI images`);
      
      addActivity(projectId, "AI selecting best media for each B-roll window...");
      const selectionResult = await selectBestMediaForWindows(
        brollWindows as { start: number; end: number; suggestedQuery: string; priority: "high" | "medium" | "low"; context?: string }[],
        stockVariants,
        generatedAiImages,
        {
          duration: metadata.duration,
          genre: analysis.semanticAnalysis?.overallTone || "general",
          tone: analysis.semanticAnalysis?.overallTone || "professional",
          topic: analysis.semanticAnalysis?.mainTopics?.[0] || "various",
        }
      );
      
      addActivity(projectId, `AI selected ${selectionResult.totalSelected} clips: ${selectionResult.aiImagesUsed} AI, ${selectionResult.stockVideosUsed} videos, ${selectionResult.stockImagesUsed} images`);
      
      const { stockItems, aiImages: selectedAiImages } = convertSelectionsToStockMediaItems(selectionResult.selections);
      
      const aiStockItems: StockMediaItem[] = selectedAiImages.map((img, idx) => ({
        id: `ai_${Date.now()}_${idx}`,
        type: 'ai_generated' as const,
        url: img.base64Data ? `data:${img.mimeType};base64,${img.base64Data}` : '',
        query: img.prompt,
        thumbnailUrl: img.base64Data ? `data:${img.mimeType};base64,${img.base64Data}` : '',
        width: 1024,
        height: 1024,
        source: 'imagen',
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
          undefined, // No limit - AI decides based on content
          metadata.duration
        );
        
        const aiStockItems: StockMediaItem[] = aiImages.map((img, idx) => ({
          id: `ai_${Date.now()}_${idx}`,
          type: 'ai_generated' as const,
          url: img.base64Data ? `data:${img.mimeType};base64,${img.base64Data}` : '',
          query: img.prompt,
          thumbnailUrl: img.base64Data ? `data:${img.mimeType};base64,${img.base64Data}` : '',
          width: 1024,
          height: 1024,
          source: 'imagen',
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
      } catch (cleanupErr) {
        // File may already be deleted or doesn't exist - ignore
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
      } catch (cleanupErr) {
        // File may already be deleted or doesn't exist - ignore
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
