import { getGeminiClient } from "./clients";
import { createLogger } from "../../utils/logger";
import { withRetry, AI_RETRY_OPTIONS } from "../../utils/retry";
import type { StockMediaItem } from "@shared/schema";
import type { StockMediaVariants } from "../pexelsService";
import type { GeneratedAiImage } from "./imageGeneration";

const selectorLogger = createLogger("media-selector");

interface BrollWindow {
  start: number;
  end: number;
  suggestedQuery: string;
  priority: "high" | "medium" | "low";
  context?: string;
}

export interface MediaCandidate {
  id: string;
  type: "image" | "video" | "ai_generated";
  source: "stock" | "ai";
  query: string;
  url: string;
  thumbnailUrl?: string;
  duration?: number;
  description?: string;
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

export async function selectBestMediaForWindows(
  brollWindows: BrollWindow[],
  stockVariants: StockMediaVariants[],
  aiImages: GeneratedAiImage[],
  videoContext: {
    duration: number;
    genre?: string;
    tone?: string;
    topic?: string;
  }
): Promise<MediaSelectionResult> {
  let geminiAvailable = true;
  try {
    getGeminiClient();
  } catch {
    geminiAvailable = false;
    selectorLogger.warn("Gemini not available, using fallback selection");
  }
  
  if (!geminiAvailable) {
    return fallbackSelection(brollWindows, stockVariants, aiImages);
  }

  const selections: SelectedMedia[] = [];
  let aiImagesUsed = 0;
  let stockVideosUsed = 0;
  let stockImagesUsed = 0;

  for (let i = 0; i < brollWindows.length; i++) {
    const window = brollWindows[i];
    const windowDuration = window.end - window.start;
    
    const candidates = buildCandidatesForWindow(window, stockVariants, aiImages);
    
    if (candidates.length === 0) {
      selectorLogger.debug(`No candidates for window ${i} (${window.suggestedQuery})`);
      continue;
    }

    try {
      const selection = await selectBestMediaWithAI(
        window,
        candidates,
        windowDuration,
        videoContext,
        i
      );
      
      if (selection.selectedMedia.length > 0) {
        selections.push(selection);
        
        for (const media of selection.selectedMedia) {
          if (media.source === "ai") aiImagesUsed++;
          else if (media.type === "video") stockVideosUsed++;
          else stockImagesUsed++;
        }
      }
    } catch (error) {
      selectorLogger.error(`AI selection failed for window ${i}:`, error);
      const fallback = fallbackSelectForWindow(window, candidates, windowDuration);
      if (fallback) {
        selections.push({ ...fallback, windowIndex: i });
        for (const media of fallback.selectedMedia) {
          if (media.source === "ai") aiImagesUsed++;
          else if (media.type === "video") stockVideosUsed++;
          else stockImagesUsed++;
        }
      }
    }
  }

  const totalSelected = selections.reduce((sum, s) => sum + s.selectedMedia.length, 0);
  
  selectorLogger.info(`Media selection complete: ${totalSelected} clips selected (${aiImagesUsed} AI, ${stockVideosUsed} stock videos, ${stockImagesUsed} stock images)`);

  return {
    selections,
    totalSelected,
    aiImagesUsed,
    stockVideosUsed,
    stockImagesUsed,
  };
}

function buildCandidatesForWindow(
  window: BrollWindow,
  stockVariants: StockMediaVariants[],
  aiImages: GeneratedAiImage[]
): MediaCandidate[] {
  const candidates: MediaCandidate[] = [];
  
  const matchingAiImages = aiImages.filter(ai => {
    const aiStart = ai.startTime ?? 0;
    const aiEnd = ai.endTime ?? aiStart + 4;
    return (
      (aiStart >= window.start - 2 && aiStart <= window.end + 2) ||
      (window.start >= aiStart - 2 && window.start <= aiEnd + 2)
    );
  });
  
  for (const ai of matchingAiImages) {
    candidates.push({
      id: `ai_${ai.prompt.slice(0, 20).replace(/\s/g, '_')}`,
      type: "ai_generated",
      source: "ai",
      query: ai.prompt,
      url: `ai_image_${ai.startTime}`,
      description: `AI-generated image for: ${ai.prompt}`,
      originalAiImage: ai,
    });
  }
  
  const queryLower = window.suggestedQuery.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);
  
