import { getGeminiClient } from "./clients";
import { createLogger } from "../../utils/logger";
import { withRetry, AI_RETRY_OPTIONS } from "../../utils/retry";
import { AI_CONFIG } from "../../config/ai";
import type { StockMediaItem } from "@shared/schema";
import type { StockMediaVariants } from "../pexelsService";
import type { GeneratedAiImage } from "./imageGeneration";
import axios from "axios";
import { promises as fsPromises } from "fs";

const selectorLogger = createLogger("media-selector");

// Visual analysis cache to avoid re-analyzing the same thumbnails
// Uses LRU-style eviction to prevent memory leaks
const MAX_CACHE_SIZE = 500; // Maximum cached thumbnail descriptions
const visualAnalysisCache = new Map<string, string>();
const VISUAL_ANALYSIS_CONCURRENCY = 5; // Analyze 5 thumbnails at a time
const VISUAL_ANALYSIS_TIMEOUT = 8000; // 8 second timeout per thumbnail
const MAX_VISION_CANDIDATES = 100; // Maximum candidates to analyze with Vision API (increased for longer videos)

// LRU cache eviction - removes oldest entries when cache exceeds max size
function addToCacheWithEviction(key: string, value: string): void {
  // If cache is full, remove oldest entries (first 20% of entries)
  if (visualAnalysisCache.size >= MAX_CACHE_SIZE) {
    const keysToRemove = Math.ceil(MAX_CACHE_SIZE * 0.2);
    const keysArray = Array.from(visualAnalysisCache.keys());
    for (let i = 0; i < keysToRemove && i < keysArray.length; i++) {
      visualAnalysisCache.delete(keysArray[i]);
    }
    selectorLogger.debug(`Cache eviction: removed ${keysToRemove} old entries`);
  }
  visualAnalysisCache.set(key, value);
}

// Keywords that indicate motion/action content where VIDEO is preferred over static images
const MOTION_KEYWORDS = [
  'motion', 'moving', 'action', 'dynamic', 'flow', 'flowing', 'running', 'walking',
  'flying', 'driving', 'swimming', 'dancing', 'jumping', 'falling', 'spinning',
  'explosion', 'eruption', 'flood', 'tornado', 'hurricane', 'storm', 'wave', 'waves',
  'fire', 'flames', 'burning', 'smoke', 'rain', 'raining', 'snow', 'snowing',
  'timelapse', 'time-lapse', 'montage', 'sequence', 'transition', 'animation',
  'traffic', 'crowd', 'people walking', 'city life', 'busy', 'movement',
  'waterfall', 'river', 'ocean', 'stream', 'clouds moving', 'wind', 'blowing'
];

// Detect if a query suggests motion/action content that needs video
function detectMotionContent(query: string): boolean {
  const lowerQuery = query.toLowerCase();
  return MOTION_KEYWORDS.some(keyword => lowerQuery.includes(keyword));
}

interface BrollWindow {
  start: number;
  end: number;
  suggestedQuery: string;
  priority: "high" | "medium" | "low";
  context?: string;
  animationPreset?: string;
}

export interface MediaCandidate {
  id: string;
  type: "image" | "video" | "ai_generated";
  source: "stock" | "ai";
  provider?: "pexels" | "freepik" | "ai"; // Stock media provider
  query: string;
  url: string;
  thumbnailUrl?: string;
  duration?: number;
  description?: string;
  visualDescription?: string; // AI-generated description of actual visual content
  originalAiImage?: GeneratedAiImage;
}

export interface SelectedMedia {
  windowIndex: number;
  window: BrollWindow;
  selectedMedia: MediaCandidate[];
  reasoning: string;
  allowMultipleClips: boolean;
}

export interface MediaSelectionResult {
  selections: SelectedMedia[];
  totalSelected: number;
  aiImagesUsed: number;
  stockVideosUsed: number;
  stockImagesUsed: number;
}

async function fetchThumbnailAsBase64(url: string): Promise<{ base64: string; mimeType: string } | null> {
  try {
    if (url.startsWith("/") || url.startsWith("./") || url.startsWith("../") || url.match(/^[A-Za-z]:\\/)) {
      const data = await fsPromises.readFile(url);
      const ext = url.split(".").pop()?.toLowerCase() || "jpeg";
      const mimeMap: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
      return { base64: data.toString("base64"), mimeType: mimeMap[ext] || "image/jpeg" };
    }

    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: VISUAL_ANALYSIS_TIMEOUT,
      headers: {
        'Accept': 'image/*',
        'User-Agent': 'Mozilla/5.0 (compatible; VideoEditor/1.0)',
      },
    });

    const contentType = response.headers['content-type'] || 'image/jpeg';
    const base64 = Buffer.from(response.data).toString('base64');
    return { base64, mimeType: contentType };
  } catch (error) {
    selectorLogger.debug(`Failed to fetch thumbnail: ${url.slice(0, 50)}...`);
    return null;
  }
}

async function analyzeThumbnailWithVision(
  thumbnailUrl: string,
  query: string,
  mediaType: "image" | "video"
): Promise<string> {
  if (visualAnalysisCache.has(thumbnailUrl)) {
    return visualAnalysisCache.get(thumbnailUrl)!;
  }

  try {
    const gemini = getGeminiClient();
    const thumbnail = await fetchThumbnailAsBase64(thumbnailUrl);

    if (!thumbnail) {
      return `Unable to analyze (thumbnail unavailable)`;
    }

    const prompt = `Describe this ${mediaType === "video" ? "video thumbnail" : "stock photo"} in 1-2 sentences. 
Focus on: main subjects, actions, setting, mood, colors, and quality.
Be specific about what you SEE, not what the search query "${query}" suggests.
IMPORTANT: If the image has any visible watermark, logo overlay, or branding text (e.g. "FREEPIK", "Shutterstock", "Getty"), START your description with "⚠️ WATERMARKED:".
Format: "[Subject] [action/state] in [setting]. [Mood/quality note]"`;

    const result = await gemini.models.generateContent({
      model: AI_CONFIG.models.mediaVision,
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          { inlineData: { mimeType: thumbnail.mimeType, data: thumbnail.base64 } }
        ]
      }],
    });

    const description = result.text?.trim() || "Visual content analyzed";
    addToCacheWithEviction(thumbnailUrl, description);
    return description;
  } catch (error) {
    selectorLogger.debug(`Vision analysis failed for: ${thumbnailUrl.slice(0, 50)}...`);
    return `Stock ${mediaType} matching "${query}"`;
  }
}

