import { GoogleGenAI } from "@google/genai";
import OpenAI, { toFile } from "openai";
import { promises as fs } from "fs";
import { z } from "zod";
import { withRetry, AI_RETRY_OPTIONS } from "../utils/retry";
import { createLogger } from "../utils/logger";
import type {
  VideoAnalysis,
  FrameAnalysis,
  EditPlan,
  EditAction,
  TranscriptSegment,
  VideoContext,
  TopicSegment,
  SemanticAnalysis,
} from "@shared/schema";

const aiLogger = createLogger("ai-service");

const CutKeepActionSchema = z.object({
  type: z.enum(["cut", "keep"]),
  start: z.number().min(0),
  end: z.number().min(0),
  reason: z.string().optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
}).refine(data => data.end >= data.start, { message: "end must be >= start" });

const InsertStockActionSchema = z.object({
  type: z.literal("insert_stock"),
  start: z.number().min(0).optional(),
  duration: z.number().min(1).max(8).optional(),
  stockQuery: z.string(),
  reason: z.string().optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  transcriptContext: z.string().optional(),
});

// Note: InsertAiImageActionSchema removed - AI images are auto-placed from semantic analysis

const TextActionSchema = z.object({
  type: z.enum(["add_caption", "add_text_overlay"]),
  start: z.number().min(0).optional(),
  end: z.number().min(0).optional(),
  text: z.string(),
  reason: z.string().optional(),
});

const TransitionActionSchema = z.object({
  type: z.literal("transition"),
  transitionType: z.string().optional(),
  reason: z.string().optional(),
});

const EditActionSchema = z.union([
  CutKeepActionSchema,
  InsertStockActionSchema,
  TextActionSchema,
  TransitionActionSchema,
]);

const EditPlanResponseSchema = z.object({
  actions: z.array(z.any()),
  stockQueries: z.array(z.string()).optional(),
  keyPoints: z.array(z.string()).optional(),
  estimatedDuration: z.number().optional(),
  editingStrategy: z.object({
    approach: z.string().optional(),
    focusAreas: z.array(z.string()).optional(),
    avoidAreas: z.array(z.string()).optional(),
  }).optional(),
});

const FrameAnalysisSchema = z.object({
  timestamp: z.number().optional(),
  description: z.string().optional().default(""),
  keyMoment: z.boolean().optional().default(false),
  suggestedStockQuery: z.string().nullable().optional(),
  energyLevel: z.enum(["low", "medium", "high"]).optional(),
  speakingPace: z.enum(["slow", "normal", "fast"]).optional(),
});

const VideoContextSchema = z.object({
  genre: z.enum([
    "tutorial", "vlog", "interview", "presentation", "documentary",
    "spiritual", "educational", "entertainment", "tech", "lifestyle",
    "gaming", "music", "news", "review", "motivational", "other"
  ]),
  subGenre: z.string().optional(),
  targetAudience: z.string().optional(),
  tone: z.enum(["serious", "casual", "professional", "humorous", "inspirational", "dramatic", "calm"]),
  pacing: z.enum(["slow", "moderate", "fast", "dynamic"]),
  visualStyle: z.string().optional(),
  suggestedEditStyle: z.enum(["minimal", "moderate", "dynamic", "cinematic", "fast-paced"]),
  regionalContext: z.string().nullish(),
  languageDetected: z.string().nullish(),
});

const TopicSegmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  topic: z.string(),
  importance: z.enum(["low", "medium", "high"]).optional(),
  suggestedBrollWindow: z.boolean().optional(),
});

const BrollOpportunitySchema = z.object({
  start: z.number(),
  end: z.number(),
  suggestedDuration: z.number(),
  query: z.string(),
  priority: z.enum(["low", "medium", "high"]),
  reason: z.string(),
});

const VideoAnalysisResponseSchema = z.object({
  frames: z.array(FrameAnalysisSchema),
  summary: z.string().optional().default(""),
  context: VideoContextSchema.optional(),
  topicSegments: z.array(TopicSegmentSchema).optional(),
  narrativeStructure: z.object({
    hasIntro: z.boolean().nullish(),
    introEnd: z.number().nullish(),
    hasOutro: z.boolean().nullish(),
    outroStart: z.number().nullish(),
    mainContentStart: z.number().nullish(),
    mainContentEnd: z.number().nullish(),
    peakMoments: z.array(z.number()).nullish(),
  }).optional(),
  brollOpportunities: z.array(BrollOpportunitySchema).optional(),
});

const geminiClient = new GoogleGenAI({
  apiKey: process.env.AI_INTEGRATIONS_GEMINI_API_KEY,
  httpOptions: {
    apiVersion: "",
    baseUrl: process.env.AI_INTEGRATIONS_GEMINI_BASE_URL,
  },
});

function getEditStyleGuidance(context?: VideoContext): string {
  if (!context) {
    return "Apply moderate editing that balances engagement with authenticity.";
  }

  const styleGuides: Record<string, string> = {
    spiritual: `SPIRITUAL/RELIGIOUS CONTENT GUIDELINES:
- Preserve the contemplative, reverent atmosphere
- Use minimal cuts to maintain flow and allow moments of reflection
- B-roll should be calming: nature scenes, peaceful imagery, symbolic visuals
- Avoid jarring transitions or fast-paced editing
- Prioritize audio clarity for prayers, mantras, or teachings
- Text overlays should be subtle and elegant`,

    tutorial: `TUTORIAL/EDUCATIONAL CONTENT GUIDELINES:
- Keep demonstrations and explanations intact
- Cut hesitations, repeated attempts, and off-topic tangents
- Use B-roll to illustrate concepts being explained
- Add text overlays for key steps or important notes
- Maintain logical flow and progression
- Ensure all instructional content is preserved`,

    interview: `INTERVIEW CONTENT GUIDELINES:
- Preserve natural conversation flow and emotional moments
- Cut only obvious dead air, not thoughtful pauses
- Use B-roll during explanatory portions, not during emotional responses
- Keep reaction shots and facial expressions visible
- Text overlays for speaker names and key quotes
- Maintain conversational rhythm`,

    tech: `TECH CONTENT GUIDELINES:
- Keep code demonstrations and explanations clear
- Use B-roll of modern technology, clean interfaces
- Cut tangents while preserving technical accuracy
- Text overlays for code snippets, URLs, or key specs
- Maintain logical progression of technical concepts
- Fast-paced editing acceptable but not distracting`,

    vlog: `VLOG CONTENT GUIDELINES:
- Preserve personality and authentic moments
- Dynamic editing to maintain engagement
- Use B-roll to establish locations and context
- Cut dead air but keep personality quirks
- Text overlays for locations, dates, or emphasis
- Match energy level of the creator`,

    motivational: `MOTIVATIONAL CONTENT GUIDELINES:
- Build emotional momentum throughout
- Use inspiring B-roll: success imagery, nature, achievement
- Preserve powerful delivery moments
- Strategic text overlays for key quotes
- Maintain building intensity toward climax
- Cut hesitations but not powerful pauses`,

    documentary: `DOCUMENTARY CONTENT GUIDELINES:
- Preserve narrative structure and pacing
- Use archival or contextual B-roll appropriately
- Maintain emotional beats and story arc
- Text overlays for dates, locations, names
- Thoughtful cuts that serve the story
- Balance between information and engagement`,
  };

  return styleGuides[context.genre] || 
    `For ${context.genre} content with ${context.tone} tone and ${context.pacing} pacing:
- Match editing style to content energy
- Use contextually appropriate B-roll
- Preserve key moments and authenticity
- Cut only non-essential content`;
}

