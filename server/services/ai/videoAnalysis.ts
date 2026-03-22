import { promises as fs } from "fs";
import * as path from "path";
import { z } from "zod";
import { withRetry, AI_RETRY_OPTIONS } from "../../utils/retry";
import { createLogger } from "../../utils/logger";
import { getVideoAnalysisGeminiClient } from "./clients";
import { AI_CONFIG } from "../../config/ai";
import { createUserContent, createPartFromUri } from "@google/genai";
import {
  normalizePriority,
  normalizeEnergyLevel,
  normalizeSpeakingPace,
  normalizeVisualImportance,
  normalizeKeyMomentType,
} from "./normalization";
import type {
  VideoAnalysis,
  FrameAnalysis,
  TranscriptSegment,
  VideoContext,
  TopicSegment,
  SemanticAnalysis,
  SceneSegment,
  EmotionFlowPoint,
  SpeakerSegment,
  KeyMoment,
} from "@shared/schema";

const aiLogger = createLogger("ai-service");

const FrameAnalysisSchema = z.object({
  timestamp: z.number().optional(),
  description: z.string().optional().default(""),
  keyMoment: z.boolean().optional().default(false),
  suggestedStockQuery: z.string().nullable().optional(),
  energyLevel: z.enum(["low", "medium", "high"])
    .or(z.string().transform(normalizeEnergyLevel)).optional(),
  speakingPace: z.enum(["slow", "normal", "fast"])
    .or(z.string().transform(normalizeSpeakingPace)).optional(),
});

// All valid genres - add new ones here as AI suggests them
const VALID_GENRES = [
  "tutorial", "vlog", "interview", "presentation", "documentary",
  "spiritual", "educational", "entertainment", "tech", "lifestyle",
  "gaming", "music", "news", "review", "motivational", "advertisement",
  "promotional", "commercial", "product", "finance", "business", 
  "cooking", "fitness", "travel", "comedy", "drama", "other"
] as const;

// Normalize genre to a valid value (handles AI variations)
function normalizeGenre(genre: string): typeof VALID_GENRES[number] {
  const normalized = genre.toLowerCase().trim();
  
  // Check if already valid
  if (VALID_GENRES.includes(normalized as any)) {
    return normalized as typeof VALID_GENRES[number];
  }
  
  // Map common variations
  const genreMap: Record<string, typeof VALID_GENRES[number]> = {
    "ad": "advertisement",
    "ads": "advertisement",
    "promo": "promotional",
    "commercial": "advertisement",
    "infomercial": "advertisement",
    "financial": "finance",
    "investing": "finance",
    "money": "finance",
    "how-to": "tutorial",
    "howto": "tutorial",
    "guide": "tutorial",
    "explainer": "educational",
    "informational": "educational",
    "fun": "entertainment",
    "funny": "comedy",
    "humorous": "comedy",
    "sports": "lifestyle",
    "health": "fitness",
    "food": "cooking",
    "recipe": "cooking",
    "blog": "vlog",
    "podcast": "interview",
    "talk": "interview",
    "chat": "vlog",
  };
  
  if (genreMap[normalized]) {
    return genreMap[normalized];
  }
  
  // Default to "other" for truly unknown genres
  return "other";
}

// Valid tone values
const VALID_TONES = ["serious", "casual", "professional", "humorous", "inspirational", "dramatic", "calm"] as const;