const BATCH_VISION_SIZE = 5;

async function analyzeThumbnailBatchWithVision(
  candidates: { url: string; query: string; mediaType: "image" | "video"; id: string }[]
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const uncached = candidates.filter(c => {
    if (visualAnalysisCache.has(c.url)) {
      results.set(c.id, visualAnalysisCache.get(c.url)!);
      return false;
    }
    return true;
  });

  if (uncached.length === 0) return results;

  const gemini = getGeminiClient();

  for (let i = 0; i < uncached.length; i += BATCH_VISION_SIZE) {
    const batch = uncached.slice(i, i + BATCH_VISION_SIZE);
    const thumbnails = await Promise.all(
      batch.map(async (c) => ({ ...c, thumbnail: await fetchThumbnailAsBase64(c.url) }))
    );

    const validThumbnails = thumbnails.filter(t => t.thumbnail !== null);
    if (validThumbnails.length === 0) {
      batch.forEach(c => results.set(c.id, `Stock ${c.mediaType} matching "${c.query}"`));
      continue;
    }

    try {
      const parts: any[] = [
        { text: `Describe each of the following ${validThumbnails.length} media items in 1-2 sentences each.\nFor each, focus on: main subjects, actions, setting, mood, colors, and quality.\nBe specific about what you SEE.\nIMPORTANT: If the image has any visible watermark, logo overlay, or branding text (e.g. "FREEPIK", "Shutterstock", "Getty"), START your description with "⚠️ WATERMARKED:" so we can deprioritize it.\n\nRespond with a JSON array of descriptions in order, e.g. ["description1", "description2", ...]` }
      ];

      validThumbnails.forEach((t, idx) => {
        parts.push({ text: `\n[Image ${idx + 1}] (${t.mediaType}, query: "${t.query}"):` });
        parts.push({ inlineData: { mimeType: t.thumbnail!.mimeType, data: t.thumbnail!.base64 } });
      });

      const result = await gemini.models.generateContent({
        model: AI_CONFIG.models.mediaVision,
        contents: [{ role: "user", parts }],
      });

      const responseText = result.text?.trim() || "";
      let descriptions: string[] = [];

      try {
        const jsonMatch = responseText.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          descriptions = JSON.parse(jsonMatch[0]);
        }
      } catch {
        descriptions = responseText.split(/\n+/).filter(l => l.trim().length > 10);
      }

      validThumbnails.forEach((t, idx) => {
        const desc = descriptions[idx] || `Stock ${t.mediaType} matching "${t.query}"`;
        addToCacheWithEviction(t.url, desc);
        results.set(t.id, desc);
      });

      const invalidFromBatch = batch.filter(c => !validThumbnails.find(v => v.id === c.id));
      invalidFromBatch.forEach(c => results.set(c.id, `Stock ${c.mediaType} matching "${c.query}"`));
    } catch (error) {
      selectorLogger.debug(`Batch vision analysis failed, falling back to individual`);
      for (const t of batch) {
        const desc = await analyzeThumbnailWithVision(t.url, t.query, t.mediaType);
        results.set(t.id, desc);
      }
    }
  }

  return results;
}

// Pre-filter candidates using metadata before expensive Vision API calls
function preFilterCandidatesByMetadata(
  candidates: MediaCandidate[],
  brollWindows: BrollWindow[],
  maxCandidates: number
): MediaCandidate[] {
  if (candidates.length <= maxCandidates) {
    return candidates; // No filtering needed
  }

  // Build a set of all B-roll queries for relevance matching
  const targetQueries = brollWindows.map(w => w.suggestedQuery.toLowerCase());
  const targetKeywords = new Set<string>();
  for (const query of targetQueries) {
    query.split(/\s+/).filter(w => w.length > 2).forEach(w => targetKeywords.add(w));
  }

  // Score each candidate based on metadata
  const scoredCandidates = candidates.map(candidate => {
    let score = 0;
    const candidateQuery = candidate.query.toLowerCase();

    // 1. Query keyword match (0-30 points)
    const candidateWords = candidateQuery.split(/\s+/).filter(w => w.length > 2);
    const matchingWords = candidateWords.filter(w => targetKeywords.has(w));
    score += Math.min(30, matchingWords.length * 10);

    // 2. Media type relevance — no source bias (AI-generated vs stock treated equally)
    // Only distinguish video vs still image based on whether motion content is needed.
    const hasMotionNeeds = brollWindows.some(w => detectMotionContent(w.suggestedQuery));
    if (hasMotionNeeds && candidate.type === "video") {
      score += 15; // Videos preferred when motion is needed (content-based, not source-based)
    } else {
      score += 10; // Equal base score for all still-image sources (AI or stock photo)
    }

    // 3. Duration appropriateness for videos (0-15 points)
    if (candidate.type === "video" && candidate.duration) {
      // Ideal B-roll duration is 3-8 seconds
      if (candidate.duration >= 3 && candidate.duration <= 8) {
        score += 15;
      } else if (candidate.duration >= 2 && candidate.duration <= 12) {
        score += 10;
      } else {
        score += 5;
      }
    }

    // 4. Provider preference: Freepik (premium) > Pexels (0-10 points)
    if (candidate.provider === "freepik") {
      score += 10;
    } else if (candidate.provider === "pexels") {
      score += 5;
    }

    // 5. Already cached in visual analysis (0-25 points) - saves API calls
    if (candidate.thumbnailUrl && visualAnalysisCache.has(candidate.thumbnailUrl)) {
      score += 25;
    }

    return { candidate, score };
  });

  // Sort by score descending and take top N
  scoredCandidates.sort((a, b) => b.score - a.score);
  const filtered = scoredCandidates.slice(0, maxCandidates).map(s => s.candidate);

  selectorLogger.info(`Pre-filtered ${candidates.length} candidates to ${filtered.length} using metadata scoring (saved ${candidates.length - filtered.length} Vision API calls)`);

  return filtered;
}