function getBrollStyleHint(genre?: string): string {
  const hints: Record<string, string> = {
    spiritual: "serene nature, peaceful temples, soft lighting, symbolic imagery, meditation scenes",
    tutorial: "process diagrams, tools, workspaces, hands working, screen recordings",
    interview: "location establishing shots, related activities, archival footage",
    tech: "modern devices, clean interfaces, data visualization, innovation imagery",
    vlog: "location shots, lifestyle imagery, activities, travel scenes",
    motivational: "success imagery, athletes, sunrise, achievement moments, inspiring landscapes",
    documentary: "archival footage, location establishing, contextual imagery",
    educational: "diagrams, illustrations, real-world examples, demonstrations",
    entertainment: "dynamic visuals, reactions, complementary footage",
    lifestyle: "aesthetic interiors, activities, products, daily life",
    gaming: "gameplay footage, gaming setups, community events",
    music: "performance shots, instruments, concert imagery, artistic visuals",
    news: "location footage, relevant imagery, data graphics",
    review: "product shots, comparisons, detail close-ups, usage scenarios",
  };
  return hints[genre || "other"] || "contextually relevant imagery that matches the content tone";
}

function validateAndFixBrollActions(actions: EditAction[], duration: number): EditAction[] {
  // Validate insert_stock actions only (AI images are auto-placed from semantic analysis)
  const brollActions = actions.filter(a => a.type === "insert_stock");
  const otherActions = actions.filter(a => a.type !== "insert_stock");
  
  const brollWithTiming = brollActions.map((a, index) => ({
    ...a,
    start: a.start ?? (index * 10),
  }));
  
  // Sort all B-roll actions by start time for proper spacing validation
  brollWithTiming.sort((a, b) => (a.start || 0) - (b.start || 0));
  
  const validatedBroll: EditAction[] = [];
  let lastEnd = -3; // Minimum 3 second spacing between B-roll
  
  for (const action of brollWithTiming) {
    const start = Math.max(0, action.start || 0);
    const actionDuration = action.duration || 4;
    
    // Ensure 3 second spacing between B-roll overlays
    if (start >= lastEnd + 3 && start < duration - 1) {
      validatedBroll.push({
        ...action,
        start,
        duration: Math.min(6, Math.max(2, actionDuration)),
      });
      lastEnd = start + actionDuration;
    } else {
      aiLogger.debug(`Skipping overlapping B-roll (${action.type}) at ${start}s (previous ended at ${lastEnd}s)`);
    }
  }
  
  return [...otherActions, ...validatedBroll];
}

const openaiClient = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

async function encodeImageToBase64(imagePath: string): Promise<string> {
  return fs.readFile(imagePath, { encoding: "base64" });
}

