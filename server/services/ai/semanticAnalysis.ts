import { withRetry, AI_RETRY_OPTIONS } from "../../utils/retry";
import { createLogger } from "../../utils/logger";
import { getGeminiClient } from "./clients";
import type {
  TranscriptSegment,
  VideoContext,
  SemanticAnalysis,
} from "@shared/schema";

const aiLogger = createLogger("ai-service");

interface RawBrollWindow {
  start?: number;
  end?: number;
  context?: string;
  suggestedQuery?: string;
  priority?: "low" | "medium" | "high";
  reason?: string;
}

interface RawKeyMoment {
  timestamp?: number;
  description?: string;
  importance?: "low" | "medium" | "high";
}

export function detectTranscriptLanguage(transcript: TranscriptSegment[]): string {
  if (!transcript || transcript.length === 0) return "en";
  
  const allText = transcript.map(t => t.text).join(" ");
  
  const devanagariPattern = /[\u0900-\u097F]/;
  if (devanagariPattern.test(allText)) {
    aiLogger.debug("Detected language: Hindi (Devanagari script)");
    return "hi";
  }
  
  const arabicPattern = /[\u0600-\u06FF]/;
  if (arabicPattern.test(allText)) {
    aiLogger.debug("Detected language: Arabic");
    return "ar";
  }
  
  const chinesePattern = /[\u4E00-\u9FFF]/;
  if (chinesePattern.test(allText)) {
    aiLogger.debug("Detected language: Chinese");
    return "zh";
  }
  
  const japanesePattern = /[\u3040-\u30FF]/;
  if (japanesePattern.test(allText)) {
    aiLogger.debug("Detected language: Japanese");
    return "ja";
  }
  
  const koreanPattern = /[\uAC00-\uD7AF]/;
  if (koreanPattern.test(allText)) {
    aiLogger.debug("Detected language: Korean");
    return "ko";
  }
  
  const cyrillicPattern = /[\u0400-\u04FF]/;
  if (cyrillicPattern.test(allText)) {
    aiLogger.debug("Detected language: Russian/Cyrillic");
    return "ru";
  }
  
  aiLogger.debug("Detected language: English (default)");
  return "en";
}

export async function translateTranscriptToEnglish(
  transcript: TranscriptSegment[],
  sourceLanguage: string
): Promise<TranscriptSegment[]> {
  if (!transcript || transcript.length === 0) return [];
  if (sourceLanguage === "en") return transcript;
  
  const languageNames: Record<string, string> = {
    hi: "Hindi",
    ar: "Arabic",
    zh: "Chinese",
    ja: "Japanese",
    ko: "Korean",
    ru: "Russian",
    es: "Spanish",
    fr: "French",
    de: "German",
    pt: "Portuguese",
  };
  
  const langName = languageNames[sourceLanguage] || sourceLanguage;
  aiLogger.info(`Translating transcript from ${langName} to English for semantic analysis...`);
  
  const textsToTranslate = transcript.map((seg, i) => `[${i}]: ${seg.text}`).join("\n");
  
  const prompt = `Translate the following ${langName} transcript segments to English.
Each line starts with [index]: followed by the text to translate.
Return ONLY a JSON array where each element is the translated text for that index.

Input:
${textsToTranslate}

Output format (JSON array only, no markdown):
["translated text for segment 0", "translated text for segment 1", ...]

Important:
- Maintain the meaning and context of the original
- Keep it natural English
- Do NOT include the index numbers in the output
- Return exactly ${transcript.length} translated strings`;

  try {
    const response = await withRetry(
      () => getGeminiClient().models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      }),
      "translateTranscript",
      AI_RETRY_OPTIONS
    );
    
    const responseText = response.text || "";
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    
    if (!jsonMatch) {
      aiLogger.warn("Failed to parse translation response, using original text");
      return transcript;
    }
    
    const translations = JSON.parse(jsonMatch[0]);
    
    if (!Array.isArray(translations) || translations.length !== transcript.length) {
      aiLogger.warn(`Translation count mismatch: got ${translations.length}, expected ${transcript.length}`);
      return transcript;
    }
    
    const translatedSegments: TranscriptSegment[] = transcript.map((seg, i) => ({
      start: seg.start,
      end: seg.end,
      text: translations[i] || seg.text,
    }));
    
    aiLogger.info(`Translation complete: ${translatedSegments.length} segments translated to English`);
    return translatedSegments;
  } catch (error) {
    aiLogger.error("Translation failed:", error);
    return transcript;
  }
}

