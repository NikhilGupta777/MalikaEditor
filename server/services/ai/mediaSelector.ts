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
  const usedMediaIds = new Set<string>();

  const allCandidates = buildAllCandidates(stockVariants, aiImages);
  
  selectorLogger.info(`Built ${allCandidates.length} total media candidates (${allCandidates.filter(c => c.source === 'ai').length} AI, ${allCandidates.filter(c => c.type === 'video').length} videos, ${allCandidates.filter(c => c.source === 'stock' && c.type === 'image').length} photos)`);

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
  
  selectorLogger.info(`Media selection complete: ${totalSelected} clips selected (${aiImagesUsed} AI, ${stockVideosUsed} stock videos, ${stockImagesUsed} stock images)`);

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
      description: `Custom AI-generated image: "${ai.prompt.slice(0, 100)}..."`,
      originalAiImage: ai,
    });
  }
  
  for (const variant of stockVariants) {
    for (let i = 0; i < variant.videos.length; i++) {
      const video = variant.videos[i];
      if (seenUrls.has(video.url)) continue;
      seenUrls.add(video.url);
      
      candidates.push({
        id: `stock_video_${variant.query.slice(0, 10)}_${i}_${video.url.slice(-15)}`,
        type: "video",
        source: "stock",
        query: variant.query,
        url: video.url,
        thumbnailUrl: video.thumbnailUrl,
        duration: video.duration,
        description: `Stock video about "${variant.query}" (${video.duration}s duration)`,
      });
    }
    
    for (let i = 0; i < variant.photos.length; i++) {
      const photo = variant.photos[i];
      if (seenUrls.has(photo.url)) continue;
      seenUrls.add(photo.url);
      
      candidates.push({
        id: `stock_photo_${variant.query.slice(0, 10)}_${i}_${photo.url.slice(-15)}`,
        type: "image",
        source: "stock",
        query: variant.query,
        url: photo.url,
        thumbnailUrl: photo.thumbnailUrl,
        description: `Stock photo about "${variant.query}"`,
      });
    }
  }
  
  return candidates;
}

async function selectMediaForAllWindowsWithAI(
  windows: BrollWindow[],
  allCandidates: MediaCandidate[],
  videoContext: { duration: number; genre?: string; tone?: string; topic?: string },
  alreadyUsed: Set<string>
): Promise<SelectedMedia[]> {
  const gemini = getGeminiClient();
  
  const availableCandidates = allCandidates.filter(c => !alreadyUsed.has(c.id));
  
  const candidateDescriptions = availableCandidates.map((c, idx) => {
    const typeLabel = c.source === "ai" ? "AI-IMAGE" : 
                      c.type === "video" ? "VIDEO" : "PHOTO";
    const durationInfo = c.duration ? ` [${c.duration}s]` : "";
    return `  ${idx + 1}. [${typeLabel}] ${c.description}${durationInfo}`;
  }).join("\n");

  const windowDescriptions = windows.map((w, idx) => {
    const duration = (w.end - w.start).toFixed(1);
    return `  ${idx}: ${w.start.toFixed(1)}s-${w.end.toFixed(1)}s (${duration}s) - "${w.suggestedQuery}" [${w.priority} priority]${w.context ? ` Context: ${w.context}` : ''}`;
  }).join("\n");

  const prompt = `You are a professional video editor selecting B-roll media for a video.

VIDEO CONTEXT:
- Duration: ${videoContext.duration.toFixed(1)}s
- Genre: ${videoContext.genre || "general"}
- Tone: ${videoContext.tone || "professional"}
- Topic: ${videoContext.topic || "various"}

B-ROLL WINDOWS (windowIndex: timing - content needed):
${windowDescriptions}

AVAILABLE MEDIA (use the number to select):
${candidateDescriptions}

SELECTION TASK:
For each window, pick the BEST media based on:
1. CONTENT MATCH - does the media represent what's being discussed?
2. DURATION FIT - videos for longer windows (>3s), images for shorter
3. VISUAL VARIETY - use DIFFERENT media for each window, never repeat the same number
4. VIEWER EXPERIENCE - what looks best and enhances understanding?

MEDIA TYPES EXPLAINED:
- AI-IMAGE: Custom-generated to match this video's exact content - excellent for specific concepts
- VIDEO: Stock footage with motion - great for dynamic content and longer segments
- PHOTO: Stock images - good for static concepts and quick visual references

Choose based on MEANING and QUALITY, not just type. Each window should have different media.

For windows >6 seconds, you may select 2-3 numbers that will be staggered.

RESPOND WITH JSON ONLY:
{
  "windowSelections": [
    {"windowIndex": 0, "selectedNumbers": [1], "reasoning": "explanation"},
    {"windowIndex": 1, "selectedNumbers": [5], "reasoning": "explanation"}
  ]
}`;

  const response = await withRetry(
    async () => {
      const result = await gemini.models.generateContent({
        model: "gemini-2.5-flash",
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
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in response");
    
    const parsed = JSON.parse(jsonMatch[0]);
    
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
          if (fallback && fallback.selectedMedia.length > 0) {
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
        
        selectorLogger.debug(`Window ${windowIndex}: Selected ${selectedMedia.length} clips - ${selectedMedia.map(m => `${m.source}:${m.type}`).join(", ")}`);
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

  return selections;
}

function fallbackSelectForWindow(
  window: BrollWindow,
  candidates: MediaCandidate[],
  windowDuration: number
): SelectedMedia | null {
  if (candidates.length === 0) return null;
  
  const queryWords = window.suggestedQuery.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  
  const scoredCandidates = candidates.map(c => {
    let score = 0;
    
    const candidateText = (c.query + " " + (c.description || "")).toLowerCase();
    for (const word of queryWords) {
      if (candidateText.includes(word)) score += 10;
    }
    
    if (c.source === "ai") score += 5;
    
    if (windowDuration > 3 && c.type === "video") score += 3;
    if (windowDuration <= 3 && c.type !== "video") score += 2;
    
    return { candidate: c, score };
  }).sort((a, b) => b.score - a.score);
  
  const selectedMedia: MediaCandidate[] = [];
  const clipsNeeded = windowDuration > 6 ? Math.min(Math.floor(windowDuration / 3), 3) : 1;
  
  for (let i = 0; i < Math.min(clipsNeeded, scoredCandidates.length); i++) {
    selectedMedia.push(scoredCandidates[i].candidate);
  }

  if (selectedMedia.length === 0 && candidates.length > 0) {
    selectedMedia.push(candidates[0]);
  }

  return {
    windowIndex: 0,
    window,
    selectedMedia,
    reasoning: "Fallback selection based on content matching",
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
