import { storage } from "../storage";
import { getVideoMetadata, extractFrames, extractAudio, detectSilence } from "./videoProcessor";
import { analyzeVideoDeep, generateSmartEditPlan, transcribeAudioEnhanced } from "./ai";
import { generateAiImagesForVideo } from "./ai/imageGeneration";
import { fetchStockMediaWithVariants, type StockMediaVariants } from "./pexelsService";
import { fetchFreepikMediaWithVariants, isFreepikConfigured } from "./freepikService";
import { selectBestMediaForWindows, convertSelectionsToStockMediaItems } from "./ai/mediaSelector";
import type { ProcessingStatus, ReviewData, StockMediaItem } from "@shared/schema";
import path from "path";
import os from "os";
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
  warn: (...args: unknown[]) => console.warn(`${new Date().toLocaleTimeString()} [WARN] [background-processor]`, ...args),
  error: (...args: unknown[]) => console.error(`${new Date().toLocaleTimeString()} [ERROR] [background-processor]`, ...args),
  debug: (...args: unknown[]) => console.log(`${new Date().toLocaleTimeString()} [DEBUG] [background-processor]`, ...args),
};

const TEMP_DIR = os.tmpdir();
const UPLOADS_DIR = path.join(TEMP_DIR, "malika_uploads");
const OUTPUT_DIR = path.join(TEMP_DIR, "malika_output");

const processingLocks = new Map<number, { acquired: boolean; timestamp: number }>();
const LOCK_TIMEOUT_MS = 30 * 60 * 1000;

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
    
    // Validate metadata to prevent null pointer errors
    if (!metadata || typeof metadata.duration !== 'number' || isNaN(metadata.duration)) {
      throw new Error("Failed to read video metadata. The video file may be corrupted or in an unsupported format.");
    }
    
    addActivity(projectId, `Video info: ${metadata.duration.toFixed(1)}s duration, ${metadata.width || 0}x${metadata.height || 0}`);

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
    
    // Flatten analysis to match videoAnalysisSchema - spread videoAnalysis props at top level
    const sanitizedAnalysis = {
      ...analysis.videoAnalysis,
      duration: validDuration,
      frames: analysis.videoAnalysis?.frames || [],
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
    
    // Use the already sanitized analysis with valid duration (now flattened)
    const editPlan = await generateSmartEditPlan(
      prompt,
      sanitizedAnalysis,
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
      
      processorLogger.info(`Media conversion result: ${stockItems.length} stock items, ${selectedAiImages.length} AI images`);
      
      // Guardrail: Check if AI images were generated but not selected
      if (generatedAiImages.length > 0 && selectedAiImages.length === 0) {
        processorLogger.warn(`GUARDRAIL WARNING: ${generatedAiImages.length} AI images were generated but 0 were selected by media selector. Check selection logic.`);
      }
      
      if (stockItems.length > 0) {
        processorLogger.debug(`Stock items selected: ${stockItems.map(s => `${s.type}:${s.query?.slice(0,30)}`).join(', ')}`);
      }
      
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