async function analyzeMediaThumbnails(
  candidates: MediaCandidate[],
  brollWindows?: BrollWindow[]
): Promise<Map<string, string>> {
  const aiCandidates = candidates.filter(c => c.source === "ai" && c.thumbnailUrl);
  let stockCandidates = candidates.filter(c => c.source === "stock" && c.thumbnailUrl);

  if (aiCandidates.length === 0 && stockCandidates.length === 0) {
    return new Map();
  }

  if (brollWindows && stockCandidates.length > MAX_VISION_CANDIDATES) {
    stockCandidates = preFilterCandidatesByMetadata(stockCandidates, brollWindows, MAX_VISION_CANDIDATES);
  }

  const allToAnalyze = [...aiCandidates, ...stockCandidates];
  const aiCount = aiCandidates.length;
  const stockCount = stockCandidates.length;

  selectorLogger.info(`Analyzing ${allToAnalyze.length} media thumbnails with batched Gemini Vision (${aiCount} AI images + ${stockCount} stock)...`);
  const startTime = Date.now();

  const batchInput = allToAnalyze.map(c => ({
    id: c.id,
    url: c.thumbnailUrl!,
    query: c.query,
    mediaType: (c.source === "ai" ? "image" : c.type) as "image" | "video",
  }));

  const results = await analyzeThumbnailBatchWithVision(batchInput);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const failedCount = allToAnalyze.length - results.size;
  if (failedCount > 0) {
    selectorLogger.warn(`Visual analysis: ${failedCount}/${allToAnalyze.length} thumbnails failed — they will be selected without visual context`);
  }
  selectorLogger.info(`Visual analysis complete: ${results.size}/${allToAnalyze.length} thumbnails analyzed in ${elapsed}s (batched, ~${Math.ceil(allToAnalyze.length / BATCH_VISION_SIZE)} API calls)`);

  return results;
}

// Enhanced context with motion/pacing analysis for intelligent media selection
interface EnhancedVideoContext {
  duration: number;
  genre?: string;
  tone?: string;
  topic?: string;
  // From enhancedAnalysis - motion data influences video vs image preference
  motionAnalysis?: {
    hasSignificantMotion: boolean;
    motionIntensity: "low" | "medium" | "high";
    actionSequences?: { start: number; end: number; description: string }[];
  };
  // From enhancedAnalysis - pacing data influences B-roll duration
  pacingAnalysis?: {
    overallPacing: "slow" | "moderate" | "fast" | "dynamic";
    pacingVariation: number;
    suggestedPacingAdjustments?: { timestamp: number; suggestion: string }[];
  };
}

// Return the AI-planned B-roll duration without artificial caps.
// The AI planner already considers pacing, content type, and context when choosing duration.
// Only enforce technical floor (0.5s) and ceiling (30s for safety).
function getOptimalBrollDuration(
  windowStart: number,
  windowEnd: number,
  _pacingAnalysis?: EnhancedVideoContext["pacingAnalysis"]
): number {
  const requestedDuration = windowEnd - windowStart;
  return Math.max(0.5, Math.min(requestedDuration, 30));
}

// Determine if video should be preferred over image based on motion analysis
function shouldPreferVideo(
  windowStart: number,
  windowEnd: number,
  motionAnalysis?: EnhancedVideoContext["motionAnalysis"]
): boolean {
  if (!motionAnalysis) {
    return false; // Default: no strong preference
  }

  // High motion intensity = prefer video
  if (motionAnalysis.motionIntensity === "high") {
    return true;
  }

  // Check if window overlaps with action sequence
  const actionSequences = motionAnalysis.actionSequences || [];
  for (const action of actionSequences) {
    const overlaps = windowStart < action.end && windowEnd > action.start;
    if (overlaps) {
      selectorLogger.debug(`Window ${windowStart.toFixed(1)}s overlaps action sequence: ${action.description}`);
      return true; // Prefer video during action
    }
  }

  return false;
}