export async function analyzeVideoFrames(
  framePaths: string[],
  duration: number,
  silentSegments: { start: number; end: number }[]
): Promise<VideoAnalysis> {
  const frameInterval = duration / (framePaths.length + 1);

  const frameContents = await Promise.all(
    framePaths.map(async (path, index) => {
      const base64 = await encodeImageToBase64(path);
      return {
        timestamp: frameInterval * (index + 1),
        base64,
      };
    })
  );

  const prompt = `You are an expert video analyst and professional video editor. Analyze these ${framePaths.length} frames from a video that is ${duration.toFixed(1)} seconds long.

PERFORM A COMPREHENSIVE ANALYSIS:

1. VIDEO CONTEXT CLASSIFICATION
Determine the video's genre, tone, target audience, and optimal editing approach:
- Genre: tutorial, vlog, interview, presentation, documentary, spiritual, educational, entertainment, tech, lifestyle, gaming, music, news, review, motivational, or other
- Tone: serious, casual, professional, humorous, inspirational, dramatic, or calm
- Pacing: slow, moderate, fast, or dynamic
- Regional/cultural context if apparent
- Language being spoken

2. FRAME-BY-FRAME ANALYSIS
For each frame:
- Detailed description of visual content
- Whether it's a key moment (high engagement/importance)
- Energy level (low/medium/high)
- Stock media search query that would enhance this moment (be specific and contextually relevant)

3. NARRATIVE STRUCTURE
Identify:
- Introduction section (if any) and when it ends
- Main content boundaries
- Outro/conclusion section (if any) and when it starts
- Peak moments of interest/engagement (timestamps)

4. TOPIC SEGMENTATION
Break the video into distinct topic/subject segments with:
- Start and end times
- Topic description
- Importance level (low/medium/high)
- Whether it's a good B-roll window

5. B-ROLL OPPORTUNITIES
Identify specific moments where stock footage/images would enhance the content:
- Exact timestamp ranges
- Optimal duration (2-6 seconds typically)
- Specific, descriptive search query matching the content's context
- Priority (high = essential, medium = enhances, low = optional)
- Reason why B-roll would help here

Silent segments detected: ${JSON.stringify(silentSegments)}

IMPORTANT GUIDELINES:
- For spiritual/religious content: suggest calm, reverent imagery (nature, peaceful scenes, symbolic imagery)
- For tech content: suggest modern, clean technology imagery
- For tutorials: suggest illustrative diagrams, process visuals
- For interviews: suggest contextual B-roll related to discussion topics
- B-roll should NEVER distract from important visual moments (face expressions, demonstrations)
- Place B-roll during explanatory speech, NOT during key visual moments

Respond in JSON format only (no markdown):
{
  "frames": [
    {
      "timestamp": number,
      "description": "string",
      "keyMoment": boolean,
      "suggestedStockQuery": "string or null",
      "energyLevel": "low" | "medium" | "high",
      "speakingPace": "slow" | "normal" | "fast"
    }
  ],
  "summary": "string - comprehensive summary of video content and purpose",
  "context": {
    "genre": "string - one of the genre options above",
    "subGenre": "string - more specific category if applicable",
    "targetAudience": "string - who this video is for",
    "tone": "string - one of the tone options above",
    "pacing": "string - slow/moderate/fast/dynamic",
    "visualStyle": "string - describe the visual aesthetic",
    "suggestedEditStyle": "minimal" | "moderate" | "dynamic" | "cinematic" | "fast-paced",
    "regionalContext": "string or null - cultural/regional context if apparent",
    "languageDetected": "string - detected language"
  },
  "topicSegments": [
    {
      "start": number,
      "end": number,
      "topic": "string - what's being discussed/shown",
      "importance": "low" | "medium" | "high",
      "suggestedBrollWindow": boolean
    }
  ],
  "narrativeStructure": {
    "hasIntro": boolean,
    "introEnd": number or null,
    "hasOutro": boolean,
    "outroStart": number or null,
    "mainContentStart": number,
    "mainContentEnd": number,
    "peakMoments": [array of timestamps]
  },
  "brollOpportunities": [
    {
      "start": number,
      "end": number,
      "suggestedDuration": number (2-6 seconds recommended),
      "query": "string - specific, contextual search query",
      "priority": "low" | "medium" | "high",
      "reason": "string - why B-roll would enhance this moment"
    }
  ]
}`;

  const imageParts = frameContents.map((frame) => ({
    inlineData: {
      mimeType: "image/jpeg",
      data: frame.base64,
    },
  }));

  const response = await withRetry(
    () => geminiClient.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            ...imageParts,
          ],
        },
      ],
    }),
    "analyzeVideoFrames",
    AI_RETRY_OPTIONS
  );

  const text = response.text || "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    aiLogger.warn("Failed to parse AI response for frame analysis, using defaults");
    return {
      duration,
      frames: framePaths.map((_, i) => ({
        timestamp: frameInterval * (i + 1),
        description: "Frame analysis unavailable",
        keyMoment: false,
        suggestedStockQuery: undefined,
      })),
      silentSegments,
      summary: "Analysis unavailable",
    };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(jsonMatch[0]);
    const validated = VideoAnalysisResponseSchema.safeParse(parsed);
    if (!validated.success) {
      aiLogger.warn("AI response validation failed:", validated.error);
    }
  } catch (parseError) {
    aiLogger.warn("JSON parse error in frame analysis:", parseError);
    return {
      duration,
      frames: framePaths.map((_, i) => ({
        timestamp: frameInterval * (i + 1),
        description: "Frame analysis unavailable",
        keyMoment: false,
        suggestedStockQuery: undefined,
      })),
      silentSegments,
      summary: "Analysis unavailable",
    };
  }

  const frames: FrameAnalysis[] = (parsed.frames || []).map((f: any, i: number) => ({
    timestamp: f.timestamp || frameInterval * (i + 1),
    description: f.description || "",
    keyMoment: f.keyMoment || false,
    suggestedStockQuery: f.suggestedStockQuery || undefined,
    energyLevel: f.energyLevel || undefined,
    speakingPace: f.speakingPace || undefined,
  }));

  const context: VideoContext | undefined = parsed.context ? {
    genre: parsed.context.genre || "other",
    subGenre: parsed.context.subGenre,
    targetAudience: parsed.context.targetAudience,
    tone: parsed.context.tone || "casual",
    pacing: parsed.context.pacing || "moderate",
    visualStyle: parsed.context.visualStyle,
    suggestedEditStyle: parsed.context.suggestedEditStyle || "moderate",
    regionalContext: parsed.context.regionalContext,
    languageDetected: parsed.context.languageDetected,
  } : undefined;

  const topicSegments: TopicSegment[] | undefined = parsed.topicSegments?.map((t: any) => ({
    start: t.start || 0,
    end: t.end || duration,
    topic: t.topic || "Unknown topic",
    importance: t.importance,
    suggestedBrollWindow: t.suggestedBrollWindow,
  }));

  const brollOpportunities = parsed.brollOpportunities?.map((b: any) => ({
    start: Math.max(0, b.start || 0),
    end: Math.min(duration, b.end || b.start + 3),
    suggestedDuration: Math.min(6, Math.max(2, b.suggestedDuration || 3)),
    query: b.query || "background footage",
    priority: b.priority || "medium",
    reason: b.reason || "Enhance visual interest",
  }));

  return {
    duration,
    frames,
    silentSegments,
    summary: parsed.summary || "",
    context,
    topicSegments,
    narrativeStructure: parsed.narrativeStructure,
    brollOpportunities,
  };
}

// Whisper.cpp model path - using multilingual base model for non-English support
const WHISPER_MODEL_PATH = "/tmp/whisper_models/ggml-base.bin";

/**
 * Transcribe audio using local whisper.cpp for accurate timestamps
 * This is the single source of truth for transcription timing
 */
