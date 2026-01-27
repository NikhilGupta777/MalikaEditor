import { withRetry, AI_RETRY_OPTIONS } from "../../utils/retry";
import { createLogger } from "../../utils/logger";
import { getGeminiClient } from "./clients";
import { AI_CONFIG } from "../../config/ai";
import {
  normalizePriority,
  normalizeOverallTone,
  normalizeKeyMomentType,
  type Priority,
} from "./normalization";
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
  currentTopic?: string;
  suggestedQuery?: string;
  priority?: string;
  reason?: string;
}

interface RawKeyMoment {
  timestamp?: number;
  type?: string; // Allow any string, will normalize
  description?: string;
  importance?: string; // Allow any string, will normalize
}

export function detectTranscriptLanguage(
  transcript: TranscriptSegment[],
): string {
  if (!transcript || transcript.length === 0) return "en";

  const allText = transcript.map((t) => t.text).join(" ");

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
  sourceLanguage: string,
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
  aiLogger.info(
    `Translating transcript from ${langName} to English for semantic analysis...`,
  );

  const textsToTranslate = transcript
    .map((seg, i) => `[${i}]: ${seg.text}`)
    .join("\n");

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
      () =>
        getGeminiClient().models.generateContent({
          model: AI_CONFIG.models.analysis,
          contents: [{ role: "user", parts: [{ text: prompt }] }],
        }),
      "translateTranscript",
      AI_RETRY_OPTIONS,
    );

    const responseText = response.text || "";
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);

    if (!jsonMatch) {
      aiLogger.warn(
        "Failed to parse translation response, using original text",
      );
      return transcript;
    }

    const translations = JSON.parse(jsonMatch[0]);

    if (
      !Array.isArray(translations) ||
      translations.length !== transcript.length
    ) {
      aiLogger.warn(
        `Translation count mismatch: got ${translations.length}, expected ${transcript.length}`,
      );
      return transcript;
    }

    const translatedSegments: TranscriptSegment[] = transcript.map(
      (seg, i) => ({
        start: seg.start,
        end: seg.end,
        text: translations[i] || seg.text,
      }),
    );

    aiLogger.info(
      `Translation complete: ${translatedSegments.length} segments translated to English`,
    );
    return translatedSegments;
  } catch (error) {
    aiLogger.error("Translation failed:", error);
    return transcript;
  }
}

const FILLER_WORDS = [
  "um",
  "uh",
  "erm",
  "er",
  "ah",
  "uhh",
  "umm",
  "like",
  "you know",
  "so",
  "basically",
  "actually",
  "literally",
  "i mean",
  "you see",
  "right",
  "okay",
  "well",
  "just",
  "kind of",
  "sort of",
  "you know what i mean",
  "at the end of the day",
];