// Normalize tone (handles AI variations like "Thoughtful", "Engaging", etc.)
function normalizeTone(tone: string): typeof VALID_TONES[number] {
  const normalized = tone.toLowerCase().trim().split(/[\s(,]/)[0]; // Take first word only
  
  if (VALID_TONES.includes(normalized as any)) {
    return normalized as typeof VALID_TONES[number];
  }
  
  const toneMap: Record<string, typeof VALID_TONES[number]> = {
    "thoughtful": "serious",
    "reflective": "serious",
    "formal": "professional",
    "engaging": "casual",
    "friendly": "casual",
    "funny": "humorous",
    "comedic": "humorous",
    "motivational": "inspirational",
    "uplifting": "inspirational",
    "intense": "dramatic",
    "emotional": "dramatic",
    "relaxed": "calm",
    "peaceful": "calm",
    "soothing": "calm",
    "informative": "professional",
    "educational": "professional",
  };
  
  return toneMap[normalized] || "casual";
}

// Valid pacing values  
const VALID_PACING = ["slow", "moderate", "fast", "dynamic"] as const;

// Normalize pacing (handles capitalization and variations)
function normalizePacing(pacing: string): typeof VALID_PACING[number] {
  const normalized = pacing.toLowerCase().trim().split(/[\s(,]/)[0];
  
  if (VALID_PACING.includes(normalized as any)) {
    return normalized as typeof VALID_PACING[number];
  }
  
  const pacingMap: Record<string, typeof VALID_PACING[number]> = {
    "quick": "fast",
    "rapid": "fast",
    "energetic": "fast",
    "relaxed": "slow",
    "leisurely": "slow",
    "medium": "moderate",
    "normal": "moderate",
    "varied": "dynamic",
    "variable": "dynamic",
    "changing": "dynamic",
  };
  
  return pacingMap[normalized] || "moderate";
}

// Valid edit style values
const VALID_EDIT_STYLES = ["minimal", "moderate", "dynamic", "cinematic", "fast-paced"] as const;

// Normalize suggestedEditStyle (AI often adds explanations like "Dynamic (to maintain engagement)")
function normalizeEditStyle(style: string): typeof VALID_EDIT_STYLES[number] {
  const normalized = style.toLowerCase().trim().split(/[\s(,]/)[0];
  
  if (VALID_EDIT_STYLES.includes(normalized as any)) {
    return normalized as typeof VALID_EDIT_STYLES[number];
  }
  
  const styleMap: Record<string, typeof VALID_EDIT_STYLES[number]> = {
    "simple": "minimal",
    "basic": "minimal",
    "subtle": "minimal",
    "standard": "moderate",
    "balanced": "moderate",
    "energetic": "dynamic",
    "engaging": "dynamic",
    "active": "dynamic",
    "movie": "cinematic",
    "film": "cinematic",
    "professional": "cinematic",
    "quick": "fast-paced",
    "rapid": "fast-paced",
    "fast": "fast-paced",
  };
  
  return styleMap[normalized] || "moderate";
}

const VideoContextSchema = z.object({
  genre: z.enum(VALID_GENRES).or(z.string().transform(normalizeGenre)),
  subGenre: z.string().optional(),
  targetAudience: z.string().optional(),
  tone: z.enum(VALID_TONES).or(z.string().transform(normalizeTone)),
  pacing: z.enum(VALID_PACING).or(z.string().transform(normalizePacing)),
  visualStyle: z.string().optional(),
  suggestedEditStyle: z.enum(VALID_EDIT_STYLES).or(z.string().transform(normalizeEditStyle)),
  regionalContext: z.string().nullish(),
  languageDetected: z.string().nullish(),
});

const TopicSegmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  topic: z.string(),
  importance: z.enum(["low", "medium", "high"])
    .or(z.string().transform(normalizePriority)).optional(),
  suggestedBrollWindow: z.boolean().optional(),
});

const BrollOpportunitySchema = z.object({
  start: z.number(),
  end: z.number(),
  suggestedDuration: z.number(),
  query: z.string(),
  priority: z.enum(["low", "medium", "high"])
    .or(z.string().transform(normalizePriority)),
  reason: z.string(),
});

const SceneSegmentResponseSchema = z.object({
  start: z.number(),
  end: z.number(),
  sceneType: z.string(),
  visualDescription: z.string().optional().default(""),
  emotionalTone: z.string(),
  speakerId: z.string().nullish(),
  visualImportance: z.enum(["high", "medium", "low"])
    .or(z.string().transform(normalizeVisualImportance)),
});

const EmotionFlowPointResponseSchema = z.object({
  timestamp: z.number(),
  emotion: z.string(),
  intensity: z.number().min(0).max(100),
});

const SpeakerSegmentResponseSchema = z.object({
  start: z.number(),
  end: z.number(),
  speakerId: z.string().nullish().transform(v => v ?? "speaker_1"),
  speakerLabel: z.string().optional(),
});

const KeyMomentResponseSchema = z.object({
  timestamp: z.number(),
  type: z.enum(["hook", "climax", "callToAction", "keyPoint", "transition"])
    .or(z.string().transform(normalizeKeyMomentType)),
  description: z.string(),
  importance: z.enum(["high", "medium", "low"])
    .or(z.string().transform(normalizeVisualImportance)),
  hookScore: z.number().min(0).max(100).nullish(),
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
  scenes: z.array(SceneSegmentResponseSchema).optional(),
  emotionFlow: z.array(EmotionFlowPointResponseSchema).optional(),
  speakers: z.array(SpeakerSegmentResponseSchema).optional(),
  keyMoments: z.array(KeyMomentResponseSchema).optional(),
});

type RawFrameAnalysis = z.infer<typeof FrameAnalysisSchema>;
type RawTopicSegment = z.infer<typeof TopicSegmentSchema>;
type RawBrollOpportunity = z.infer<typeof BrollOpportunitySchema>;
type RawSceneSegment = z.infer<typeof SceneSegmentResponseSchema>;
type RawEmotionFlowPoint = z.infer<typeof EmotionFlowPointResponseSchema>;
type RawSpeakerSegment = z.infer<typeof SpeakerSegmentResponseSchema>;
type RawKeyMomentResponse = z.infer<typeof KeyMomentResponseSchema>;
type VideoAnalysisResponse = z.infer<typeof VideoAnalysisResponseSchema>;

async function encodeImageToBase64(imagePath: string): Promise<string> {
  return fs.readFile(imagePath, { encoding: "base64" });
}

// ============================================================================
// FULL VIDEO WATCHING - AI actually watches the entire video file
// ============================================================================

const MAX_VIDEO_SIZE_MB = 500; // Max size for video upload (Gemini supports up to 2GB)
const VIDEO_PROCESSING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max wait for processing
const VIDEO_PROCESSING_POLL_MS = 2000; // Poll every 2 seconds

interface FullVideoAnalysisResult extends VideoAnalysis {
  analysisMethod: "full_video_watch" | "frame_extraction";
  motionAnalysis?: {
    hasSignificantMotion: boolean;
    motionIntensity: "low" | "medium" | "high";
    actionSequences: { start: number; end: number; description: string }[];
  };
  transitionAnalysis?: {
    detectedTransitions: { timestamp: number; type: string; description: string }[];
    suggestedTransitionPoints: number[];
  };
  audioVisualSync?: {
    syncQuality: "excellent" | "good" | "fair" | "poor";
    outOfSyncMoments: { timestamp: number; issue: string }[];
  };
  pacingAnalysis?: {
    overallPacing: "slow" | "moderate" | "fast" | "dynamic";
    pacingVariation: number; // 0-100
    suggestedPacingAdjustments: { timestamp: number; suggestion: string }[];
  };
}

async function waitForFileProcessing(
  fileName: string,
  timeoutMs: number = VIDEO_PROCESSING_TIMEOUT_MS
): Promise<{ uri: string; mimeType: string; state: string }> {
  const gemini = getVideoAnalysisGeminiClient();
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    const fileInfo = await gemini.files.get({ name: fileName });
    
    if (fileInfo.state === "ACTIVE") {
      aiLogger.info(`Video file processing complete: ${fileName}`);
      return {
        uri: fileInfo.uri || "",
        mimeType: fileInfo.mimeType || "video/mp4",
        state: fileInfo.state,
      };
    }
    
    if (fileInfo.state === "FAILED") {
      throw new Error(`Video file processing failed: ${fileName}`);
    }
    
    aiLogger.debug(`Video file still processing: ${fileName} (state: ${fileInfo.state})`);
    await new Promise(resolve => setTimeout(resolve, VIDEO_PROCESSING_POLL_MS));
  }
  
  throw new Error(`Video file processing timed out after ${timeoutMs}ms`);
}