  for (const variant of stockVariants) {
    const variantQueryLower = variant.query.toLowerCase();
    const isExactMatch = variantQueryLower === queryLower;
    const isPartialMatch = queryWords.some(word => variantQueryLower.includes(word));
    
    if (!isExactMatch && !isPartialMatch) continue;
    
    for (const video of variant.videos) {
      candidates.push({
        id: `stock_video_${video.url.slice(-30)}`,
        type: "video",
        source: "stock",
        query: variant.query,
        url: video.url,
        thumbnailUrl: video.thumbnailUrl,
        duration: video.duration,
        description: `Stock video: ${variant.query} (${video.duration}s)`,
      });
    }
    
    for (const photo of variant.photos) {
      candidates.push({
        id: `stock_photo_${photo.url.slice(-30)}`,
        type: "image",
        source: "stock",
        query: variant.query,
        url: photo.url,
        thumbnailUrl: photo.thumbnailUrl,
        description: `Stock photo: ${variant.query}`,
      });
    }
  }
  
  return candidates;
}

async function selectBestMediaWithAI(
  window: BrollWindow,
  candidates: MediaCandidate[],
  windowDuration: number,
  videoContext: { duration: number; genre?: string; tone?: string; topic?: string },
  windowIndex: number
): Promise<SelectedMedia> {
  const gemini = getGeminiClient();
  
  const candidateDescriptions = candidates.map((c, idx) => {
    const typeLabel = c.source === "ai" ? "AI-GENERATED IMAGE" : 
                      c.type === "video" ? "STOCK VIDEO" : "STOCK IMAGE";
    const durationInfo = c.duration ? ` (duration: ${c.duration}s)` : "";
    return `${idx + 1}. [${typeLabel}] Query: "${c.query}"${durationInfo}`;
  }).join("\n");

  const prompt = `You are an expert video editor selecting B-roll media for a professional edit.

VIDEO CONTEXT:
- Total duration: ${videoContext.duration.toFixed(1)}s
- Genre: ${videoContext.genre || "general"}
- Tone: ${videoContext.tone || "professional"}
- Topic: ${videoContext.topic || "various"}

B-ROLL WINDOW ${windowIndex + 1}:
- Time: ${window.start.toFixed(1)}s - ${window.end.toFixed(1)}s (${windowDuration.toFixed(1)}s duration)
- Suggested content: "${window.suggestedQuery}"
- Priority: ${window.priority}
- Context: ${window.context || "visual enhancement"}

AVAILABLE MEDIA CANDIDATES:
${candidateDescriptions}

SELECTION RULES:
1. PRIORITIZE AI-GENERATED IMAGES over stock images when content matches - AI images are custom-made for this video
2. PREFER STOCK VIDEOS over stock images for dynamic content or segments longer than 3 seconds
3. For SHORT segments (<3s): prefer images or very short videos
4. For LONGER segments (>5s): prefer videos for better engagement
5. You CAN select MULTIPLE clips if the segment is dense with changing topics or needs visual variety
6. Consider the QUERY MATCH - how well does the media match what's needed?

MULTI-CLIP GUIDANCE:
- If segment is >6s and has multiple sub-topics, select 2-3 clips
- If content changes rapidly, multiple short clips work better
- Don't over-populate: 1 clip per 3-4 seconds is usually good

Respond in JSON format ONLY:
{
  "selectedIndices": [1],
  "reasoning": "Brief explanation of why these were chosen",
  "allowMultipleClips": false
}`;

  const response = await withRetry(
    async () => {
      const result = await gemini.models.generateContent({
        model: "gemini-1.5-flash",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      });
      return result.text || "";
    },
    "media-selection",
    AI_RETRY_OPTIONS
  );

  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in response");
    
    const parsed = JSON.parse(jsonMatch[0]);
    const selectedIndices: number[] = Array.isArray(parsed.selectedIndices) 
      ? parsed.selectedIndices.map((i: number) => i - 1)
      : [0];
    
    let selectedMedia = selectedIndices
      .filter((idx: number) => idx >= 0 && idx < candidates.length)
      .map((idx: number) => candidates[idx]);
    
    if (selectedMedia.length === 0 && candidates.length > 0) {
      selectedMedia.push(candidates[0]);
    }

    selectedMedia = enforcePriorityRules(selectedMedia, candidates, windowDuration);

    return {
      windowIndex,
      window,
      selectedMedia,
      reasoning: parsed.reasoning || "AI selection",
      allowMultipleClips: parsed.allowMultipleClips || selectedMedia.length > 1,
    };
  } catch (parseError) {
    selectorLogger.warn(`Failed to parse AI selection response, using fallback`);
    return fallbackSelectForWindow(window, candidates, windowDuration) || {
      windowIndex,
      window,
      selectedMedia: candidates.slice(0, 1),
      reasoning: "Fallback selection",
      allowMultipleClips: false,
    };
  }
}