export async function transcribeAudio(
  audioPath: string
): Promise<TranscriptSegment[]> {
  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const execPromise = promisify(exec);
  const { v4: uuidv4 } = await import("uuid");
  
  aiLogger.info(`Transcription starting with local whisper.cpp...`);
  
  // Check if model exists
  try {
    await fs.access(WHISPER_MODEL_PATH);
  } catch {
    aiLogger.error(`Whisper model not found at ${WHISPER_MODEL_PATH}`);
    aiLogger.info("Downloading multilingual whisper model...");
    await fs.mkdir("/tmp/whisper_models", { recursive: true });
    await execPromise(
      `curl -L -o "${WHISPER_MODEL_PATH}" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"`,
      { timeout: 120000 }
    );
  }
  
  // Convert audio to 16kHz mono WAV (whisper.cpp requirement)
  const wavPath = `/tmp/whisper_${uuidv4()}.wav`;
  const jsonOutputBase = `/tmp/whisper_${uuidv4()}`;
  const jsonPath = `${jsonOutputBase}.json`;
  
  // Helper function for cleanup - defined before use for clarity
  const cleanupTempFiles = async () => {
    await fs.unlink(wavPath).catch(() => {});
    await fs.unlink(jsonPath).catch(() => {});
  };
  
  try {
    aiLogger.info("Converting audio to WAV format for whisper.cpp...");
    await execPromise(
      `ffmpeg -y -i "${audioPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${wavPath}" 2>/dev/null`
    );
    
    // Run whisper.cpp with JSON output
    aiLogger.info("Running whisper.cpp transcription...");
    const whisperCmd = `whisper-cpp -m "${WHISPER_MODEL_PATH}" -oj -of "${jsonOutputBase}" -f "${wavPath}" 2>/dev/null`;
    
    await execPromise(whisperCmd, { timeout: 300000 }); // 5 minute timeout
    
    // Read the JSON output file
    const jsonContent = await fs.readFile(jsonPath, "utf-8");
    const whisperOutput = JSON.parse(jsonContent);
    
    // Parse whisper.cpp JSON format into TranscriptSegment[] with word-level timing
    const segments: TranscriptSegment[] = [];
    const rawSegmentCount = whisperOutput.transcription?.length || 0;
    
    if (whisperOutput.transcription && Array.isArray(whisperOutput.transcription)) {
      for (const seg of whisperOutput.transcription) {
        // Primary: use timestamp strings "00:00:00,000" format
        // Fallback: use offsets.from/to (milliseconds) if timestamp parsing fails
        let startMs = parseWhisperTimestamp(seg.timestamps?.from);
        let endMs = parseWhisperTimestamp(seg.timestamps?.to);
        
        // Fallback to offsets if timestamp parsing failed
        if (startMs === null && typeof seg.offsets?.from === "number") {
          startMs = seg.offsets.from;
        }
        if (endMs === null && typeof seg.offsets?.to === "number") {
          endMs = seg.offsets.to;
        }
        
        const text = (seg.text || "").trim();
        
        if (text.length > 0 && startMs !== null && endMs !== null && endMs > startMs) {
          // Extract word-level timing from tokens if available
          const words: { word: string; start: number; end: number }[] = [];
          
          if (seg.tokens && Array.isArray(seg.tokens)) {
            for (const token of seg.tokens) {
              const tokenText = (token.text || "").trim();
              if (tokenText.length > 0 && !tokenText.startsWith("[") && !tokenText.endsWith("]")) {
                // Token timing - use offsets (in milliseconds)
                let tokenStart = token.offsets?.from;
                let tokenEnd = token.offsets?.to;
                
                // Fallback to timestamp parsing if offsets not available
                if (typeof tokenStart !== "number" && token.timestamps?.from) {
                  tokenStart = parseWhisperTimestamp(token.timestamps.from);
                }
                if (typeof tokenEnd !== "number" && token.timestamps?.to) {
                  tokenEnd = parseWhisperTimestamp(token.timestamps.to);
                }
                
                if (typeof tokenStart === "number" && typeof tokenEnd === "number" && tokenEnd > tokenStart) {
                  words.push({
                    word: tokenText,
                    start: tokenStart / 1000,
                    end: tokenEnd / 1000,
                  });
                }
              }
            }
          }
          
          // If no token-level timing, estimate word timing from segment
          if (words.length === 0 && text.length > 0) {
            const segmentWords = text.split(/\s+/).filter((w: string) => w.length > 0);
            const segDuration = (endMs - startMs) / 1000;
            const wordDuration = segDuration / Math.max(segmentWords.length, 1);
            
            segmentWords.forEach((word: string, idx: number) => {
              words.push({
                word,
                start: (startMs / 1000) + (idx * wordDuration),
                end: (startMs / 1000) + ((idx + 1) * wordDuration),
              });
            });
          }
          
          segments.push({
            start: startMs / 1000,
            end: endMs / 1000,
            text,
            words: words.length > 0 ? words : undefined,
          });
        } else if (text.length > 0) {
          aiLogger.warn(`Skipping segment with invalid timestamps: "${text.substring(0, 30)}..." (from=${startMs}, to=${endMs})`);
        }
      }
    }
    
    if (segments.length > 0) {
      aiLogger.info(`Whisper.cpp transcription complete: ${segments.length} segments with REAL timestamps`);
      return segments;
    }
    
    // If whisper produced segments but we couldn't parse any, this is a format error
    // Return empty array to surface the issue - do NOT fallback to estimated timestamps
    if (rawSegmentCount > 0 && segments.length === 0) {
      aiLogger.error(`CRITICAL: Whisper.cpp returned ${rawSegmentCount} segments but all failed timestamp parsing. Format may have changed.`);
      aiLogger.error("Refusing to fallback to estimated timestamps - returning empty transcript");
      return [];
    }
    
    aiLogger.warn("Whisper.cpp returned no segments, trying fallback...");
  } catch (error: any) {
    aiLogger.error("Whisper.cpp transcription failed:", error?.message || error);
    // Only fallback if whisper completely failed (not if parsing failed)
    // The parsing failure case returns early above
  } finally {
    // Always cleanup temp files
    await cleanupTempFiles();
  }
  
  // Fallback: Use OpenAI gpt-4o-mini-transcribe (text only, estimate timestamps)
  // This only runs if whisper.cpp completely failed or returned zero segments
  try {
    aiLogger.info("Fallback: OpenAI gpt-4o-mini-transcribe (NOTE: timestamps will be estimated)...");
    const audioBuffer = await fs.readFile(audioPath);
    const file = await toFile(audioBuffer, "audio.mp3");

    const response = await openaiClient.audio.transcriptions.create({
      file,
      model: "gpt-4o-mini-transcribe",
      response_format: "json",
    }) as any;

    const text = response.text || "";
    if (text.trim()) {
      aiLogger.info("OpenAI transcription successful. Estimating timestamps based on speech pacing...");
      const sentences = text.split(/(?<=[.!?])\s+/).filter((s: string) => s.trim());
      
      const charsPerSecond = 12.5;
      let currentTime = 0;
      
      const segments = sentences.map((sentence: string) => {
        const duration = Math.max(1.5, sentence.length / charsPerSecond);
        const segment = {
          start: currentTime,
          end: currentTime + duration,
          text: sentence.trim(),
        };
        currentTime += duration + 0.3;
        return segment;
      }).filter((s: TranscriptSegment) => s.text.length > 0);
      
      aiLogger.info(`Estimated ${segments.length} transcript segments (timing is approximate)`);
      return segments;
    }
  } catch (error: any) {
    aiLogger.error("OpenAI transcription failed:", error?.message || error);
  }
  
  aiLogger.error("All transcription methods failed - no transcript available");
  return [];
}

/**
 * Detect language of transcript text using simple heuristics
 * Returns ISO 639-1 language code (en, hi, es, etc.)
 */