const FILLER_WORDS = [
  "um", "uh", "erm", "er", "ah", "uhh", "umm",
  "like", "you know", "so", "basically", "actually", "literally",
  "i mean", "you see", "right", "okay", "well", "just",
  "kind of", "sort of", "you know what i mean", "at the end of the day"
];

export function detectFillerWords(
  transcript: TranscriptSegment[]
): { start: number; end: number; word: string }[] {
  const fillerSegments: { start: number; end: number; word: string }[] = [];
  
  for (const segment of transcript) {
    const text = segment.text.toLowerCase();
    const segmentDuration = segment.end - segment.start;
    const words = text.split(/\s+/);
    const wordsPerSecond = words.length / Math.max(segmentDuration, 0.1);
    
    for (const filler of FILLER_WORDS) {
      const fillerLower = filler.toLowerCase();
      
      if (filler.includes(" ")) {
        if (text.includes(fillerLower)) {
          const index = text.indexOf(fillerLower);
          const position = index / text.length;
          const estimatedStart = segment.start + (position * segmentDuration);
          const fillerWordCount = filler.split(" ").length;
          const estimatedDuration = fillerWordCount / wordsPerSecond;
          
          fillerSegments.push({
            start: estimatedStart,
            end: estimatedStart + estimatedDuration,
            word: filler,
          });
        }
      } else {
        for (let i = 0; i < words.length; i++) {
          const word = words[i].replace(/[^a-z]/g, "");
          if (word === fillerLower) {
            const wordPosition = i / words.length;
            const estimatedStart = segment.start + (wordPosition * segmentDuration);
            const estimatedDuration = 1 / wordsPerSecond;
            
            fillerSegments.push({
              start: estimatedStart,
              end: estimatedStart + estimatedDuration,
              word: filler,
            });
          }
        }
      }
    }
  }
  
  fillerSegments.sort((a, b) => a.start - b.start);
  
  aiLogger.debug(`Detected ${fillerSegments.length} filler word instances`);
  return fillerSegments;
}