export async function selectBestMediaForWindows(
  brollWindows: BrollWindow[],
  stockVariants: StockMediaVariants[],
  aiImages: GeneratedAiImage[],
  videoContext: EnhancedVideoContext
): Promise<MediaSelectionResult> {
  // OPTIMIZATION: Early exit if no B-roll windows - skip expensive Vision API calls
  if (brollWindows.length === 0) {
    selectorLogger.info("Visual analysis SKIPPED - no B-roll windows defined, nothing to select");
    return {
      selections: [],
      totalSelected: 0,
      aiImagesUsed: 0,
      stockVideosUsed: 0,
      stockImagesUsed: 0,
    };
  }

  const allCandidates = buildAllCandidates(stockVariants, aiImages);

  // OPTIMIZATION: Early exit if no candidates - skip expensive Vision API calls
  if (allCandidates.length === 0) {
    selectorLogger.info("Visual analysis SKIPPED - no media candidates available");
    return {
      selections: [],
      totalSelected: 0,
      aiImagesUsed: 0,
      stockVideosUsed: 0,
      stockImagesUsed: 0,
    };
  }

  let geminiAvailable = true;
  try {
    getGeminiClient();
  } catch {
    geminiAvailable = false;
    selectorLogger.warn("Gemini not available, using fallback selection");
  }

  if (!geminiAvailable) {
    selectorLogger.info("Visual analysis SKIPPED - Gemini not available, using fallback selection without visual analysis");
    return fallbackSelection(brollWindows, stockVariants, aiImages);
  }

  const selections: SelectedMedia[] = [];
  let aiImagesUsed = 0;
  let stockVideosUsed = 0;
  let stockImagesUsed = 0;
  const usedMediaIds = new Set<string>();

  const aiCount = allCandidates.filter(c => c.source === 'ai').length;
  const pexelsVideoCount = allCandidates.filter(c => c.provider === 'pexels' && c.type === 'video').length;
  const pexelsPhotoCount = allCandidates.filter(c => c.provider === 'pexels' && c.type === 'image').length;
  const freepikVideoCount = allCandidates.filter(c => c.provider === 'freepik' && c.type === 'video').length;
  const freepikPhotoCount = allCandidates.filter(c => c.provider === 'freepik' && c.type === 'image').length;

  selectorLogger.info(`Built ${allCandidates.length} media candidates: ${aiCount} AI, Pexels(${pexelsVideoCount} videos, ${pexelsPhotoCount} photos), Freepik(${freepikVideoCount} videos, ${freepikPhotoCount} photos)`);

  // Run visual analysis on stock media thumbnails (AI actually SEES the content)
  // Pre-filters to top candidates based on metadata to reduce Vision API costs
  const visualDescriptions = await analyzeMediaThumbnails(allCandidates, brollWindows);

  // Apply visual descriptions to candidates
  for (const candidate of allCandidates) {
    if (visualDescriptions.has(candidate.id)) {
      candidate.visualDescription = visualDescriptions.get(candidate.id);
    }
  }

  const analyzedCount = visualDescriptions.size;
  const watermarkedCount = [...visualDescriptions.values()].filter(d => d.includes("WATERMARKED")).length;
  if (watermarkedCount > 0) {
    selectorLogger.warn(`Detected ${watermarkedCount} watermarked assets in visual analysis — they will be deprioritized`);
  }
  if (analyzedCount > 0) {
    selectorLogger.info(`Applied visual analysis to ${analyzedCount} media candidates (${watermarkedCount} watermarked)`);
  }

  try {
    const batchSelection = await selectMediaForAllWindowsWithAI(
      brollWindows,
      allCandidates,
      videoContext,
      usedMediaIds
    );

    for (const selection of batchSelection) {
      if (selection.selectedMedia.length > 0) {
        selections.push(selection);

        for (const media of selection.selectedMedia) {
          usedMediaIds.add(media.id);
          if (media.source === "ai") aiImagesUsed++;
          else if (media.type === "video") stockVideosUsed++;
          else stockImagesUsed++;
        }
      }
    }
  } catch (error) {
    selectorLogger.error(`Batch AI selection failed:`, error);
    for (let i = 0; i < brollWindows.length; i++) {
      const window = brollWindows[i];
      const windowDuration = window.end - window.start;
      const availableCandidates = allCandidates.filter(c => !usedMediaIds.has(c.id));

      const fallback = fallbackSelectForWindow(window, availableCandidates, windowDuration);
      if (fallback) {
        selections.push({ ...fallback, windowIndex: i });
        for (const media of fallback.selectedMedia) {
          usedMediaIds.add(media.id);
          if (media.source === "ai") aiImagesUsed++;
          else if (media.type === "video") stockVideosUsed++;
          else stockImagesUsed++;
        }
      }
    }
  }

  const totalSelected = selections.reduce((sum, s) => sum + s.selectedMedia.length, 0);
  const totalAiAvailable = aiImages.length;

  // Count provider-specific selections
  const allSelected = selections.flatMap(s => s.selectedMedia);
  const pexelsUsed = allSelected.filter(m => m.provider === 'pexels').length;
  const freepikUsed = allSelected.filter(m => m.provider === 'freepik').length;

  selectorLogger.info(`Media selection complete: ${totalSelected} clips selected (${aiImagesUsed} AI, ${stockVideosUsed} stock videos [${pexelsUsed} Pexels, ${freepikUsed} Freepik], ${stockImagesUsed} stock images)`);

  // Guardrail: Warn when AI images were generated but not used
  if (totalAiAvailable > 0 && aiImagesUsed === 0) {
    selectorLogger.warn(`WARNING: ${totalAiAvailable} AI images were generated but NONE were selected. This may indicate a selection bias issue.`);
  } else if (totalAiAvailable > 0 && aiImagesUsed < Math.ceil(totalAiAvailable * 0.3)) {
    selectorLogger.warn(`Low AI image usage: ${aiImagesUsed}/${totalAiAvailable} AI images used (${((aiImagesUsed / totalAiAvailable) * 100).toFixed(0)}%). Consider rebalancing selection.`);
  }

  return {
    selections,
    totalSelected,
    aiImagesUsed,
    stockVideosUsed,
    stockImagesUsed,
  };
}

function buildAllCandidates(
  stockVariants: StockMediaVariants[],
  aiImages: GeneratedAiImage[]
): MediaCandidate[] {
  const candidates: MediaCandidate[] = [];
  const seenUrls = new Set<string>();

  for (let i = 0; i < aiImages.length; i++) {
    const ai = aiImages[i];
    const id = `ai_${i}_${ai.prompt.slice(0, 15).replace(/\s/g, '_')}`;
    candidates.push({
      id,
      type: "ai_generated",
      source: "ai",
      query: ai.prompt,
      url: `ai_image_${i}`,
      thumbnailUrl: ai.filePath,
      description: `Custom AI-generated image: "${ai.prompt.slice(0, 100)}..."`,
      originalAiImage: ai,
    });
  }

  for (const variant of stockVariants) {
    for (let i = 0; i < variant.videos.length; i++) {
      const video = variant.videos[i];
      if (seenUrls.has(video.url)) continue;
      seenUrls.add(video.url);

      const provider = video.source || "pexels";
      const providerLabel = provider === "freepik" ? "Freepik" : "Pexels";

      candidates.push({
        id: `stock_video_${provider}_${variant.query.slice(0, 10)}_${i}_${video.url.slice(-15)}`,
        type: "video",
        source: "stock",
        provider: provider as "pexels" | "freepik",
        query: variant.query,
        url: video.url,
        thumbnailUrl: video.thumbnailUrl,
        duration: video.duration,
        description: `${providerLabel} video about "${variant.query}" (${video.duration}s duration)`,
      });
    }

    for (let i = 0; i < variant.photos.length; i++) {
      const photo = variant.photos[i];
      if (seenUrls.has(photo.url)) continue;
      seenUrls.add(photo.url);

      const provider = photo.source || "pexels";
      const providerLabel = provider === "freepik" ? "Freepik" : "Pexels";

      candidates.push({
        id: `stock_photo_${provider}_${variant.query.slice(0, 10)}_${i}_${photo.url.slice(-15)}`,
        type: "image",
        source: "stock",
        provider: provider as "pexels" | "freepik",
        query: variant.query,
        url: photo.url,
        thumbnailUrl: photo.thumbnailUrl,
        description: `${providerLabel} photo about "${variant.query}"`,
      });
    }
  }

  return candidates;
}