function getMimeType(videoPath: string): string {
  const ext = path.extname(videoPath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".mp4": "video/mp4",
    ".mov": "video/mov",
    ".avi": "video/avi",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".flv": "video/x-flv",
    ".wmv": "video/x-ms-wmv",
    ".3gp": "video/3gpp",
    ".mpeg": "video/mpeg",
    ".mpg": "video/mpeg",
  };
  return mimeTypes[ext] || "video/mp4";
}

async function getFileSizeMB(filePath: string): Promise<number> {
  const stats = await fs.stat(filePath);
  return stats.size / (1024 * 1024);
}

const FULL_VIDEO_ANALYSIS_PROMPT = `You are an expert video analyst and professional video editor with the ability to WATCH ENTIRE VIDEOS.

Unlike frame-by-frame analysis, you can see:
- ACTUAL MOTION and actions as they happen
- REAL TRANSITIONS between scenes
- PACING and rhythm of content delivery
- SPEAKER GESTURES and body language in motion
- AUDIO-VISUAL SYNCHRONIZATION
- EMOTIONAL FLOW as it naturally develops

PERFORM AN ULTRA-COMPREHENSIVE DEEP ANALYSIS:

1. VIDEO CONTEXT CLASSIFICATION
- Genre: tutorial, vlog, interview, presentation, documentary, spiritual, educational, entertainment, tech, lifestyle, gaming, music, news, review, motivational, advertisement, promotional, finance, business, cooking, fitness, travel, comedy, drama, or other
- Tone: serious, casual, professional, humorous, inspirational, dramatic, or calm
- Pacing: slow, moderate, fast, or dynamic
- Visual style description
- Target audience
- Language detected

2. MOTION ANALYSIS (NEW - Only possible with full video)
Analyze actual movement patterns:
- Overall motion intensity (low/medium/high)
- Action sequences with timestamps
- Camera movements (pan, zoom, static, handheld)
- Subject movements and gestures

3. SCENE DETECTION (Enhanced with motion awareness)
Identify scenes based on:
- Location/background changes
- Topic/activity shifts  
- Speaker changes
- Visual mood/lighting changes
- Motion pattern changes

For each scene:
- Start/end timestamps (MM:SS format for precision)
- Scene type: talking_head, demonstration, b_roll, text_slide, transition, intro, outro, action_sequence
- Visual description including motion
- Emotional tone
- Speaker ID if visible
- Visual Importance: HIGH (must see), MEDIUM (adds value), LOW (can overlay B-roll)

4. TRANSITION ANALYSIS (NEW - Only possible with full video)
Detect and analyze transitions:
- Cut points and their effectiveness
- Natural transition moments between topics
- Suggested transition points for editing
- Transition types used (cut, fade, dissolve, etc.)

5. EMOTION FLOW TRACKING (Enhanced)
Track emotional energy changes with motion context:
- Timestamp, emotion, intensity (0-100)
- Note when emotional shifts are emphasized by motion/gestures

6. PACING ANALYSIS (NEW - Only possible with full video)
Analyze the rhythm and flow:
- Overall pacing assessment
- Pacing variation score (0-100, higher = more dynamic)
- Sections that feel too slow
- Sections that feel too rushed
- Suggested pacing adjustments

7. AUDIO-VISUAL SYNC QUALITY (NEW - Only possible with full video)
Assess synchronization:
- Overall sync quality: excellent, good, fair, poor
- Out-of-sync moments if any

8. SPEAKER DETECTION
Identify speakers with their visual presence:
- Speaker ID, start/end times
- Labels if identifiable (host, guest, narrator)
- Speaking style observations

9. KEY MOMENTS IDENTIFICATION
Identify crucial editing moments:
- HOOKS (first 3-10 seconds): Score 0-100
- CLIMAXES: Peak engagement moments
- CALL-TO-ACTIONS: When speaker asks for action
- KEY POINTS: Important statements/demonstrations  
- TRANSITIONS: Natural break points

10. NARRATIVE STRUCTURE
- Introduction boundaries
- Main content boundaries
- Outro/conclusion section
- Peak moments of engagement

11. B-ROLL OPPORTUNITIES (Enhanced with motion awareness)
Identify where stock footage would enhance:
- Exact timestamp ranges
- Optimal duration
- ULTRA-SPECIFIC search queries
- Priority (high/medium/low)
- Reason for B-roll
- Note if motion-based content would be better than static images

Respond in JSON format only (no markdown):
{
  "frames": [
    {
      "timestamp": number (seconds),
      "description": "detailed description including motion",
      "keyMoment": boolean,
      "suggestedStockQuery": "specific search query or null",
      "energyLevel": "low|medium|high",
      "speakingPace": "slow|normal|fast"
    }
  ],
  "summary": "comprehensive summary of video content, purpose, and style",
  "context": {
    "genre": "string",
    "subGenre": "string or null",
    "targetAudience": "string",
    "tone": "serious|casual|professional|humorous|inspirational|dramatic|calm",
    "pacing": "slow|moderate|fast|dynamic",
    "visualStyle": "description",
    "suggestedEditStyle": "minimal|moderate|dynamic|cinematic|fast-paced",
    "regionalContext": "string or null",
    "languageDetected": "string"
  },
  "motionAnalysis": {
    "hasSignificantMotion": boolean,
    "motionIntensity": "low|medium|high",
    "actionSequences": [
      {"start": number, "end": number, "description": "what's happening"}
    ]
  },
  "transitionAnalysis": {
    "detectedTransitions": [
      {"timestamp": number, "type": "cut|fade|dissolve|other", "description": "string"}
    ],
    "suggestedTransitionPoints": [number array of timestamps]
  },
  "pacingAnalysis": {
    "overallPacing": "slow|moderate|fast|dynamic",
    "pacingVariation": number (0-100),
    "suggestedPacingAdjustments": [
      {"timestamp": number, "suggestion": "speed up|slow down|add pause|add emphasis"}
    ]
  },
  "audioVisualSync": {
    "syncQuality": "excellent|good|fair|poor",
    "outOfSyncMoments": [{"timestamp": number, "issue": "description"}]
  },
  "scenes": [
    {
      "start": number,
      "end": number,
      "sceneType": "talking_head|demonstration|b_roll|text_slide|transition|intro|outro|action_sequence",
      "visualDescription": "what the scene shows including motion",
      "emotionalTone": "calm|excited|serious|thoughtful|humorous|inspirational|tense|relaxed",
      "speakerId": "speaker_1|speaker_2|etc or null",
      "visualImportance": "high|medium|low"
    }
  ],
  "emotionFlow": [
    {"timestamp": number, "emotion": "string", "intensity": number (0-100)}
  ],
  "speakers": [
    {"start": number, "end": number, "speakerId": "string", "speakerLabel": "string or null"}
  ],
  "keyMoments": [
    {
      "timestamp": number,
      "type": "hook|climax|callToAction|keyPoint|transition",
      "description": "what makes this moment special",
      "importance": "high|medium|low",
      "hookScore": number (0-100, only for type=hook)
    }
  ],
  "topicSegments": [
    {"start": number, "end": number, "topic": "string", "importance": "low|medium|high", "suggestedBrollWindow": boolean}
  ],
  "narrativeStructure": {
    "hasIntro": boolean,
    "introEnd": number or null,
    "hasOutro": boolean,
    "outroStart": number or null,
    "mainContentStart": number,
    "mainContentEnd": number,
    "peakMoments": [numbers]
  },
  "brollOpportunities": [
    {
      "start": number,
      "end": number,
      "suggestedDuration": number,
      "query": "ULTRA-SPECIFIC search query",
      "priority": "high|medium|low",
      "reason": "why B-roll would help",
      "preferVideo": boolean (true if motion-based content preferred)
    }
  ]
}`;