export async function analyzeTranscriptSemantics(
  transcript: TranscriptSegment[],
  videoContext?: VideoContext,
  videoDuration?: number
): Promise<SemanticAnalysis> {
  if (!transcript || transcript.length === 0) {
    return {
      mainTopics: [],
      overallTone: "casual",
      keyMoments: [],
      brollWindows: [],
      extractedKeywords: [],
      contentSummary: "No transcript available for analysis",
    };
  }

  const fullTranscript = transcript.map(t => `[${t.start.toFixed(1)}s-${t.end.toFixed(1)}s]: ${t.text}`).join("\n");
  const duration = videoDuration || (transcript[transcript.length - 1]?.end || 60);

  const prompt = `You are an expert content analyst for a professional AI video editing system like Opus Clip or Submagic.
Your task is to perform DEEP SEMANTIC ANALYSIS of this video transcript to enable CONTEXT-AWARE B-roll placement.

VIDEO CONTEXT:
- Genre: ${videoContext?.genre || "general"}
- Tone: ${videoContext?.tone || "casual"}
- Pacing: ${videoContext?.pacing || "moderate"}
- Duration: ${duration.toFixed(1)} seconds

TRANSCRIPT:
${fullTranscript}

PERFORM COMPREHENSIVE DEEP ANALYSIS:

1. **MAIN TOPICS** - What are the core subjects discussed? List 3-7 main topics.

2. **OVERALL TONE** - Classify: educational, entertaining, inspirational, professional, casual, or serious

3. **KEY MOMENTS** - Identify 3-8 peak engagement moments where:
   - Important points are made
   - Emotional emphasis occurs
   - Key information is delivered

4. **HOOK ANALYSIS** (NEW - CRITICAL)
Analyze the first 3-10 seconds of content. Score the hook strength (0-100):
- Does it grab attention immediately? (strong opening statement, question, or visual)
- Is there a promise or question that creates curiosity?
- Does it make viewers want to keep watching?
Identify specific hook moments with timestamps, scores, and reasons.

5. **STRUCTURE ANALYSIS** (NEW)
Detect the video structure:
- introEnd: timestamp where introduction ends and main content begins
- mainStart: when the core content starts
- mainEnd: when the core content wraps up
- outroStart: when outro/conclusion begins (if any)

6. **TOPIC FLOW** (NEW)
Create a timeline of topics discussed throughout the video:
- Each topic should have a unique ID (topic_1, topic_2, etc.)
- Name of the topic/subject
- Start and end timestamps

7. **B-ROLL WINDOWS** - CRITICAL: Identify specific moments where visual support would ENHANCE the content:
   - When speaker discusses abstract concepts
   - When examples/illustrations are mentioned
   - During transitions between topics
   - When specific objects/places/actions are referenced
   
   For each B-roll window, provide:
   - Exact start/end timestamps (must align with transcript segments)
   - Context (what's being discussed)
   - ULTRA-SPECIFIC search query (not "nature" but "peaceful sunrise over mountain lake with morning mist")
   - Priority (high = essential visual support, medium = enhances understanding, low = optional decoration)
   - Reason why B-roll helps here

8. **EXTRACTED KEYWORDS** - List 10-20 important keywords/phrases from the content

9. **CONTENT SUMMARY** - 2-3 sentence summary of the video content

CRITICAL ULTRA-SPECIFIC B-ROLL QUERY GUIDELINES:
- Queries must describe EXACTLY what would visually represent the speaker's words
- BAD: "nature" or "business" or "technology"
- GOOD: "peaceful meditation mindfulness calm person meditating in serene garden"
- GOOD: "modern office workers collaborating around glass table in bright startup space"
- GOOD: "golden sunrise over misty mountain lake with pine trees reflecting in water"
- Match the visual exactly to the SPOKEN CONTENT, not generic concepts

B-ROLL TIMING RULES:
- Duration: 3-5 seconds per B-roll (optimal for visual impact)
- Spacing: minimum 3-5 seconds between B-roll clips
- Never place B-roll during important visual moments or climactic points
- Place B-roll at the START of concepts, not during key revelations
- DISTRIBUTE B-ROLL EVENLY across the ENTIRE video timeline
- For a ${duration.toFixed(0)}s video, create ${Math.min(15, Math.max(6, Math.ceil(duration / 6)))} B-roll windows
- Ensure B-roll windows cover ALL parts of the video, not just the beginning
- Each third of the video (0-33%, 34-66%, 67-100%) should have at least 2 B-roll windows

Respond in JSON format only (no markdown):
{
  "mainTopics": ["topic1", "topic2", ...],
  "overallTone": "educational|entertaining|inspirational|professional|casual|serious",
  "keyMoments": [
    {"timestamp": number, "description": "string", "importance": "low|medium|high"}
  ],
  "hookMoments": [
    {"timestamp": number, "score": number (0-100), "reason": "why this is/isn't a strong hook"}
  ],
  "structureAnalysis": {
    "introEnd": number or null,
    "mainStart": number or null,
    "mainEnd": number or null,
    "outroStart": number or null
  },
  "topicFlow": [
    {"id": "topic_1", "name": "topic name", "start": number, "end": number}
  ],
  "brollWindows": [
    {
      "start": number,
      "end": number,
      "context": "what is being discussed",
      "suggestedQuery": "ULTRA-SPECIFIC contextual search query (e.g., 'professional businessman walking through modern glass office with city skyline visible')",
      "priority": "low|medium|high",
      "reason": "why B-roll enhances this moment"
    }
  ],
  "extractedKeywords": ["keyword1", "keyword2", ...],
  "contentSummary": "2-3 sentence summary"
}`;

  try {
    const response = await withRetry(
      () => getGeminiClient().models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      }),
      "analyzeTranscriptSemantics",
      AI_RETRY_OPTIONS
    );

    const text = response.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) {
      aiLogger.warn("Failed to parse semantic analysis response");
      return getDefaultSemanticAnalysis(transcript, duration);
    }

    interface ParsedSemanticResponse {
      brollWindows?: RawBrollWindow[];
      mainTopics?: string[];
      overallTone?: "educational" | "entertaining" | "inspirational" | "professional" | "casual" | "serious";
      keyMoments?: RawKeyMoment[];
      extractedKeywords?: string[];
      contentSummary?: string;
      hookMoments?: { timestamp?: number; score?: number; reason?: string }[];
      structureAnalysis?: {
        introEnd?: number | null;
        mainStart?: number | null;
        mainEnd?: number | null;
        outroStart?: number | null;
      };
      topicFlow?: { id?: string; name?: string; start?: number; end?: number }[];
    }
    
    const parsed = JSON.parse(jsonMatch[0]) as ParsedSemanticResponse;
    
    const validatedBrollWindows = (parsed.brollWindows || [])
      .filter((b: RawBrollWindow) => b.start !== undefined && b.suggestedQuery)
      .map((b: RawBrollWindow) => ({
        start: Math.max(0, b.start || 0),
        end: Math.min(duration, b.end || (b.start || 0) + 4),
        context: b.context || "",
        suggestedQuery: b.suggestedQuery || "",
        priority: b.priority || "medium",
        reason: b.reason || "Enhance visual interest",
      }))
      .slice(0, 15);

    const hookMoments = parsed.hookMoments?.map(h => ({
      timestamp: h.timestamp || 0,
      score: Math.min(100, Math.max(0, h.score || 0)),
      reason: h.reason || "",
    }));

    const structureAnalysis = parsed.structureAnalysis ? {
      introEnd: parsed.structureAnalysis.introEnd ?? undefined,
      mainStart: parsed.structureAnalysis.mainStart ?? undefined,
      mainEnd: parsed.structureAnalysis.mainEnd ?? undefined,
      outroStart: parsed.structureAnalysis.outroStart ?? undefined,
    } : undefined;

    const topicFlow = parsed.topicFlow?.map((t, i) => ({
      id: t.id || `topic_${i + 1}`,
      name: t.name || "Unknown topic",
      start: t.start || 0,
      end: t.end || duration,
    }));

    return {
      mainTopics: parsed.mainTopics || [],
      overallTone: parsed.overallTone || "casual",
      keyMoments: (parsed.keyMoments || []).map((k: RawKeyMoment) => ({
        timestamp: k.timestamp || 0,
        description: k.description || "",
        importance: k.importance || "medium",
      })),
      brollWindows: validatedBrollWindows,
      extractedKeywords: parsed.extractedKeywords || [],
      contentSummary: parsed.contentSummary || "",
      hookMoments,
      structureAnalysis,
      topicFlow,
    };
  } catch (error) {
    aiLogger.error("Semantic analysis error:", error);
    return getDefaultSemanticAnalysis(transcript, duration);
  }
}

function getDefaultSemanticAnalysis(transcript: TranscriptSegment[], duration: number): SemanticAnalysis {
  const allText = transcript.map(t => t.text).join(" ");
  const words = allText.toLowerCase().split(/\s+/).filter(w => w.length > 4);
  const wordCount = new Map<string, number>();
  words.forEach(w => wordCount.set(w, (wordCount.get(w) || 0) + 1));
  const topWords = Array.from(wordCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word);

  return {
    mainTopics: topWords.slice(0, 3),
    overallTone: "casual",
    keyMoments: [],
    brollWindows: [],
    extractedKeywords: topWords,
    contentSummary: `Video content with ${transcript.length} segments over ${duration.toFixed(0)} seconds`,
  };
}