async function selectMediaForAllWindowsWithAI(
  windows: BrollWindow[],
  allCandidates: MediaCandidate[],
  videoContext: EnhancedVideoContext,
  alreadyUsed: Set<string>
): Promise<SelectedMedia[]> {
  const gemini = getGeminiClient();

  const availableCandidates = allCandidates.filter(c => !alreadyUsed.has(c.id));

  const candidateDescriptions = availableCandidates.map((c, idx) => {
    let typeLabel: string;
    if (c.source === "ai") {
      typeLabel = "AI-IMAGE";
    } else if (c.type === "video") {
      typeLabel = c.provider === "freepik" ? "FREEPIK-VIDEO" : "PEXELS-VIDEO";
    } else {
      typeLabel = c.provider === "freepik" ? "FREEPIK-PHOTO" : "PEXELS-PHOTO";
    }
    const durationInfo = c.duration ? ` [${c.duration}s]` : "";

    // Include visual description if available (AI-analyzed content)
    const visualInfo = c.visualDescription
      ? `\n     VISUAL: ${c.visualDescription}`
      : "";

    return `  ${idx + 1}. [${typeLabel}] Query: "${c.query.slice(0, 50)}"${durationInfo}${visualInfo}`;
  }).join("\n");

  // Build window descriptions with motion/pacing hints
  const windowDescriptions = windows.map((w, idx) => {
    const duration = (w.end - w.start).toFixed(1);
    const preferVideo = shouldPreferVideo(w.start, w.end, videoContext.motionAnalysis);
    const optimalDuration = getOptimalBrollDuration(w.start, w.end, videoContext.pacingAnalysis);
    const motionHint = preferVideo ? " [MOTION: prefer VIDEO]" : "";
    const pacingHint = optimalDuration !== (w.end - w.start) ? ` [Optimal: ${optimalDuration.toFixed(1)}s]` : "";
    return `  ${idx}: ${w.start.toFixed(1)}s-${w.end.toFixed(1)}s (${duration}s) - "${w.suggestedQuery}" [${w.priority} priority]${motionHint}${pacingHint}${w.context ? ` Context: ${w.context}` : ''}`;
  }).join("\n");

  const aiImageCount = availableCandidates.filter(c => c.source === 'ai').length;
  const pexelsCount = availableCandidates.filter(c => c.provider === 'pexels').length;
  const freepikCount = availableCandidates.filter(c => c.provider === 'freepik').length;

  // Build motion context for AI prompt
  const motionContext = videoContext.motionAnalysis ? `
MOTION ANALYSIS:
- Overall Motion Intensity: ${videoContext.motionAnalysis.motionIntensity}
- Has Significant Motion: ${videoContext.motionAnalysis.hasSignificantMotion ? "YES" : "NO"}
${videoContext.motionAnalysis.actionSequences?.length ? `- Action Sequences: ${videoContext.motionAnalysis.actionSequences.length} detected` : ""}
MOTION GUIDANCE: For windows marked "[MOTION: prefer VIDEO]", prioritize stock VIDEOS over static images to match the dynamic content.` : "";

  // Build pacing context for AI prompt
  const pacingContext = videoContext.pacingAnalysis ? `
PACING ANALYSIS:
- Overall Pacing: ${videoContext.pacingAnalysis.overallPacing}
- Pacing Variation: ${videoContext.pacingAnalysis.pacingVariation}%
PACING GUIDANCE: ${videoContext.pacingAnalysis.overallPacing === "fast" ? "Prefer VIDEO over static images for fast-paced content" : videoContext.pacingAnalysis.overallPacing === "slow" ? "Images work well for slower, reflective pacing" : "Balance video and images for moderate pacing"}` : "";

  const prompt = `You are a professional video editor selecting B-roll media for a video.

VIDEO CONTEXT:
- Duration: ${videoContext.duration.toFixed(1)}s
- Genre: ${videoContext.genre || "general"}
- Tone: ${videoContext.tone || "professional"}
- Topic: ${videoContext.topic || "various"}
${motionContext}
${pacingContext}

B-ROLL WINDOWS (windowIndex: timing - content needed):
${windowDescriptions}

AVAILABLE MEDIA FROM MULTIPLE SOURCES (use the number to select):
${candidateDescriptions}

SELECTION CRITERIA (use VISUAL descriptions to make informed decisions):
1. WATERMARK CHECK - NEVER select any media whose VISUAL description contains "WATERMARKED". Watermarked content is unusable. Skip it entirely.
2. VISUAL MATCH - Read the VISUAL description carefully. Does what you SEE match what's needed?
3. CONTENT RELEVANCE - How well does the ACTUAL visual content match the B-roll window's context?
4. VISUAL QUALITY - Is it professional, well-lit, and suitable for the video's tone?
5. MEDIA TYPE - Consider whether video (motion) or a still image works better for each specific moment. Some moments benefit from motion, others from a striking still image. Use your editorial judgment.
6. TIMING FIT - For videos, does the duration match the window? For images, is it suitable for static display?
7. NARRATIVE FLOW - Does this media enhance the story based on what it ACTUALLY shows?

Choose the BEST asset for each window based purely on visual quality, content match, and editorial fit.
AI-generated images, stock videos, and stock photos are all equally valid — pick whichever genuinely fits best.
Judge each candidate on what it actually shows (read the VISUAL descriptions), not on its source.
CRITICAL: Do NOT select any asset flagged as WATERMARKED in its VISUAL description.

For windows >6 seconds, you may select 2-3 numbers that will be staggered.

RESPOND WITH JSON ONLY:
{
  "windowSelections": [
    {"windowIndex": 0, "selectedNumbers": [1], "reasoning": "explanation of why this specific asset was chosen over alternatives"},
    {"windowIndex": 1, "selectedNumbers": [5], "reasoning": "explanation of why this specific asset was chosen over alternatives"}
  ]
}`;

  const response = await withRetry(
    async () => {
      const result = await gemini.models.generateContent({
        model: AI_CONFIG.models.mediaSelection,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      });
      return result.text || "";
    },
    "media-selection-batch",
    AI_RETRY_OPTIONS
  );

  const selections: SelectedMedia[] = [];
  const usedInThisBatch = new Set<string>();

  try {
    // Robust JSON extraction with multiple fallback strategies
    let parsed: any = null;

    // Strategy 1: Find JSON block boundaries
    const jsonStart = response.indexOf('{');
    const jsonEnd = response.lastIndexOf('}');

    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
      throw new Error("No JSON object boundaries found in response");
    }

    let jsonText = response.slice(jsonStart, jsonEnd + 1);

    // Clean up common AI response issues
    jsonText = jsonText
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, "") // Remove control characters
      .replace(/\\n/g, " ") // Normalize escaped newlines
      .replace(/,\s*([\]}])/g, '$1') // Remove trailing commas
      .trim();

    try {
      parsed = JSON.parse(jsonText);
    } catch (firstParseError) {
      selectorLogger.debug("First JSON parse failed, trying recovery strategies");

      const arrayMatch = response.match(/"windowSelections"\s*:\s*\[([\s\S]*?)\]/);
      if (arrayMatch) {
        try {
          const arrayContent = `[${arrayMatch[1].replace(/,\s*$/, '')}]`;
          const selections = JSON.parse(arrayContent);
          parsed = { windowSelections: selections };
          selectorLogger.debug("Recovered JSON using array extraction strategy");
        } catch {
          selectorLogger.debug("Array extraction failed, trying object-by-object recovery");
        }
      }

      if (!parsed) {
        const objectPattern = /\{\s*"windowIndex"\s*:\s*(\d+)\s*,\s*"selectedNumbers"\s*:\s*\[([^\]]*)\]\s*(?:,\s*"reasoning"\s*:\s*"[^"]*")?\s*\}/g;
        const recoveredSelections: { windowIndex: number; selectedNumbers: number[]; reasoning: string }[] = [];
        let match: RegExpExecArray | null;
        while ((match = objectPattern.exec(response)) !== null) {
          try {
            const windowIndex = parseInt(match[1], 10);
            const numbers = match[2].split(',').map((n: string) => parseInt(n.trim(), 10)).filter((n: number) => !isNaN(n));
            if (!isNaN(windowIndex) && numbers.length > 0) {
              recoveredSelections.push({ windowIndex, selectedNumbers: numbers, reasoning: "Recovered from malformed JSON" });
            }
          } catch { continue; }
        }
        if (recoveredSelections.length > 0) {
          parsed = { windowSelections: recoveredSelections };
          selectorLogger.debug(`Recovered ${recoveredSelections.length} selections from malformed JSON`);
        }
      }

      if (!parsed) {
        const errorMsg = firstParseError instanceof Error ? firstParseError.message : String(firstParseError);
        throw new Error(`JSON parsing failed after all recovery attempts: ${errorMsg}`);
      }
    }

    if (!parsed) throw new Error("Failed to parse response as JSON");

    if (!parsed.windowSelections || !Array.isArray(parsed.windowSelections)) {
      throw new Error("Invalid response structure");
    }

    const candidateByIndex = new Map<number, MediaCandidate>();
    for (let i = 0; i < availableCandidates.length; i++) {
      candidateByIndex.set(i + 1, availableCandidates[i]);
    }

    for (const windowSelection of parsed.windowSelections) {
      const windowIndex = windowSelection.windowIndex;
      if (windowIndex < 0 || windowIndex >= windows.length) continue;

      const window = windows[windowIndex];
      const selectedNumbers: number[] = Array.isArray(windowSelection.selectedNumbers)
        ? windowSelection.selectedNumbers.map((n: unknown) => typeof n === 'number' ? n : parseInt(String(n), 10))
        : [typeof windowSelection.selectedNumbers === 'number' ? windowSelection.selectedNumbers : parseInt(String(windowSelection.selectedNumbers), 10)];

      const selectedMedia: MediaCandidate[] = [];

      for (const num of selectedNumbers) {
        if (isNaN(num)) continue;

        const candidate = candidateByIndex.get(num);

        if (!candidate) {
          selectorLogger.debug(`Could not find candidate for number: ${num}`);
          continue;
        }

        if (usedInThisBatch.has(candidate.id)) {
          selectorLogger.debug(`Skipping already-used media #${num}: ${candidate.id}`);
          continue;
        }

        selectedMedia.push(candidate);
        usedInThisBatch.add(candidate.id);
      }

      if (selectedMedia.length === 0) {
        selectorLogger.debug(`No valid media found for window ${windowIndex}, using fallback`);
        const unused = availableCandidates.filter(c => !usedInThisBatch.has(c.id));
        if (unused.length > 0) {
          const windowDuration = window.end - window.start;
          const fallback = fallbackSelectForWindow(window, unused, windowDuration);
          // Apply confidence threshold filtering
          const minScore = AI_CONFIG.confidence?.minMediaSelectionScore ?? 10;
          if (fallback && fallback.selectedMedia.length > 0 && (fallback.reasoning?.includes("high") || fallback.reasoning?.includes("medium") || !fallback.reasoning?.includes(`score: `))) {
            for (const m of fallback.selectedMedia) {
              selectedMedia.push(m);
              usedInThisBatch.add(m.id);
            }
          }
        }
      }

      if (selectedMedia.length > 0) {
        selections.push({
          windowIndex,
          window,
          selectedMedia,
          reasoning: windowSelection.reasoning || "AI selection",
          allowMultipleClips: selectedMedia.length > 1,
        });

        selectorLogger.debug(`Window ${windowIndex}: Selected ${selectedMedia.length} clips - ${selectedMedia.map(m => m.provider ? `${m.provider}:${m.type}` : `${m.source}:${m.type}`).join(", ")}`);
      }
    }

    for (let i = 0; i < windows.length; i++) {
      if (!selections.find(s => s.windowIndex === i)) {
        const window = windows[i];
        const windowDuration = window.end - window.start;
        const unused = availableCandidates.filter(c => !usedInThisBatch.has(c.id));

        if (unused.length > 0) {
          const fallback = fallbackSelectForWindow(window, unused, windowDuration);
          if (fallback && fallback.selectedMedia.length > 0) {
            for (const m of fallback.selectedMedia) {
              usedInThisBatch.add(m.id);
            }
            selections.push({ ...fallback, windowIndex: i });
            selectorLogger.debug(`Window ${i}: Filled with fallback selection`);
          }
        }
      }
    }

  } catch (parseError) {
    selectorLogger.warn(`Failed to parse AI batch selection:`, parseError);
    throw parseError;
  }

  // POST-SELECTION VALIDATION: Check if motion content has video (not enforcement, just logging)
  // We no longer force AI images - let the AI make smart decisions based on content type
  const aiCandidates = availableCandidates.filter(c => c.source === 'ai');
  const selectedAiCount = Array.from(usedInThisBatch).filter(id => id.startsWith('ai_')).length;

  // Count motion windows that got video vs AI
  let motionWindowsWithVideo = 0;
  let motionWindowsTotal = 0;

  for (const selection of selections) {
    const isMotionWindow = detectMotionContent(selection.window.suggestedQuery);
    if (isMotionWindow) {
      motionWindowsTotal++;
      if (selection.selectedMedia.some(m => m.type === 'video')) {
        motionWindowsWithVideo++;
      }
    }
  }

  if (motionWindowsTotal > 0) {
    selectorLogger.info(`Motion content coverage: ${motionWindowsWithVideo}/${motionWindowsTotal} motion windows have video B-roll`);

    if (motionWindowsWithVideo < motionWindowsTotal) {
      selectorLogger.debug(`Some motion windows got static images - this may be acceptable if no suitable video was available`);
    }
  }

  selectorLogger.info(`Media mix: ${selectedAiCount} AI images, ${selections.length - selectedAiCount} stock media selected`);

  return selections;
}