export function detectFillerWords(
  transcript: TranscriptSegment[],
): { start: number; end: number; word: string }[] {
  const fillerSegments: { start: number; end: number; word: string }[] = [];

  for (const segment of transcript) {
    const text = segment.text.toLowerCase();
    const segmentDuration = segment.end - segment.start;
    const textWords = text.split(/\s+/);
    const wordsPerSecond = textWords.length / Math.max(segmentDuration, 0.1);
    
    const hasWordTiming = segment.words && segment.words.length > 0;

    for (const filler of FILLER_WORDS) {
      const fillerLower = filler.toLowerCase();

      if (filler.includes(" ")) {
        if (text.includes(fillerLower)) {
          const fillerWords = filler.split(" ");
          
          if (hasWordTiming) {
            const segmentWordsLower = segment.words!.map(w => w.word.toLowerCase().replace(/[^a-z]/g, ""));
            for (let i = 0; i <= segmentWordsLower.length - fillerWords.length; i++) {
              let match = true;
              for (let j = 0; j < fillerWords.length; j++) {
                if (segmentWordsLower[i + j] !== fillerWords[j].replace(/[^a-z]/g, "")) {
                  match = false;
                  break;
                }
              }
              if (match) {
                fillerSegments.push({
                  start: segment.words![i].start,
                  end: segment.words![i + fillerWords.length - 1].end,
                  word: filler,
                });
                break;
              }
            }
          } else {
            const index = text.indexOf(fillerLower);
            const position = index / Math.max(text.length, 1);
            const estimatedStart = segment.start + position * segmentDuration;
            const fillerWordCount = fillerWords.length;
            const estimatedDuration = fillerWordCount / Math.max(wordsPerSecond, 0.1);

            fillerSegments.push({
              start: estimatedStart,
              end: estimatedStart + estimatedDuration,
              word: filler,
            });
          }
        }
      } else {
        if (hasWordTiming) {
          for (const wordTiming of segment.words!) {
            const cleanWord = wordTiming.word.toLowerCase().replace(/[^a-z]/g, "");
            if (cleanWord === fillerLower) {
              fillerSegments.push({
                start: wordTiming.start,
                end: wordTiming.end,
                word: filler,
              });
            }
          }
        } else {
          for (let i = 0; i < textWords.length; i++) {
            const word = textWords[i].replace(/[^a-z]/g, "");
            if (word === fillerLower) {
              const wordPosition = i / Math.max(textWords.length, 1);
              const estimatedStart = segment.start + wordPosition * segmentDuration;
              const estimatedDuration = 1 / Math.max(wordsPerSecond, 0.1);

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
  }

  fillerSegments.sort((a, b) => a.start - b.start);

  aiLogger.debug(`Detected ${fillerSegments.length} filler word instances`);
  return fillerSegments;
}

interface BrollWindow {
  start: number;
  end: number;
  context: string;
  suggestedQuery: string;
  priority: Priority;
  reason: string;
}


export async function analyzeTranscriptSemantics(
  transcript: TranscriptSegment[],
  videoContext?: VideoContext,
  videoDuration?: number,
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

  const fullTranscript = transcript
    .map((t) => `[${t.start.toFixed(1)}s-${t.end.toFixed(1)}s]: ${t.text}`)
    .join("\n");
  const duration =
    videoDuration || transcript[transcript.length - 1]?.end || 60;

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

2. **OVERALL TONE** - Classify: educational, spiritual, religious, peace, story mode,entertaining, inspirational, professional, casual, serious etc.

3. **KEY MOMENTS** - Identify all the best peak engagement moments where:
   - Important points are made
   - Emotional emphasis occurs
   - Key information is delivered

4. **HOOK ANALYSIS** (NEW - CRITICAL)
Analyze the first 5-15 seconds of content. Score the hook strength (0-100):
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
   - When speaker discusses prophecy, tech, news, concepts etc.
   - When examples/illustrations are mentioned
   - During transitions between topics
   - When specific objects/places/actions are referenced
   
   For each B-roll window, provide:
   - Exact start/end timestamps (must align with transcript segments)
   - Context (what's being discussed) - BE SPECIFIC about the current topic
   - currentTopic (the main subject being discussed at this moment)
   - ULTRA-SPECIFIC search query that:
     * Contains an ACTION VERB (reading, walking, typing, presenting, cooking, climbing, etc.)
     * Contains a SPECIFIC SUBJECT (businessman, god, godhead, lord, chef, student, athlete, etc.)
     * Contains CONTEXTUAL DETAILS (setting, time, mood)
     * Directly relates to the currentTopic being discussed
   - Priority (high = essential visual support, medium = enhances understanding, low = optional distribution)
   - Reason why B-roll helps here

8. **EXTRACTED KEYWORDS** - List 10-30 important keywords/phrases from the content

9. **CONTENT SUMMARY** - 2-3 sentence summary of the whole video content

CRITICAL ULTRA-SPECIFIC B-ROLL QUERY GUIDELINES:

REQUIRED QUERY STRUCTURE:
Each query MUST include:
1. An ACTION VERB (walking, typing, cooking, climbing, presenting, etc.)
2. A SPECIFIC SUBJECT (businessman, chef, mountain climber, teacher, etc.)
3. CONTEXTUAL DETAILS (location, time of day, mood, setting)

NEGATIVE EXAMPLES - NEVER USE QUERIES LIKE THESE:
- "person working" (too generic - WHO is working? WHAT are they doing?)
- "abstract background" (meaningless visual, no connection to content)
- "business" or "technology" (single word queries are useless)
- "people talking" (generic, could be anything)
- "nature scene" (vague, doesn't match specific content)
- "office" (just a noun, no action or context)
- "success" or "motivation" (abstract concepts, not searchable visuals)

POSITIVE EXAMPLES - MODEL YOUR QUERIES AFTER THESE:
- "software developer typing code on dual monitors in modern tech startup office"
- "professional chef slicing fresh vegetables on wooden cutting board in restaurant kitchen"
"spiritual teacher meditating in serene ashram with soft morning light"
"devotee lighting oil lamp during evening aarti in ancient temple"
"monk chanting mantras with prayer beads in quiet monastery hall"
"person practicing deep meditation near flowing river at sunrise"
"yogi sitting in lotus pose on mountain peak with mist and sunlight"
"group of devotees listening to spiritual discourse in peaceful satsang setting"
"pilgrims walking barefoot on temple pathway at dawn"
"close-up of hands holding mala beads during prayer and contemplation"
"spiritual seeker reading ancient scriptures beside oil lamp in calm room"
- "hiker ascending rocky mountain trail at golden hour with valley vista below"
- "entrepreneur giving presentation to investors in glass-walled conference room"

CONTEXT-AWARE REQUIREMENTS:
- Reference the SPECIFIC TOPIC being discussed when the B-roll appears
- If speaker mentions "building a startup", query should show startup-specific visuals 
- If speaker discusses "healthy eating", query should show specific healthy food preparation 
- If speaker discusses meditation or inner peace → visuals: calm environments, closed eyes, soft light, nature stillness
- If speaker discusses devotion or bhakti → visuals: prayer, lamps, temples, folded hands, chanting
- Match the ENERGY of the content (calm content = calm visuals, excited content = dynamic visuals)

B-ROLL TIMING RULES:
- Duration: 3-5 seconds per B-roll (optimal for visual impact)
- Spacing: minimum 3-5 seconds between B-roll clips
- Place B-roll at the START of concepts, not during key revelations
- DISTRIBUTE B-ROLL EVENLY across the ENTIRE video timeline
- For this ${duration.toFixed(0)}s video, YOU HAVE COMPLETE AUTONOMY to decide the optimal number of B-roll windows - there are NO limits or targets. Use as many or as few as the content genuinely needs for maximum viewer engagement and professional quality
- Ensure B-roll windows cover ALL parts of the video, not just the beginning
- Each third of the video (0-33%, 34-66%, 67-100%) should have proportional B-roll coverage

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
      "currentTopic": "the specific topic being discussed at this timestamp",
      "suggestedQuery": "ULTRA-SPECIFIC query with ACTION VERB + SPECIFIC SUBJECT + CONTEXT (e.g., 'professional businessman walking through modern glass office with city skyline visible')",
      "priority": "low|medium|high",
      "reason": "why B-roll enhances this moment"
    }
  ],
  "extractedKeywords": ["keyword1", "keyword2", ...],
  "contentSummary": "2-3 sentence summary"
}`;

  try {
    const response = await withRetry(
      () =>
        getGeminiClient().models.generateContent({
          model: AI_CONFIG.models.analysis,
          contents: [{ role: "user", parts: [{ text: prompt }] }],
        }),
      "analyzeTranscriptSemantics",
      AI_RETRY_OPTIONS,
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
      overallTone?:
        | "educational"
        | "entertaining"
        | "inspirational"
        | "professional"
        | "casual"
        | "serious";
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
      topicFlow?: {
        id?: string;
        name?: string;
        start?: number;
        end?: number;
      }[];
    }

    const parsed = JSON.parse(jsonMatch[0]) as ParsedSemanticResponse;

    const rawBrollWindows = (parsed.brollWindows || [])
      .filter((b: RawBrollWindow) => b.start !== undefined && b.suggestedQuery)
      .filter((b: RawBrollWindow) => {
        const query = (b.suggestedQuery || "").toLowerCase();
        const genericQueries = [
          "person working",
          "abstract background",
          "business",
          "technology",
          "nature scene",
          "office",
          "people talking",
        ];
        return !genericQueries.some(
          (generic) => query === generic || query.split(" ").length < 4,
        );
      })
      .map((b: RawBrollWindow) => ({
        start: Math.max(0, b.start || 0),
        end: Math.min(duration, b.end || (b.start || 0) + 4),
        context: b.currentTopic
          ? `${b.currentTopic}: ${b.context || ""}`
          : b.context || "",
        suggestedQuery: b.suggestedQuery || "",
        priority: normalizePriority(b.priority || "medium"),
        reason: b.reason || "Enhance visual interest",
      })); // No limit - AI decides the count based on content
    // AI decides B-roll placement - pass through without redistribution
    const validatedBrollWindows = rawBrollWindows;

    const hookMoments = parsed.hookMoments?.map((h) => ({
      timestamp: h.timestamp || 0,
      score: Math.min(100, Math.max(0, h.score || 0)),
      reason: h.reason || "",
    }));

    const structureAnalysis = parsed.structureAnalysis
      ? {
          introEnd: parsed.structureAnalysis.introEnd ?? undefined,
          mainStart: parsed.structureAnalysis.mainStart ?? undefined,
          mainEnd: parsed.structureAnalysis.mainEnd ?? undefined,
          outroStart: parsed.structureAnalysis.outroStart ?? undefined,
        }
      : undefined;

    const topicFlow = parsed.topicFlow?.map((t, i) => ({
      id: t.id || `topic_${i + 1}`,
      name: t.name || "Unknown topic",
      start: t.start || 0,
      end: t.end || duration,
    }));

    return {
      mainTopics: parsed.mainTopics || [],
      overallTone: normalizeOverallTone(parsed.overallTone || "casual"),
      keyMoments: (parsed.keyMoments || []).map((k: RawKeyMoment) => ({
        timestamp: k.timestamp || 0,
        description: k.description || "",
        importance: normalizePriority(k.importance || "medium"),
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

function getDefaultSemanticAnalysis(
  transcript: TranscriptSegment[],
  duration: number,
): SemanticAnalysis {
  const allText = transcript.map((t) => t.text).join(" ");
  const words = allText
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 4);
  const wordCount = new Map<string, number>();
  words.forEach((w) => wordCount.set(w, (wordCount.get(w) || 0) + 1));
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