export function detectTranscriptLanguage(transcript: TranscriptSegment[]): string {
  if (!transcript || transcript.length === 0) return "en";
  
  const allText = transcript.map(t => t.text).join(" ");
  
  // Check for Devanagari script (Hindi, Sanskrit, Marathi, etc.)
  const devanagariPattern = /[\u0900-\u097F]/;
  if (devanagariPattern.test(allText)) {
    aiLogger.debug("Detected language: Hindi (Devanagari script)");
    return "hi";
  }
  
  // Check for Arabic script
  const arabicPattern = /[\u0600-\u06FF]/;
  if (arabicPattern.test(allText)) {
    aiLogger.debug("Detected language: Arabic");
    return "ar";
  }
  
  // Check for Chinese characters
  const chinesePattern = /[\u4E00-\u9FFF]/;
  if (chinesePattern.test(allText)) {
    aiLogger.debug("Detected language: Chinese");
    return "zh";
  }
  
  // Check for Japanese (Hiragana/Katakana)
  const japanesePattern = /[\u3040-\u30FF]/;
  if (japanesePattern.test(allText)) {
    aiLogger.debug("Detected language: Japanese");
    return "ja";
  }
  
  // Check for Korean (Hangul)
  const koreanPattern = /[\uAC00-\uD7AF]/;
  if (koreanPattern.test(allText)) {
    aiLogger.debug("Detected language: Korean");
    return "ko";
  }
  
  // Check for Cyrillic (Russian, etc.)
  const cyrillicPattern = /[\u0400-\u04FF]/;
  if (cyrillicPattern.test(allText)) {
    aiLogger.debug("Detected language: Russian/Cyrillic");
    return "ru";
  }
  
  // Default to English
  aiLogger.debug("Detected language: English (default)");
  return "en";
}

/**
 * Translate transcript segments to English using Gemini
 * Preserves original timestamps - only translates text
 * Returns new segments with translated text
 */
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
  
  // Prepare text for translation (batch all segments)
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
      () => geminiClient.models.generateContent({
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
    
    // Create new segments with translated text, preserving timestamps
    const translatedSegments: TranscriptSegment[] = transcript.map((seg, i) => ({
      start: seg.start,  // PRESERVE original timestamp
      end: seg.end,      // PRESERVE original timestamp
      text: translations[i] || seg.text,
    }));
    
    aiLogger.info(`Translation complete: ${translatedSegments.length} segments translated to English`);
    return translatedSegments;
  } catch (error) {
    aiLogger.error("Translation failed:", error);
    return transcript;
  }
}

/**
 * Parse whisper.cpp timestamp format "HH:MM:SS,mmm" to milliseconds
 * Handles variations: 1-3 digit ms, comma or dot separator, optional ms
 */
function parseWhisperTimestamp(timestamp: string): number | null {
  if (!timestamp) return null;
  
  // Format: "00:00:05,230" or "00:00:05.23" or "00:00:05" (1-3 digit ms, optional)
  const match = timestamp.match(/(\d{1,2}):(\d{2}):(\d{2})(?:[,.](\d{1,3}))?/);
  if (!match) return null;
  
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = parseInt(match[3], 10);
  
  // Handle 1-3 digit milliseconds, pad to 3 digits
  let ms = 0;
  if (match[4]) {
    const msStr = match[4].padEnd(3, "0");
    ms = parseInt(msStr, 10);
  }
  
  return (hours * 3600 + minutes * 60 + seconds) * 1000 + ms;
}

/**
 * Semantic Transcript Analysis - Core Intelligence Engine
 * Analyzes transcript to extract keywords, emotions, topics, and B-roll windows
 * This is the key to context-aware B-roll selection (like Opus Clip, Submagic)
 */
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

PERFORM COMPREHENSIVE ANALYSIS:

1. **MAIN TOPICS** - What are the core subjects discussed? List 3-7 main topics.

2. **OVERALL TONE** - Classify: educational, entertaining, inspirational, professional, casual, or serious

3. **KEY MOMENTS** - Identify 3-8 peak engagement moments where:
   - Important points are made
   - Emotional emphasis occurs
   - Key information is delivered