// Semantic similarity scoring using word overlap and synonyms
function computeSemanticScore(query: string, candidateText: string): number {
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const candidateWords = candidateText.toLowerCase().split(/\s+/).filter(w => w.length > 2);

  // Direct word matches
  let directMatches = 0;
  for (const qw of queryWords) {
    if (candidateWords.some(cw => cw === qw || cw.includes(qw) || qw.includes(cw))) {
      directMatches += 10;
    }
  }

  // Semantic category matching
  const categoryMap: Record<string, string[]> = {
    business: ["office", "corporate", "meeting", "businessman", "professional", "work", "entrepreneur", "startup", "company"],
    technology: ["computer", "laptop", "phone", "digital", "software", "code", "programming", "developer", "tech", "screen"],
    nature: ["outdoor", "landscape", "mountain", "forest", "beach", "ocean", "sunset", "sunrise", "sky", "tree", "water"],
    people: ["person", "man", "woman", "team", "group", "family", "crowd", "audience", "presenter", "speaker"],
    food: ["cooking", "kitchen", "chef", "restaurant", "eating", "meal", "recipe", "ingredient", "healthy", "dish"],
    fitness: ["exercise", "workout", "gym", "running", "athlete", "sport", "training", "health", "yoga", "stretching"],
    education: ["learning", "student", "teacher", "classroom", "school", "university", "study", "reading", "book", "lecture"],
    travel: ["journey", "trip", "vacation", "destination", "airport", "hotel", "adventure", "tourist", "explore", "city"],
    creative: ["art", "design", "creative", "artist", "painting", "drawing", "music", "photography", "film", "studio"],
    medical: ["health", "hospital", "doctor", "medical", "healthcare", "medicine", "wellness", "patient", "clinic", "nurse"],
  };

  let categoryScore = 0;
  for (const [category, keywords] of Object.entries(categoryMap)) {
    const queryHasCategory = queryWords.some(w => keywords.includes(w));
    const candidateHasCategory = candidateWords.some(w => keywords.includes(w));
    if (queryHasCategory && candidateHasCategory) {
      categoryScore += 8;
    }
  }

  return directMatches + categoryScore;
}

