import { promises as fs } from "fs";
import { z } from "zod";
import { withRetry, AI_RETRY_OPTIONS } from "../../utils/retry";
import { createLogger } from "../../utils/logger";
import { getGeminiClient } from "./clients";
import { AI_CONFIG } from "../../config/ai";
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
      "suggestedDuration": number (2-6),
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
    () => getGeminiClient().models.generateContent({
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

export async function analyzeVideoDeep(
  framePaths: string[],
  duration: number,
  silentSegments: { start: number; end: number }[],
  transcript: TranscriptSegment[]
): Promise<{
  videoAnalysis: VideoAnalysis;
  semanticAnalysis: SemanticAnalysis;
  fillerSegments: { start: number; end: number; word: string }[];
  qualityInsights: {
    hookStrength: number;
    pacingScore: number;
    engagementPrediction: number;
    recommendations: string[];
  };
}> {
  const { analyzeTranscriptSemantics, detectFillerWords } = await import("./semanticAnalysis");
  
  aiLogger.info("Starting deep video analysis...");
  
  const [videoAnalysis, semanticAnalysisResult] = await Promise.all([
    analyzeVideoFrames(framePaths, duration, silentSegments),
    analyzeTranscriptSemantics(transcript, undefined, duration),
  ]);
  
  let semanticAnalysis = semanticAnalysisResult;
  if (videoAnalysis.context) {
    semanticAnalysis = await analyzeTranscriptSemantics(
      transcript,
      videoAnalysis.context,
      duration
    );
  }
  
  const fillerSegments = detectFillerWords(transcript);
  
  const qualityInsights = computeQualityInsights(
    videoAnalysis,
    semanticAnalysis,
    fillerSegments,
    transcript,
    duration
  );
  
  aiLogger.info(`Deep analysis complete: ${videoAnalysis.scenes?.length || 0} scenes, ${semanticAnalysis.topicFlow?.length || 0} topics, ${fillerSegments.length} fillers detected`);
  
  return {
    videoAnalysis,
    semanticAnalysis,
    fillerSegments,
    qualityInsights,
  };
}