export async function watchFullVideo(
  videoPath: string,
  duration: number,
  silentSegments: { start: number; end: number }[] = []
): Promise<FullVideoAnalysisResult> {
  const gemini = getVideoAnalysisGeminiClient();
  
  // Check file size
  const fileSizeMB = await getFileSizeMB(videoPath);
  aiLogger.info(`Full video watching: ${path.basename(videoPath)} (${fileSizeMB.toFixed(1)}MB)`);
  
  if (fileSizeMB > MAX_VIDEO_SIZE_MB) {
    aiLogger.warn(`Video too large for full watching (${fileSizeMB.toFixed(1)}MB > ${MAX_VIDEO_SIZE_MB}MB), falling back to frame extraction`);
    throw new Error(`Video file too large: ${fileSizeMB.toFixed(1)}MB exceeds ${MAX_VIDEO_SIZE_MB}MB limit`);
  }
  
  const mimeType = getMimeType(videoPath);
  
  aiLogger.info("Uploading video to Gemini for full analysis...");
  const uploadStartTime = Date.now();
  
  // Upload the video file
  const uploadResponse = await gemini.files.upload({
    file: videoPath,
    config: { mimeType },
  });
  
  const uploadTime = ((Date.now() - uploadStartTime) / 1000).toFixed(1);
  aiLogger.info(`Video uploaded in ${uploadTime}s, waiting for processing...`);
  
  // Wait for processing to complete
  const fileInfo = await waitForFileProcessing(uploadResponse.name || "");
  
  aiLogger.info("Video processed, AI is now WATCHING the full video...");
  const analysisStartTime = Date.now();
  
  // Build the prompt with context
  const promptWithContext = `${FULL_VIDEO_ANALYSIS_PROMPT}

VIDEO METADATA:
- Duration: ${duration.toFixed(1)} seconds
- Silent segments detected: ${JSON.stringify(silentSegments)}

Watch this video carefully and provide your comprehensive analysis:`;
  
  // Generate content with the video file
  const response = await withRetry(
    () => gemini.models.generateContent({
      model: AI_CONFIG.models.fullVideoWatch,
      contents: createUserContent([
        createPartFromUri(fileInfo.uri, fileInfo.mimeType),
        promptWithContext,
      ]),
    }),
    "watchFullVideo",
    { ...AI_RETRY_OPTIONS, maxRetries: 2 } // Fewer retries for video analysis
  );
  
  const analysisTime = ((Date.now() - analysisStartTime) / 1000).toFixed(1);
  aiLogger.info(`Full video analysis complete in ${analysisTime}s`);
  
  // Clean up uploaded file (async, don't wait)
  gemini.files.delete({ name: uploadResponse.name || "" }).catch(err => {
    aiLogger.debug(`Failed to delete uploaded video file: ${err.message}`);
  });
  
  const text = response.text || "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  
  if (!jsonMatch) {
    aiLogger.warn("No JSON found in full video analysis response");
    throw new Error("Failed to parse full video analysis response");
  }
  
  let parsed: any;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (parseError) {
    aiLogger.warn("JSON parse error in full video analysis:", parseError);
    throw new Error("Failed to parse full video analysis JSON");
  }
  
  // Build the result with all the enhanced analysis
  const result: FullVideoAnalysisResult = {
    analysisMethod: "full_video_watch",
    frames: (parsed.frames || []).map((f: any, index: number) => ({
      timestamp: f.timestamp ?? (duration / 10) * (index + 1),
      description: f.description ?? "",
      keyMoment: f.keyMoment ?? false,
      suggestedStockQuery: f.suggestedStockQuery ?? undefined,
      energyLevel: normalizeEnergyLevel(f.energyLevel ?? "medium"),
      speakingPace: normalizeSpeakingPace(f.speakingPace ?? "normal"),
    })),
    summary: parsed.summary || "Full video analysis completed",
    context: parsed.context ? {
      genre: normalizeGenre(parsed.context.genre ?? "other"),
      subGenre: parsed.context.subGenre ?? undefined,
      targetAudience: parsed.context.targetAudience ?? undefined,
      tone: normalizeTone(parsed.context.tone ?? "casual"),
      pacing: normalizePacing(parsed.context.pacing ?? "moderate"),
      visualStyle: parsed.context.visualStyle ?? undefined,
      suggestedEditStyle: parsed.context.suggestedEditStyle ?? "moderate",
      regionalContext: parsed.context.regionalContext ?? undefined,
      languageDetected: parsed.context.languageDetected ?? undefined,
    } : undefined,
    motionAnalysis: parsed.motionAnalysis ? {
      hasSignificantMotion: parsed.motionAnalysis.hasSignificantMotion ?? false,
      motionIntensity: parsed.motionAnalysis.motionIntensity ?? "low",
      actionSequences: (parsed.motionAnalysis.actionSequences || []).map((a: any) => ({
        start: a.start ?? 0,
        end: a.end ?? 0,
        description: a.description ?? "",
      })),
    } : undefined,
    transitionAnalysis: parsed.transitionAnalysis ? {
      detectedTransitions: (parsed.transitionAnalysis.detectedTransitions || []).map((t: any) => ({
        timestamp: t.timestamp ?? 0,
        type: t.type ?? "cut",
        description: t.description ?? "",
      })),
      suggestedTransitionPoints: parsed.transitionAnalysis.suggestedTransitionPoints || [],
    } : undefined,
    audioVisualSync: parsed.audioVisualSync ? {
      syncQuality: parsed.audioVisualSync.syncQuality ?? "good",
      outOfSyncMoments: (parsed.audioVisualSync.outOfSyncMoments || []).map((m: any) => ({
        timestamp: m.timestamp ?? 0,
        issue: m.issue ?? "",
      })),
    } : undefined,
    pacingAnalysis: parsed.pacingAnalysis ? {
      overallPacing: parsed.pacingAnalysis.overallPacing ?? "moderate",
      pacingVariation: Math.min(100, Math.max(0, parsed.pacingAnalysis.pacingVariation ?? 50)),
      suggestedPacingAdjustments: (parsed.pacingAnalysis.suggestedPacingAdjustments || []).map((p: any) => ({
        timestamp: p.timestamp ?? 0,
        suggestion: p.suggestion ?? "",
      })),
    } : undefined,
    scenes: (parsed.scenes || []).map((s: any) => ({
      start: s.start ?? 0,
      end: s.end ?? duration,
      sceneType: s.sceneType ?? "talking_head",
      visualDescription: s.visualDescription ?? "",
      emotionalTone: s.emotionalTone ?? "calm",
      speakerId: s.speakerId ?? undefined,
      visualImportance: normalizeVisualImportance(s.visualImportance ?? "medium"),
    })),
    emotionFlow: (parsed.emotionFlow || []).map((e: any) => ({
      timestamp: e.timestamp ?? 0,
      emotion: e.emotion ?? "neutral",
      intensity: Math.min(100, Math.max(0, e.intensity ?? 50)),
    })),
    speakers: (parsed.speakers || []).map((s: any) => ({
      start: s.start ?? 0,
      end: s.end ?? duration,
      speakerId: s.speakerId ?? "speaker_1",
      speakerLabel: s.speakerLabel ?? undefined,
    })),
    keyMoments: (parsed.keyMoments || []).map((k: any) => ({
      timestamp: k.timestamp ?? 0,
      type: normalizeKeyMomentType(k.type ?? "keyPoint"),
      description: k.description ?? "",
      importance: normalizePriority(k.importance ?? "medium"),
      hookScore: k.hookScore ?? undefined,
    })),
    topicSegments: (parsed.topicSegments || []).map((t: any) => ({
      start: t.start ?? 0,
      end: t.end ?? duration,
      topic: t.topic ?? "Unknown",
      importance: normalizePriority(t.importance ?? "medium"),
      suggestedBrollWindow: t.suggestedBrollWindow ?? false,
    })),
    narrativeStructure: parsed.narrativeStructure ? {
      introEnd: parsed.narrativeStructure.introEnd ?? undefined,
      outroStart: parsed.narrativeStructure.outroStart ?? undefined,
      hasIntro: parsed.narrativeStructure.hasIntro ?? undefined,
      hasOutro: parsed.narrativeStructure.hasOutro ?? undefined,
      mainContentStart: parsed.narrativeStructure.mainContentStart ?? undefined,
      mainContentEnd: parsed.narrativeStructure.mainContentEnd ?? undefined,
      peakMoments: parsed.narrativeStructure.peakMoments ?? undefined,
    } : undefined,
    silentSegments,
    brollOpportunities: (parsed.brollOpportunities || []).map((b: any) => ({
      start: b.start ?? 0,
      end: b.end ?? 0,
      suggestedDuration: b.suggestedDuration ?? 3,
      query: b.query ?? "",
      priority: normalizePriority(b.priority ?? "medium"),
      reason: b.reason ?? "",
    })),
    duration,
  };
  
  aiLogger.info(`Full video watch complete: ${result.scenes?.length || 0} scenes, ${result.keyMoments?.length || 0} key moments, motion: ${result.motionAnalysis?.motionIntensity || "unknown"}`);
  
  return result;
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

PERFORM A COMPREHENSIVE DEEP ANALYSIS:

1. VIDEO CONTEXT CLASSIFICATION
Determine the video's genre, tone, target audience, and optimal editing approach:
- Genre: tutorial, vlog, interview, presentation, documentary, spiritual, educational, entertainment, tech, lifestyle, gaming, music, news, review, motivational, advertisement, promotional, finance, business, cooking, fitness, travel, comedy, drama, or other
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

3. SCENE DETECTION (NEW - CRITICAL)
Group consecutive frames into DISTINCT SCENES. A scene changes when:
- Location/background changes significantly
- Topic/activity shifts
- Speaker changes
- Visual mood/lighting changes dramatically

For each scene, identify:
- Start/end timestamps
- Scene type (talking_head, demonstration, b_roll, text_slide, transition, intro, outro)
- Visual description of the scene
- Emotional tone (calm, excited, serious, thoughtful, humorous, inspirational, tense, relaxed)
- Speaker ID if visible (speaker_1, speaker_2, etc.)
- Visual Importance: HIGH = viewer MUST see this (demonstrations, key expressions, important visuals), MEDIUM = adds value but not critical, LOW = can be covered with B-roll without losing content

4. EMOTION FLOW TRACKING (NEW)
Track how the emotional energy changes throughout the video. Create data points at key emotional shifts:
- Timestamp
- Emotion (calm, excited, serious, thoughtful, humorous, inspirational, tense, curious, satisfied)
- Intensity (0-100 scale)

This helps identify pacing and engagement patterns like: calm intro → building excitement → peak climax → satisfying conclusion

5. SPEAKER DETECTION (NEW)
Identify distinct speakers and when they appear:
- Speaker ID (speaker_1, speaker_2, etc.)
- Start/end times for each speaking segment
- Optional label if identifiable (host, guest, narrator, etc.)

6. KEY MOMENTS IDENTIFICATION (NEW - CRITICAL)
Identify special moments that are crucial for editing:
- HOOKS (first 3-10 seconds): Do they grab attention? Score 0-100 for hook strength
- CLIMAXES: Peak engagement/emotional moments
- CALL-TO-ACTIONS: When the speaker asks viewers to do something
- KEY POINTS: Important statements, revelations, or demonstrations
- TRANSITIONS: Natural break points between topics

7. NARRATIVE STRUCTURE
Identify:
- Introduction section (if any) and when it ends
- Main content boundaries
- Outro/conclusion section (if any) and when it starts
- Peak moments of interest/engagement (timestamps)

8. TOPIC SEGMENTATION
Break the video into distinct topic/subject segments with:
- Start and end times
- Topic description
- Importance level (low/medium/high)
- Whether it's a good B-roll window

9. B-ROLL OPPORTUNITIES
Identify specific moments where stock footage/images would enhance the content:
- Exact timestamp ranges
- Optimal duration (2-6 seconds typically)
- ULTRA-SPECIFIC search query (not "nature" but "peaceful sunrise over mountain lake with morning mist")
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
- HIGH visual importance = never cover with B-roll

Respond in JSON format only (no markdown):
{
  "frames": [
    {
      "timestamp": number,
      "description": "detailed description",
      "keyMoment": boolean,
      "suggestedStockQuery": "specific search query or null",
      "energyLevel": "low|medium|high",
      "speakingPace": "slow|normal|fast"
    }
  ],
  "summary": "string - comprehensive summary of video content and purpose",
  "context": {
    "genre": "string - one of the genre options above",
    "subGenre": "string - more specific category if applicable",
    "targetAudience": "string - who this video is for",
    "tone": "serious|casual|professional|humorous|inspirational|dramatic|calm",
    "pacing": "slow|moderate|fast|dynamic",
    "visualStyle": "string - description of visual aesthetics",
    "suggestedEditStyle": "minimal|moderate|dynamic|cinematic|fast-paced",
    "regionalContext": "string or null - cultural/regional context if apparent",
    "languageDetected": "string or null - detected language"
  },
  "scenes": [
    {
      "start": number,
      "end": number,
      "sceneType": "talking_head|demonstration|b_roll|text_slide|transition|intro|outro",
      "visualDescription": "what the scene shows",
      "emotionalTone": "calm|excited|serious|thoughtful|humorous|inspirational|tense|relaxed",
      "speakerId": "speaker_1|speaker_2|etc or null",
      "visualImportance": "high|medium|low"
    }
  ],
  "emotionFlow": [
    {
      "timestamp": number,
      "emotion": "string",
      "intensity": number (0-100)
    }
  ],
  "speakers": [
    {
      "start": number,
      "end": number,
      "speakerId": "speaker_1|speaker_2|etc",
      "speakerLabel": "host|guest|narrator|etc or null"
    }
  ],
  "keyMoments": [
    {
      "timestamp": number,
      "type": "hook|climax|callToAction|keyPoint|transition",
      "description": "what makes this moment special",
      "importance": "high|medium|low",
      "hookScore": number (0-100, only for type=hook)
    }
  ],
  "topicSegments": [
    {
      "start": number,
      "end": number,
      "topic": "topic description",
      "importance": "low|medium|high",
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
    "peakMoments": [timestamp1, timestamp2, ...]
  },
  "brollOpportunities": [
    {
      "start": number,
      "end": number,
      "suggestedDuration": number,
      "query": "ULTRA-SPECIFIC search query for stock media",
      "priority": "high|medium|low",
      "reason": "why B-roll would help here"
    }
  ]
}`;

  const imageParts = frameContents.map((frame) => ({
    inlineData: {
      mimeType: "image/jpeg" as const,
      data: frame.base64,
    },
  }));

  const response = await withRetry(
    () => getVideoAnalysisGeminiClient().models.generateContent({
      model: AI_CONFIG.models.analysis,
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }, ...imageParts],
        },
      ],
    }),
    "analyzeVideoFrames",
    AI_RETRY_OPTIONS
  );

  const text = response.text || "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  
  if (!jsonMatch) {
    aiLogger.warn("No JSON found in AI response for video analysis");
    return createFallbackAnalysis(framePaths.length, duration, silentSegments);
  }

  let parsed: VideoAnalysisResponse;
  try {
    parsed = JSON.parse(jsonMatch[0]) as VideoAnalysisResponse;
    const validated = VideoAnalysisResponseSchema.safeParse(parsed);
    if (!validated.success) {
      aiLogger.warn("Video analysis validation warning:", validated.error);
    }
  } catch (parseError) {
    aiLogger.warn("JSON parse error in video analysis:", parseError);
    return createFallbackAnalysis(framePaths.length, duration, silentSegments);
  }

  const frames: FrameAnalysis[] = (parsed.frames || []).map((f: RawFrameAnalysis, index: number) => ({
    timestamp: f.timestamp ?? frameInterval * (index + 1),
    description: f.description ?? "",
    keyMoment: f.keyMoment ?? false,
    suggestedStockQuery: f.suggestedStockQuery ?? undefined,
    energyLevel: f.energyLevel ?? "medium",
    speakingPace: f.speakingPace ?? "normal",
  }));

  const context: VideoContext | undefined = parsed.context ? {
    genre: parsed.context.genre ?? "other",
    subGenre: parsed.context.subGenre ?? undefined,
    targetAudience: parsed.context.targetAudience ?? undefined,
    tone: parsed.context.tone ?? "casual",
    pacing: parsed.context.pacing ?? "moderate",
    visualStyle: parsed.context.visualStyle ?? undefined,
    suggestedEditStyle: parsed.context.suggestedEditStyle ?? "moderate",
    regionalContext: parsed.context.regionalContext ?? undefined,
    languageDetected: parsed.context.languageDetected ?? undefined,
  } : undefined;

  const topicSegments: TopicSegment[] = (parsed.topicSegments || []).map((t: RawTopicSegment) => ({
    start: t.start ?? 0,
    end: t.end ?? duration,
    topic: t.topic ?? "Unknown",
    importance: t.importance ?? "medium",
    suggestedBrollWindow: t.suggestedBrollWindow ?? false,
  }));

  const scenes: SceneSegment[] = (parsed.scenes || []).map((s: RawSceneSegment) => ({
    start: s.start ?? 0,
    end: s.end ?? duration,
    sceneType: s.sceneType ?? "talking_head",
    visualDescription: s.visualDescription ?? "",
    emotionalTone: s.emotionalTone ?? "calm",
    speakerId: s.speakerId ?? undefined,
    visualImportance: s.visualImportance ?? "medium",
  }));

  const emotionFlow: EmotionFlowPoint[] = (parsed.emotionFlow || []).map((e: RawEmotionFlowPoint) => ({
    timestamp: e.timestamp ?? 0,
    emotion: e.emotion ?? "neutral",
    intensity: Math.min(100, Math.max(0, e.intensity ?? 50)),
  }));

  const speakers: SpeakerSegment[] = (parsed.speakers || []).map((s: RawSpeakerSegment) => ({
    start: s.start ?? 0,
    end: s.end ?? duration,
    speakerId: s.speakerId ?? "speaker_1",
    speakerLabel: s.speakerLabel ?? undefined,
  }));

  const keyMoments: KeyMoment[] = (parsed.keyMoments || []).map((k: RawKeyMomentResponse) => ({
    timestamp: k.timestamp ?? 0,
    type: k.type ?? "keyPoint",
    description: k.description ?? "",
    importance: k.importance ?? "medium",
    hookScore: k.hookScore ?? undefined,
  }));

  return {
    frames,
    summary: parsed.summary || "",
    context,
    topicSegments,
    narrativeStructure: parsed.narrativeStructure ? {
      introEnd: parsed.narrativeStructure.introEnd ?? undefined,
      outroStart: parsed.narrativeStructure.outroStart ?? undefined,
      hasIntro: parsed.narrativeStructure.hasIntro ?? undefined,
      hasOutro: parsed.narrativeStructure.hasOutro ?? undefined,
      mainContentStart: parsed.narrativeStructure.mainContentStart ?? undefined,
      mainContentEnd: parsed.narrativeStructure.mainContentEnd ?? undefined,
      peakMoments: parsed.narrativeStructure.peakMoments ?? undefined,
    } : undefined,
    silentSegments,
    brollOpportunities: (parsed.brollOpportunities || []).map((b: RawBrollOpportunity) => ({
      start: b.start ?? 0,
      end: b.end ?? 0,
      suggestedDuration: b.suggestedDuration ?? 3,
      query: b.query ?? "",
      priority: b.priority ?? "medium",
      reason: b.reason ?? "",
    })),
    duration,
    scenes,
    emotionFlow,
    speakers,
    keyMoments,
  };
}

function createFallbackAnalysis(
  frameCount: number,
  duration: number,
  silentSegments: { start: number; end: number }[]
): VideoAnalysis {
  const frameInterval = duration / (frameCount + 1);
  return {
    frames: Array.from({ length: frameCount }, (_, i) => ({
      timestamp: frameInterval * (i + 1),
      description: "Frame analysis unavailable",
      keyMoment: false,
      suggestedStockQuery: undefined,
    })),
    summary: "Video analysis failed - using fallback",
    silentSegments,
    duration,
  };
}

function computeQualityInsights(
  videoAnalysis: VideoAnalysis,
  semanticAnalysis: SemanticAnalysis,
  fillerSegments: { start: number; end: number; word: string }[],
  transcript: TranscriptSegment[],
  duration: number
): {
  hookStrength: number;
  pacingScore: number;
  engagementPrediction: number;
  recommendations: string[];
} {
  const recommendations: string[] = [];
  
  let hookStrength = 50;
  
  const hooks = videoAnalysis.keyMoments?.filter(k => k.type === "hook") || [];
  if (hooks.length > 0) {
    const maxHookScore = Math.max(...hooks.map(h => h.hookScore || 50));
    hookStrength = maxHookScore;
  }
  
  if (semanticAnalysis.hookMoments && semanticAnalysis.hookMoments.length > 0) {
    const maxSemanticHook = Math.max(...semanticAnalysis.hookMoments.map(h => h.score));
    hookStrength = Math.max(hookStrength, maxSemanticHook);
  }
  
  if (hookStrength < 60) {
    recommendations.push("Consider adding a stronger hook in the first 3-5 seconds to grab viewer attention");
  }
  
  let pacingScore = 70;
  
  const sceneCount = videoAnalysis.scenes?.length || 1;
  const topicCount = semanticAnalysis.topicFlow?.length || 1;
  const averageSceneDuration = duration / sceneCount;
  const averageTopicDuration = duration / topicCount;
  
  if (averageSceneDuration < 5) {
    pacingScore = Math.max(40, pacingScore - 20);
    recommendations.push("Pacing may be too fast - scenes change very quickly");
  } else if (averageSceneDuration > 60) {
    pacingScore = Math.max(40, pacingScore - 15);
    recommendations.push("Consider adding more visual variety - scenes are quite long");
  } else if (averageSceneDuration >= 10 && averageSceneDuration <= 30) {
    pacingScore = Math.min(100, pacingScore + 15);
  }
  
  if (averageTopicDuration > 90) {
    recommendations.push("Topics could be broken into smaller segments for better engagement");
  }
  
  let engagementPrediction = 60;
  
  const highImportanceScenes = videoAnalysis.scenes?.filter(s => s.visualImportance === "high") || [];
  if (highImportanceScenes.length > 0) {
    const highImportanceRatio = highImportanceScenes.length / (sceneCount || 1);
    engagementPrediction += highImportanceRatio * 20;
  }
  
  const keyMomentCount = (videoAnalysis.keyMoments?.length || 0) + (semanticAnalysis.keyMoments?.length || 0);
  if (keyMomentCount >= 3) {
    engagementPrediction += 10;
  }
  
  const fillerRatio = fillerSegments.length / Math.max(transcript.length, 1);
  if (fillerRatio > 0.2) {
    engagementPrediction -= 15;
    recommendations.push("High number of filler words detected - consider editing them out for smoother delivery");
  } else if (fillerRatio > 0.1) {
    engagementPrediction -= 5;
    recommendations.push("Some filler words detected - minor edits could improve flow");
  }
  
  engagementPrediction += (hookStrength - 50) * 0.3;
  
  const uniqueEmotions = new Set(videoAnalysis.emotionFlow?.map(e => e.emotion) || []);
  if (uniqueEmotions.size >= 3) {
    engagementPrediction += 10;
  } else if (uniqueEmotions.size === 1) {
    recommendations.push("Consider varying emotional tone throughout the video for better engagement");
  }
  
  const hasClimax = videoAnalysis.keyMoments?.some(k => k.type === "climax");
  const hasCallToAction = videoAnalysis.keyMoments?.some(k => k.type === "callToAction");
  
  if (!hasClimax) {
    recommendations.push("Consider adding a clear climax or peak moment to maintain viewer interest");
  }
  if (!hasCallToAction) {
    recommendations.push("Consider adding a call-to-action to improve viewer engagement and retention");
  }
  
  hookStrength = Math.min(100, Math.max(0, Math.round(hookStrength)));
  pacingScore = Math.min(100, Math.max(0, Math.round(pacingScore)));
  engagementPrediction = Math.min(100, Math.max(0, Math.round(engagementPrediction)));
  
  return {
    hookStrength,
    pacingScore,
    engagementPrediction,
    recommendations,
  };
}

export interface DeepAnalysisResult {
  videoAnalysis: VideoAnalysis & { analysisMethod?: "full_video_watch" | "frame_extraction" };
  semanticAnalysis: SemanticAnalysis;
  fillerSegments: { start: number; end: number; word: string }[];
  qualityInsights: {
    hookStrength: number;
    pacingScore: number;
    engagementPrediction: number;
    recommendations: string[];
  };
  enhancedAnalysis?: {
    motionAnalysis?: FullVideoAnalysisResult["motionAnalysis"];
    transitionAnalysis?: FullVideoAnalysisResult["transitionAnalysis"];
    audioVisualSync?: FullVideoAnalysisResult["audioVisualSync"];
    pacingAnalysis?: FullVideoAnalysisResult["pacingAnalysis"];
  };
}

export async function analyzeVideoDeep(
  framePaths: string[],
  duration: number,
  silentSegments: { start: number; end: number }[],
  transcript: TranscriptSegment[],
  videoPath?: string // Optional: if provided, try full video watching first
): Promise<DeepAnalysisResult> {
  const { analyzeTranscriptSemantics, detectFillerWords } = await import("./semanticAnalysis");
  
  aiLogger.info("Starting deep video analysis...");
  
  let videoAnalysis: VideoAnalysis & { analysisMethod?: "full_video_watch" | "frame_extraction" };
  let enhancedAnalysis: DeepAnalysisResult["enhancedAnalysis"];
  
  // TRY FULL VIDEO WATCHING FIRST (if video path provided)
  if (videoPath) {
    try {
      aiLogger.info("═══════════════════════════════════════════════════════");
      aiLogger.info("ATTEMPTING FULL VIDEO WATCHING (AI will watch entire video)");
      aiLogger.info("═══════════════════════════════════════════════════════");
      
      const fullAnalysis = await watchFullVideo(videoPath, duration, silentSegments);
      
      aiLogger.info("═══════════════════════════════════════════════════════");
      aiLogger.info("FULL VIDEO WATCHING SUCCESS");
      aiLogger.info(`Motion: ${fullAnalysis.motionAnalysis?.motionIntensity || "N/A"}`);
      aiLogger.info(`Scenes: ${fullAnalysis.scenes?.length || 0}`);
      aiLogger.info(`Key Moments: ${fullAnalysis.keyMoments?.length || 0}`);
      aiLogger.info(`Transitions: ${fullAnalysis.transitionAnalysis?.detectedTransitions?.length || 0}`);
      aiLogger.info("═══════════════════════════════════════════════════════");
      
      videoAnalysis = {
        ...fullAnalysis,
        analysisMethod: "full_video_watch",
      };
      
      // Store the enhanced analysis data
      enhancedAnalysis = {
        motionAnalysis: fullAnalysis.motionAnalysis,
        transitionAnalysis: fullAnalysis.transitionAnalysis,
        audioVisualSync: fullAnalysis.audioVisualSync,
        pacingAnalysis: fullAnalysis.pacingAnalysis,
      };
      
    } catch (fullVideoError) {
      aiLogger.warn(`Full video watching failed: ${fullVideoError instanceof Error ? fullVideoError.message : "Unknown error"}`);
      aiLogger.info("Falling back to frame extraction analysis...");
      
      // Fall back to frame extraction
      const frameAnalysis = await analyzeVideoFrames(framePaths, duration, silentSegments);
      videoAnalysis = {
        ...frameAnalysis,
        analysisMethod: "frame_extraction",
      };
    }
  } else {
    // No video path provided, use frame extraction
    aiLogger.info("No video path provided, using frame extraction analysis...");
    const frameAnalysis = await analyzeVideoFrames(framePaths, duration, silentSegments);
    videoAnalysis = {
      ...frameAnalysis,
      analysisMethod: "frame_extraction",
    };
  }
  
  // Run semantic analysis with context if available
  const semanticAnalysis = await analyzeTranscriptSemantics(
    transcript,
    videoAnalysis.context,
    duration
  );
  
  const fillerSegments = detectFillerWords(transcript);
  
  const qualityInsights = computeQualityInsights(
    videoAnalysis,
    semanticAnalysis,
    fillerSegments,
    transcript,
    duration
  );
  
  const method = videoAnalysis.analysisMethod || "frame_extraction";
  aiLogger.info(`Deep analysis complete (${method}): ${videoAnalysis.scenes?.length || 0} scenes, ${semanticAnalysis.topicFlow?.length || 0} topics, ${fillerSegments.length} fillers detected`);
  
  return {
    videoAnalysis,
    semanticAnalysis,
    fillerSegments,
    qualityInsights,
    enhancedAnalysis,
  };
}