function fallbackSelectForWindow(
  window: BrollWindow,
  candidates: MediaCandidate[],
  windowDuration: number
): SelectedMedia | null {
  if (candidates.length === 0) return null;

  // Enhanced scoring with semantic matching AND visual analysis
  const scoredCandidates = candidates.map(c => {
    let score = 0;

    // Include visual description in candidate text for better matching
    const candidateText = (c.query + " " + (c.description || "") + " " + (c.visualDescription || "")).toLowerCase();

    // Semantic similarity score using query
    score += computeSemanticScore(window.suggestedQuery, candidateText);

    // Visual description bonus - reward candidates with visual analysis
    if (c.visualDescription) {
      // Extra points for having visual analysis
      score += 5;
      // Additional matching on visual description
      score += computeSemanticScore(window.suggestedQuery, c.visualDescription.toLowerCase()) * 0.8;
    }

    // Context matching (if available)
    if (window.context) {
      score += computeSemanticScore(window.context, candidateText) * 0.5;
    }

    // Priority bonus
    if (window.priority === "high") score += 3;
    else if (window.priority === "medium") score += 1;

    const isMotionQuery = detectMotionContent(window.suggestedQuery);

    if (isMotionQuery) {
      if (c.type === "video") score += 10;
      else score += 6;
    } else {
      if (c.type === "video") score += 7;
      else score += 8;
    }

    // Duration-appropriate media selection
    if (windowDuration > 4 && c.type === "video") score += 4;
    if (windowDuration <= 3 && c.type !== "video") score += 2;
    if (c.type === "video" && c.duration && c.duration >= windowDuration * 0.8) score += 3;

    return { candidate: c, score };
  }).sort((a, b) => b.score - a.score);

  const selectedMedia: MediaCandidate[] = [];
  const clipsNeeded = windowDuration > 6 ? Math.min(Math.floor(windowDuration / 3), 3) : 1;

  // Select top-scoring candidates without duplicates
  const usedTypes = new Set<string>();
  for (let i = 0; i < scoredCandidates.length && selectedMedia.length < clipsNeeded; i++) {
    const candidate = scoredCandidates[i].candidate;

    // For multiple clips, prefer variety in types
    if (selectedMedia.length > 0 && clipsNeeded > 1) {
      const typeKey = `${candidate.source}-${candidate.type}`;
      if (usedTypes.has(typeKey) && i < scoredCandidates.length - 1) {
        continue; // Skip to get more variety
      }
      usedTypes.add(typeKey);
    }

    selectedMedia.push(candidate);
  }

  // Fallback to first available if nothing selected
  if (selectedMedia.length === 0 && candidates.length > 0) {
    selectedMedia.push(candidates[0]);
  }

  const bestScore = scoredCandidates[0]?.score || 0;
  const highThreshold = AI_CONFIG.confidence?.highConfidenceScore ?? 20;
  const minThreshold = AI_CONFIG.confidence?.minMediaSelectionScore ?? 10;
  const confidence = bestScore > highThreshold ? "high" : bestScore > minThreshold ? "medium" : "low";

  // Filter out low-confidence selections if below minimum threshold
  if (bestScore < minThreshold && selectedMedia.length > 0) {
    selectorLogger.debug(`Skipping low-confidence selection (score ${bestScore} < threshold ${minThreshold})`);
    selectedMedia.length = 0; // Clear selections below threshold
  }

  return {
    windowIndex: 0,
    window,
    selectedMedia,
    reasoning: `Smart fallback selection (${confidence} confidence, score: ${bestScore})`,
    allowMultipleClips: selectedMedia.length > 1,
  };
}