4. **B-ROLL WINDOWS** - CRITICAL: Identify specific moments where visual support would ENHANCE the content:
   - When speaker discusses abstract concepts
   - When examples/illustrations are mentioned
   - During transitions between topics
   - When specific objects/places/actions are referenced
   
   For each B-roll window, provide:
   - Exact start/end timestamps (must align with transcript segments)
   - Context (what's being discussed)
   - Specific, contextual search query that matches the ACTUAL content being discussed
   - Priority (high = essential visual support, medium = enhances understanding, low = optional decoration)
   - Reason why B-roll helps here

5. **EXTRACTED KEYWORDS** - List 10-20 important keywords/phrases from the content

6. **CONTENT SUMMARY** - 2-3 sentence summary of the video content

CRITICAL B-ROLL QUERY GUIDELINES:
- Queries must be SPECIFIC to what's being discussed in the transcript
- DO NOT use generic queries like "nature" or "business" 
- If speaker says "meditation brings peace of mind" → query: "peaceful meditation mindfulness calm person meditating"
- If speaker discusses "technology trends" → query: "modern technology innovation digital devices"
- If speaker mentions "cooking healthy meals" → query: "healthy cooking vegetables kitchen preparation"
- Match the genre and tone: ${videoContext?.genre || "general"} content should have ${videoContext?.tone || "appropriate"} imagery

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
  "brollWindows": [
    {
      "start": number,
      "end": number,
      "context": "what is being discussed",
      "suggestedQuery": "specific contextual search query",
      "priority": "low|medium|high",
      "reason": "why B-roll enhances this moment"
    }
  ],
  "extractedKeywords": ["keyword1", "keyword2", ...],
  "contentSummary": "2-3 sentence summary"
}`;

  try {
    const response = await withRetry(
      () => geminiClient.models.generateContent({
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

    const parsed = JSON.parse(jsonMatch[0]);
    
    // Validate and clamp B-roll windows
    const validatedBrollWindows = (parsed.brollWindows || [])
      .filter((b: any) => b.start !== undefined && b.suggestedQuery)
      .map((b: any) => ({
        start: Math.max(0, b.start),
        end: Math.min(duration, b.end || b.start + 4),
        context: b.context || "",
        suggestedQuery: b.suggestedQuery,
        priority: b.priority || "medium",
        reason: b.reason || "Enhance visual interest",
      }))
      .slice(0, 15); // Maximum 15 B-roll windows (1 per ~5-6 seconds of video)

    return {
      mainTopics: parsed.mainTopics || [],
      overallTone: parsed.overallTone || "casual",
      keyMoments: (parsed.keyMoments || []).map((k: any) => ({
        timestamp: k.timestamp || 0,
        description: k.description || "",
        importance: k.importance || "medium",
      })),
      brollWindows: validatedBrollWindows,
      extractedKeywords: parsed.extractedKeywords || [],
      contentSummary: parsed.contentSummary || "",
    };
  } catch (error) {
    aiLogger.error("Semantic analysis error:", error);
    return getDefaultSemanticAnalysis(transcript, duration);
  }
}

function getDefaultSemanticAnalysis(transcript: TranscriptSegment[], duration: number): SemanticAnalysis {
  // Extract basic keywords from transcript text
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

/**
 * Generate AI image using Gemini Imagen (gemini-2.5-flash-image)
 * Creates contextual images based on video content for B-roll
 * Returns base64 data URL of the generated image
 */
export async function generateAiImage(
  prompt: string,
  videoContext?: VideoContext
): Promise<{ base64Data: string; mimeType: string }> {
  try {
    // Enhance the prompt with video context for better relevance
    const contextualPrompt = videoContext 
      ? `Create a professional, high-quality image suitable for ${videoContext.genre} video content with a ${videoContext.tone} tone. 
         The image should be: ${prompt}
         Style: Clean, professional, suitable as B-roll footage. No text or watermarks.`
      : `Create a professional, high-quality image: ${prompt}
         Style: Clean, professional, suitable as B-roll footage. No text or watermarks.`;

    aiLogger.debug(`Generating AI image with prompt: ${contextualPrompt.substring(0, 100)}...`);
    
    const response = await withRetry(
      () => geminiClient.models.generateContent({
        model: "gemini-2.5-flash-image",
        contents: [
          {
            role: "user",
            parts: [{ text: contextualPrompt }],
          },
        ],
        config: {
          responseModalities: ["TEXT", "IMAGE"],
        },
      }),
      "generateAiImage",
      AI_RETRY_OPTIONS
    );

    const candidate = response.candidates?.[0];
    const imagePart = candidate?.content?.parts?.find(
      (part: any) => part.inlineData
    );

    if (!imagePart?.inlineData?.data) {
      const error = new Error("No image data in AI generation response - the model may have failed to generate an image");
      aiLogger.error("AI image generation failed: no image data in response");
      throw error;
    }

    const mimeType = imagePart.inlineData.mimeType || "image/png";
    aiLogger.debug(`AI image generated successfully: ${mimeType}`);
    
    return {
      base64Data: imagePart.inlineData.data,
      mimeType,
    };
  } catch (error) {
    aiLogger.error("AI image generation error:", error);
    throw error;
  }
}

/**
 * Generate multiple AI images for B-roll based on semantic analysis
 * Returns array of generated images with their prompts
 */
export interface GeneratedAiImage {
  prompt: string;
  base64Data: string;
  mimeType: string;
  startTime: number;
  endTime: number;
  duration: number;
  context: string;
}

export async function generateAiImagesForVideo(
  semanticAnalysis: SemanticAnalysis,
  videoContext?: VideoContext,
  maxImages: number = 3,
  videoDuration?: number
): Promise<GeneratedAiImage[]> {
  const generatedImages: GeneratedAiImage[] = [];
  
  // Get B-roll windows with valid timing data
  // RELAXED PRIORITY: Include all priorities (high/medium/low) to ensure coverage
  const validCandidates = semanticAnalysis.brollWindows
    .filter(w => {
      // Strict timing validation - require start, end, and positive duration
      if (typeof w.start !== "number" || typeof w.end !== "number") {
        aiLogger.warn(`Rejecting AI image candidate: missing start/end time - ${w.suggestedQuery}`);
        return false;
      }
      if (w.start < 0 || w.end <= w.start) {
        aiLogger.warn(`Rejecting AI image candidate: invalid timing (${w.start}s-${w.end}s) - ${w.suggestedQuery}`);
        return false;
      }
      return true;
    })
    .sort((a, b) => a.start - b.start);  // Sort by time for even distribution
  
  aiLogger.debug(`Valid B-roll candidates: ${validCandidates.length}/${semanticAnalysis.brollWindows.length}`);
  
  // If we have fewer candidates than maxImages, use all of them
  // Otherwise, select evenly distributed candidates across the video timeline
  let aiImageCandidates: typeof validCandidates;
  
  if (validCandidates.length <= maxImages) {
    aiImageCandidates = validCandidates;
  } else if (videoDuration && videoDuration > 0) {
    // Distribute evenly across the video timeline
    // Divide video into segments and pick best candidate from each segment
    const segmentDuration = videoDuration / maxImages;
    aiImageCandidates = [];
    
    for (let i = 0; i < maxImages; i++) {
      const segmentStart = i * segmentDuration;
      const segmentEnd = (i + 1) * segmentDuration;
      
      // Find candidates that fall within this segment
      const segmentCandidates = validCandidates.filter(c => 
        c.start >= segmentStart && c.start < segmentEnd
      );
      
      if (segmentCandidates.length > 0) {
        // Prefer high priority, then medium, then low
        const priorityOrder = { high: 0, medium: 1, low: 2 };
        const best = segmentCandidates.sort((a, b) => 
          priorityOrder[a.priority] - priorityOrder[b.priority]
        )[0];
        aiImageCandidates.push(best);
      } else {
        // No candidate in this segment, find nearest unused candidate
        const unusedCandidates = validCandidates.filter(c => 
          !aiImageCandidates.includes(c) && 
          Math.abs(c.start - (segmentStart + segmentDuration / 2)) < segmentDuration
        );
        if (unusedCandidates.length > 0) {
          aiImageCandidates.push(unusedCandidates[0]);
        }
      }
    }
    
    // Sort by time again after selection
    aiImageCandidates.sort((a, b) => a.start - b.start);
  } else {
    // Fallback: just take first maxImages sorted by priority
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    aiImageCandidates = validCandidates
      .sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority])
      .slice(0, maxImages);
  }

  aiLogger.debug(`AI Image candidates after selection: ${aiImageCandidates.length} (targeting ${maxImages})`);

  let failureCount = 0;
  const errors: Error[] = [];
  
  for (const candidate of aiImageCandidates) {
    try {
      // Create a specific, contextual prompt from the semantic analysis
      const imagePrompt = `${candidate.suggestedQuery}. Context: ${candidate.context}`;
      const result = await generateAiImage(imagePrompt, videoContext);
      
      // Return complete timing info from the ACTUAL candidate (not indexed from original)
      generatedImages.push({
        prompt: candidate.suggestedQuery,
        base64Data: result.base64Data,
        mimeType: result.mimeType,
        startTime: candidate.start,
        endTime: candidate.end,
        duration: Math.min(candidate.end - candidate.start, 5),
        context: candidate.context,
      });
    } catch (error) {
      failureCount++;
      const err = error instanceof Error ? error : new Error(String(error));
      errors.push(err);
      aiLogger.error(`Failed to generate AI image for: ${candidate.suggestedQuery}`, error);
      // Continue processing remaining candidates - partial success is acceptable
    }
  }

  if (failureCount > 0) {
    aiLogger.warn(`AI image generation completed with ${failureCount}/${aiImageCandidates.length} failures`);
  }
  
  // If ALL attempts failed, throw an aggregate error
  if (aiImageCandidates.length > 0 && generatedImages.length === 0) {
    const aggregateError = new Error(
      `All ${failureCount} AI image generation attempts failed. First error: ${errors[0]?.message || 'Unknown error'}`
    );
    aiLogger.error("All AI image generation attempts failed", aggregateError);
    throw aggregateError;
  }

  aiLogger.info(`Generated ${generatedImages.length} AI images for video`);
  return generatedImages;
}

export async function generateEditPlan(
  prompt: string,
  analysis: VideoAnalysis,
  transcript: TranscriptSegment[],
  semanticAnalysis?: SemanticAnalysis
): Promise<EditPlan> {
  const contextInfo = analysis.context;
  const editStyleGuidance = getEditStyleGuidance(contextInfo);
  
  // Use semantic analysis for intelligent B-roll placement
  const semanticBrollWindows = semanticAnalysis?.brollWindows || [];
  const extractedKeywords = semanticAnalysis?.extractedKeywords || [];
  const contentSummary = semanticAnalysis?.contentSummary || analysis.summary || "";
  
  const systemPrompt = `You are an expert professional video editor with years of experience in ${contextInfo?.genre || "video"} content. Your task is to create a precise, intelligent edit plan that maximizes viewer engagement while respecting the content's nature and purpose.