function enforcePriorityRules(
  selected: MediaCandidate[],
  allCandidates: MediaCandidate[],
  windowDuration: number
): MediaCandidate[] {
  const targetClipCount = selected.length;
  if (targetClipCount === 0) return selected;
  
  const aiCandidates = allCandidates.filter(c => c.source === "ai");
  const stockVideos = allCandidates.filter(c => c.source === "stock" && c.type === "video");
  const stockImages = allCandidates.filter(c => c.source === "stock" && c.type === "image");
  
  const rankedPool = [...aiCandidates, ...stockVideos, ...stockImages];
  
  const enforced: MediaCandidate[] = [];
  const usedIds = new Set<string>();
  
  for (const candidate of rankedPool) {
    if (enforced.length >= targetClipCount) break;
    if (!usedIds.has(candidate.id)) {
      enforced.push(candidate);
      usedIds.add(candidate.id);
    }
  }
  
  if (enforced.length < targetClipCount) {
    for (const orig of selected) {
      if (enforced.length >= targetClipCount) break;
      if (!usedIds.has(orig.id)) {
        enforced.push(orig);
        usedIds.add(orig.id);
      }
    }
  }
  
  const originalTypes = selected.map(s => `${s.source}:${s.type}`).sort().join(",");
  const enforcedTypes = enforced.map(s => `${s.source}:${s.type}`).sort().join(",");
  if (originalTypes !== enforcedTypes) {
    selectorLogger.debug(`Priority enforcement: Changed selection from [${originalTypes}] to [${enforcedTypes}]`);
  }
  
  return enforced;
}

function fallbackSelectForWindow(
  window: BrollWindow,
  candidates: MediaCandidate[],
  windowDuration: number
): SelectedMedia | null {
  if (candidates.length === 0) return null;
  
  const aiCandidates = candidates.filter(c => c.source === "ai");
  const stockVideos = candidates.filter(c => c.source === "stock" && c.type === "video");
  const stockImages = candidates.filter(c => c.source === "stock" && c.type === "image");
  
  const selectedMedia: MediaCandidate[] = [];
  let reasoning = "";
  
  const clipsNeeded = windowDuration > 6 ? Math.min(Math.floor(windowDuration / 3), 3) : 1;
  
  if (aiCandidates.length > 0) {
    selectedMedia.push(aiCandidates[0]);
    reasoning = "AI-generated image prioritized";
  }
  
  while (selectedMedia.length < clipsNeeded && stockVideos.length > selectedMedia.filter(s => s.type === "video").length) {
    const nextVideo = stockVideos.find(v => !selectedMedia.includes(v));
    if (nextVideo) {
      selectedMedia.push(nextVideo);
      reasoning = reasoning || "Stock video(s) selected";
    } else {
      break;
    }
  }
  
  while (selectedMedia.length < clipsNeeded && stockImages.length > selectedMedia.filter(s => s.source === "stock" && s.type === "image").length) {
    const nextImage = stockImages.find(i => !selectedMedia.includes(i));
    if (nextImage) {
      selectedMedia.push(nextImage);
      reasoning = reasoning || "Stock image(s) selected";
    } else {
      break;
    }
  }
  
  if (selectedMedia.length === 0) {
    selectedMedia.push(candidates[0]);
    reasoning = "Default selection";
  }
  
  return {
    windowIndex: 0,
    window,
    selectedMedia,
    reasoning: reasoning || "Fallback selection",
    allowMultipleClips: selectedMedia.length > 1,
  };
}

function fallbackSelection(
  brollWindows: BrollWindow[],
  stockVariants: StockMediaVariants[],
  aiImages: GeneratedAiImage[]
): MediaSelectionResult {
  const selections: SelectedMedia[] = [];
  let aiImagesUsed = 0;
  let stockVideosUsed = 0;
  let stockImagesUsed = 0;

  for (let i = 0; i < brollWindows.length; i++) {
    const window = brollWindows[i];
    const windowDuration = window.end - window.start;
    const candidates = buildCandidatesForWindow(window, stockVariants, aiImages);
    
    const selection = fallbackSelectForWindow(window, candidates, windowDuration);
    if (selection) {
      selection.windowIndex = i;
      selections.push(selection);
      
      const media = selection.selectedMedia[0];
      if (media?.source === "ai") aiImagesUsed++;
      else if (media?.type === "video") stockVideosUsed++;
      else stockImagesUsed++;
    }
  }

  return {
    selections,
    totalSelected: selections.length,
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
    const clipDuration = clipCount > 1 ? Math.min(windowDuration / clipCount, 4) : windowDuration;
    
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
        };
        aiImages.push(staggeredAiImage);
      } else {
        stockItems.push({
          type: media.type as "image" | "video",
          query: media.query,
          url: media.url,
          thumbnailUrl: media.thumbnailUrl,
          duration: media.duration,
          startTime: staggeredStart,
          endTime: staggeredEnd,
        });
      }
      
      currentOffset += clipDuration;
    }
  }
  
  return { stockItems, aiImages };
}