function fallbackSelection(
  brollWindows: BrollWindow[],
  stockVariants: StockMediaVariants[],
  aiImages: GeneratedAiImage[]
): MediaSelectionResult {
  const allCandidates = buildAllCandidates(stockVariants, aiImages);
  const selections: SelectedMedia[] = [];
  const usedIds = new Set<string>();
  let aiImagesUsed = 0;
  let stockVideosUsed = 0;
  let stockImagesUsed = 0;

  for (let i = 0; i < brollWindows.length; i++) {
    const window = brollWindows[i];
    const windowDuration = window.end - window.start;
    const available = allCandidates.filter(c => !usedIds.has(c.id));

    const fallback = fallbackSelectForWindow(window, available, windowDuration);
    if (fallback && fallback.selectedMedia.length > 0) {
      selections.push({ ...fallback, windowIndex: i });

      for (const media of fallback.selectedMedia) {
        usedIds.add(media.id);
        if (media.source === "ai") aiImagesUsed++;
        else if (media.type === "video") stockVideosUsed++;
        else stockImagesUsed++;
      }
    }
  }

  return {
    selections,
    totalSelected: selections.reduce((sum, s) => sum + s.selectedMedia.length, 0),
    aiImagesUsed,
    stockVideosUsed,
    stockImagesUsed,
  };
}

export function convertSelectionsToStockMediaItems(
  selections: SelectedMedia[]
): { stockItems: StockMediaItem[]; aiImages: GeneratedAiImage[] } {
  const stockItems: StockMediaItem[] = [];
  const aiImages: GeneratedAiImage[] = [];

  for (const selection of selections) {
    const windowDuration = selection.window.end - selection.window.start;
    const clipCount = selection.selectedMedia.length;
    const clipDuration = windowDuration / clipCount;

    let currentOffset = 0;
    for (let i = 0; i < selection.selectedMedia.length; i++) {
      const media = selection.selectedMedia[i];
      const staggeredStart = selection.window.start + currentOffset;
      const staggeredEnd = Math.min(staggeredStart + clipDuration, selection.window.end);

      if (media.source === "ai" && media.originalAiImage) {
        const staggeredAiImage: GeneratedAiImage = {
          ...media.originalAiImage,
          startTime: staggeredStart,
          endTime: staggeredEnd,
          duration: staggeredEnd - staggeredStart,
          animationPreset: selection.window.animationPreset,
        };
        aiImages.push(staggeredAiImage);
      } else {
        const stockType = media.type === "video" ? "video" : "image";
        stockItems.push({
          type: stockType,
          query: media.query,
          url: media.url,
          thumbnailUrl: media.thumbnailUrl,
          duration: media.duration,
          startTime: staggeredStart,
          endTime: staggeredEnd,
          animationPreset: selection.window.animationPreset as "zoom_in" | "zoom_out" | "pan_left" | "pan_right" | "fade_only" | undefined,
        });
      }

      currentOffset += clipDuration;
    }
  }

  return { stockItems, aiImages };
}