VIDEO CONTEXT:
- Genre: ${contextInfo?.genre || "general"}
- Tone: ${contextInfo?.tone || "casual"}
- Pacing: ${contextInfo?.pacing || "moderate"}
- Suggested Edit Style: ${contextInfo?.suggestedEditStyle || "moderate"}
- Target Audience: ${contextInfo?.targetAudience || "general viewers"}
${contextInfo?.regionalContext ? `- Regional Context: ${contextInfo.regionalContext}` : ""}

${editStyleGuidance}

AVAILABLE EDIT ACTIONS:

1. "cut" - Remove sections (audio AND video removed)
   - Use for: dead air, filler words, mistakes, boring tangents
   - Provide exact start/end times
   - Priority: high for dead silence, medium for low-value content

2. "keep" - Explicitly mark important segments to preserve
   - Use for: key points, engaging moments, essential context
   - Always ensure complete coverage of valuable content

3. "insert_stock" - OVERLAY B-roll stock footage (original audio CONTINUES)
   - This is a VISUAL OVERLAY - the speaker's voice keeps playing
   - Use to illustrate concepts, add visual interest during explanatory speech
   - NEVER place during important visual moments (demonstrations, facial expressions)
   - Provide: start time, duration (2-6 seconds), specific search query
   - Priority: high for abstract concepts, medium for examples, low for optional enhancement

4. NOTE: AI-generated images are AUTO-PLACED based on semantic transcript analysis.
   - Do NOT emit "insert_ai_image" actions - the system handles this automatically
   - AI images are placed at high-priority B-roll windows identified in semantic analysis
   - This ensures deterministic, contextually-matched imagery placement
   - Focus on "insert_stock" actions for additional B-roll needs beyond AI images

5. "add_caption" - Add captions for key dialogue
   - Use for: important quotes, key takeaways, memorable lines

6. "add_text_overlay" - Add emphasis text
   - Use sparingly for major points or transitions

TIMING RULES FOR B-ROLL:
- Minimum duration: 2 seconds (enough to register visually)
- Maximum duration: 6 seconds (avoid visual fatigue)
- Optimal duration: 3-4 seconds for most content
- Leave 2+ seconds between B-roll overlays
- B-roll MUST NOT overlap (they're visual overlays, not cuts)
- Place B-roll at the START of a spoken concept, not during key revelations

B-ROLL SEARCH QUERY GUIDELINES:
- Be specific and contextual: "meditation peaceful sunrise" not just "nature"
- Match the video's tone: ${contextInfo?.tone || "casual"}
- For ${contextInfo?.genre || "general"} content, prefer: ${getBrollStyleHint(contextInfo?.genre)}`;

  // Prioritize semantic B-roll windows over frame-based opportunities
  const brollOppsSummary = semanticBrollWindows.length > 0 
    ? semanticBrollWindows.map(b => 
        `  - ${b.start.toFixed(1)}s-${b.end.toFixed(1)}s: "${b.suggestedQuery}" (${b.priority} priority)
      Context: ${b.context}
      Reason: ${b.reason}`
      ).join("\n")
    : analysis.brollOpportunities?.slice(0, 5).map(b => 
        `  - ${b.start.toFixed(1)}s-${b.end.toFixed(1)}s: "${b.query}" (${b.priority} priority) - ${b.reason}`
      ).join("\n") || "No specific opportunities identified";

  const topicsSummary = analysis.topicSegments?.map(t =>
    `  - ${t.start.toFixed(1)}s-${t.end.toFixed(1)}s: ${t.topic} (${t.importance || "medium"} importance)`
  ).join("\n") || "No topic segments identified";

  // Build semantic context for better edit planning
  const semanticContext = semanticAnalysis ? `
SEMANTIC ANALYSIS (from transcript):
- Main Topics: ${semanticAnalysis.mainTopics.join(", ")}
- Overall Tone: ${semanticAnalysis.overallTone}
- Key Keywords: ${extractedKeywords.slice(0, 15).join(", ")}
- Content Summary: ${contentSummary}

KEY MOMENTS IDENTIFIED:
${semanticAnalysis.keyMoments.map(k => `  - ${k.timestamp.toFixed(1)}s: ${k.description} (${k.importance} importance)`).join("\n") || "None"}
` : "";

  const userPrompt = `User's editing instructions: "${prompt}"

VIDEO SUMMARY:
${contentSummary || analysis.summary || "No summary available"}
${semanticContext}

NARRATIVE STRUCTURE:
${analysis.narrativeStructure ? `
- Has intro: ${analysis.narrativeStructure.hasIntro ? `Yes, ends at ${analysis.narrativeStructure.introEnd}s` : "No"}
- Main content: ${analysis.narrativeStructure.mainContentStart || 0}s to ${analysis.narrativeStructure.mainContentEnd || analysis.duration}s
- Has outro: ${analysis.narrativeStructure.hasOutro ? `Yes, starts at ${analysis.narrativeStructure.outroStart}s` : "No"}
- Peak moments: ${analysis.narrativeStructure.peakMoments?.map(t => t.toFixed(1) + "s").join(", ") || "None identified"}
` : "Not analyzed"}

TOPIC SEGMENTS:
${topicsSummary}

CONTEXT-AWARE B-ROLL OPPORTUNITIES (from semantic transcript analysis):
${brollOppsSummary}

IMPORTANT: These B-roll queries are DERIVED FROM THE TRANSCRIPT CONTENT. 
Use these EXACT queries - they match what the speaker is actually discussing!
Do NOT substitute with generic queries.

SILENT SEGMENTS (candidates for cutting):
${analysis.silentSegments?.map(s => `  - ${s.start.toFixed(1)}s to ${s.end.toFixed(1)}s`).join("\n") || "None detected"}

TRANSCRIPT WITH CONTEXT:
${transcript.slice(0, 50).map(t => `[${t.start.toFixed(1)}s-${t.end.toFixed(1)}s]: ${t.text}`).join("\n")}
${transcript.length > 50 ? `\n... (${transcript.length - 50} more segments)` : ""}

Total video duration: ${analysis.duration.toFixed(1)} seconds

CREATE YOUR EDIT PLAN - CRITICAL INSTRUCTIONS:
1. USE the pre-identified B-roll opportunities - they are contextually matched to transcript
2. For each insert_stock action, include "transcriptContext" field with what speaker is saying
3. Stock queries MUST be specific to content (e.g., "peaceful meditation mindfulness" NOT just "nature")
4. Ensure B-roll doesn't overlap and has 3+ seconds spacing between clips
5. Cut silent/boring sections while preserving narrative flow
6. Add captions for key moments identified in semantic analysis

QUALITY HEURISTICS:
- Score each edit action for relevance (how well it matches content context)
- Prioritize B-roll at semantic transition points (when topic changes)
- Use AI images for abstract/spiritual/metaphorical concepts
- Use stock footage for concrete/literal visual needs
- Never place overlays during speaker's key emotional moments
- Balance visual variety: don't use same overlay type consecutively

Respond with a JSON object only (no markdown):
{
  "actions": [
    {"type": "keep", "start": 0, "end": number, "reason": "string", "priority": "high/medium/low"},
    {"type": "cut", "start": number, "end": number, "reason": "string"},
    {"type": "insert_stock", "start": number, "duration": number, "stockQuery": "specific descriptive query", "reason": "string", "priority": "high/medium/low"}
  ],
  "stockQueries": ["list of unique stock media searches needed"],
  "keyPoints": ["main topics and highlights from the video"],
  "estimatedDuration": number,
  "editingStrategy": {
    "approach": "description of overall editing approach",
    "focusAreas": ["areas of focus"],
    "avoidAreas": ["things to avoid based on content type"]
  },
  "qualityScore": {
    "pacing": "slow/moderate/fast - matches content type",
    "brollRelevance": "high/medium/low - how well visuals match speech",
    "narrativeFlow": "high/medium/low - how well edits preserve story"
  }
}`;

  const response = await withRetry(
    () => geminiClient.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [{ text: systemPrompt + "\n\n" + userPrompt }],
        },
      ],
    }),
    "generateEditPlan",
    AI_RETRY_OPTIONS
  );

  const text = response.text || "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  
  const fallbackPlan = (): EditPlan => {
    const keepAction: EditAction = {
      type: "keep",
      start: 0,
      end: analysis.duration,
      reason: "Keep entire video (failed to generate specific edits)",
    };
    return {
      actions: [keepAction],
      estimatedDuration: analysis.duration,
    };
  };
  
  if (!jsonMatch) {
    aiLogger.warn("No JSON found in AI response for edit plan");
    return fallbackPlan();
  }

  let parsed: any;
  try {
    parsed = JSON.parse(jsonMatch[0]);
    const validated = EditPlanResponseSchema.safeParse(parsed);
    if (!validated.success) {
      aiLogger.warn("Edit plan validation warning:", validated.error);
    }
  } catch (parseError) {
    aiLogger.warn("JSON parse error in edit plan:", parseError);
    return fallbackPlan();
  }

  if (!parsed.actions || !Array.isArray(parsed.actions)) {
    aiLogger.warn("No valid actions array in AI response");
    return fallbackPlan();
  }

  const actions: EditAction[] = [];
  for (const a of parsed.actions) {
    const actionValidation = EditActionSchema.safeParse(a);
    if (actionValidation.success) {
      const validAction = actionValidation.data as any;
      if ('start' in validAction && validAction.start !== undefined && validAction.start < 0) {
        validAction.start = 0;
      }
      if ('end' in validAction && validAction.end !== undefined && validAction.end > analysis.duration) {
        validAction.end = analysis.duration;
      }
      actions.push(validAction as EditAction);
    } else {
      aiLogger.warn("Skipping invalid action:", a, actionValidation.error);
    }
  }

  const hasKeepActions = actions.some((a) => a.type === "keep");
  if (!hasKeepActions) {
    const sortedCuts = actions
      .filter((a) => a.type === "cut" && a.start !== undefined && a.end !== undefined)
      .sort((a, b) => (a.start || 0) - (b.start || 0));

    const keepActions: EditAction[] = [];
    let currentTime = 0;

    for (const cut of sortedCuts) {
      if (cut.start! > currentTime) {
        keepActions.push({
          type: "keep",
          start: currentTime,
          end: cut.start!,
          reason: "Content between cuts",
        });
      }
      currentTime = cut.end!;
    }

    if (currentTime < analysis.duration) {
      keepActions.push({
        type: "keep",
        start: currentTime,
        end: analysis.duration,
        reason: "Content after last cut",
      });
    }

    if (keepActions.length === 0) {
      keepActions.push({
        type: "keep",
        start: 0,
        end: analysis.duration,
        reason: "Keep entire video",
      });
    }

    actions.push(...keepActions);
  }

  const validatedActions = validateAndFixBrollActions(actions, analysis.duration);

  return {
    actions: validatedActions,
    stockQueries: parsed.stockQueries || [],
    keyPoints: parsed.keyPoints || [],
    estimatedDuration: parsed.estimatedDuration || analysis.duration,
    editingStrategy: parsed.editingStrategy || undefined,
  };
}
