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
  SceneSegment,
  EmotionFlowPoint,
  SpeakerSegment,
  KeyMoment,
} from "@shared/schema";

const aiLogger = createLogger("ai-service");

const CutKeepActionSchema = z.object({
  type: z.enum(["cut", "keep"]),
  start: z.number().min(0),
  end: z.number().min(0),
  reason: z.string().optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  qualityScore: z.number().min(0).max(100).optional(),
}).refine(data => data.end >= data.start, { message: "end must be >= start" });

const InsertStockActionSchema = z.object({
  type: z.literal("insert_stock"),
  start: z.number().min(0).optional(),
  duration: z.number().min(1).max(8).optional(),
  stockQuery: z.string(),
  reason: z.string().optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  transcriptContext: z.string().optional(),
  qualityScore: z.number().min(0).max(100).optional(),
});

// Note: InsertAiImageActionSchema removed - AI images are auto-placed from semantic analysis

const TextActionSchema = z.object({
  type: z.enum(["add_caption", "add_text_overlay"]),
  start: z.number().min(0).optional(),
  end: z.number().min(0).optional(),
  text: z.string(),
  reason: z.string().optional(),
  qualityScore: z.number().min(0).max(100).optional(),
});

const TransitionActionSchema = z.object({
  type: z.literal("transition"),
  transitionType: z.string().optional(),
  reason: z.string().optional(),
  qualityScore: z.number().min(0).max(100).optional(),
});

const EditActionSchema = z.union([
  CutKeepActionSchema,
  InsertStockActionSchema,
  TextActionSchema,
  TransitionActionSchema,
]);

const EditPlanResponseSchema = z.object({
  actions: z.array(EditActionSchema),
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

// Enhanced video analysis schemas for deeper analysis
const SceneSegmentResponseSchema = z.object({
  start: z.number(),
  end: z.number(),
  sceneType: z.string(),
  visualDescription: z.string().optional().default(""),
  emotionalTone: z.string(),
  speakerId: z.string().optional(),
  visualImportance: z.enum(["high", "medium", "low"]),
});

const EmotionFlowPointResponseSchema = z.object({
  timestamp: z.number(),
  emotion: z.string(),
  intensity: z.number().min(0).max(100),
});

const SpeakerSegmentResponseSchema = z.object({
  start: z.number(),
  end: z.number(),
  speakerId: z.string(),
  speakerLabel: z.string().optional(),
});

const KeyMomentResponseSchema = z.object({
  timestamp: z.number(),
  type: z.enum(["hook", "climax", "callToAction", "keyPoint", "transition"]),
  description: z.string(),
  importance: z.enum(["high", "medium", "low"]),
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
  // Enhanced deep analysis fields
  scenes: z.array(SceneSegmentResponseSchema).optional(),
  emotionFlow: z.array(EmotionFlowPointResponseSchema).optional(),
  speakers: z.array(SpeakerSegmentResponseSchema).optional(),
  keyMoments: z.array(KeyMomentResponseSchema).optional(),
});

// Inferred types from Zod schemas for type-safe parsing
type RawFrameAnalysis = z.infer<typeof FrameAnalysisSchema>;
type RawTopicSegment = z.infer<typeof TopicSegmentSchema>;
type RawBrollOpportunity = z.infer<typeof BrollOpportunitySchema>;
type RawSceneSegment = z.infer<typeof SceneSegmentResponseSchema>;
type RawEmotionFlowPoint = z.infer<typeof EmotionFlowPointResponseSchema>;
type RawSpeakerSegment = z.infer<typeof SpeakerSegmentResponseSchema>;
type RawKeyMomentResponse = z.infer<typeof KeyMomentResponseSchema>;
type VideoAnalysisResponse = z.infer<typeof VideoAnalysisResponseSchema>;

// Raw JSON types for semantic analysis parsing
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

// ============================================================================
// ZOD SCHEMAS FOR MULTI-PASS PLANNING (validated AI responses)
// ============================================================================

const SectionSchema = z.object({
  start: z.number().min(0),
  end: z.number().min(0),
}).nullable();

const SectionMarkerSchema = z.object({
  timestamp: z.number().min(0),
  type: z.enum(["intro_end", "section_change", "climax", "outro_start", "transition"]),
  description: z.string(),
});

const StructuredPlanSchema = z.object({
  introSection: SectionSchema.optional().nullable(),
  mainContentSection: z.object({
    start: z.number().min(0),
    end: z.number().min(0),
  }),
  outroSection: SectionSchema.optional().nullable(),
  sectionMarkers: z.array(SectionMarkerSchema).optional().default([]),
  narrativeArc: z.enum(["linear", "problem_solution", "story", "tutorial", "listicle", "conversational"]).optional().default("linear"),
});

const SegmentScoreSchema = z.object({
  start: z.number().min(0),
  end: z.number().min(0),
  engagementScore: z.number().min(0).max(100),
  valueLevel: z.enum(["must_keep", "high", "medium", "low", "cut_candidate"]),
  reason: z.string().optional().default(""),
}).refine(data => data.end >= data.start, { message: "end must be >= start" });

const SegmentWithReasonSchema = z.object({
  start: z.number().min(0),
  end: z.number().min(0),
  reason: z.string().optional().default(""),
}).refine(data => data.end >= data.start, { message: "end must be >= start" });

const QualityMapSchema = z.object({
  segmentScores: z.array(SegmentScoreSchema).optional().default([]),
  hookStrength: z.number().min(0).max(100).optional().default(50),
  overallEngagement: z.number().min(0).max(100).optional().default(60),
  lowValueSegments: z.array(SegmentWithReasonSchema).optional().default([]),
  mustKeepSegments: z.array(SegmentWithReasonSchema).optional().default([]),
});

const BrollPlacementSchema = z.object({
  start: z.number().min(0),
  duration: z.number().min(1).max(10),
  query: z.string(),
  transcriptContext: z.string().optional().default(""),
  priority: z.enum(["high", "medium", "low"]).optional().default("medium"),
  reason: z.string().optional().default(""),
});

const FillerActionSchema = z.object({
  start: z.number().min(0),
  end: z.number().min(0),
  word: z.string(),
  action: z.enum(["cut", "overlay"]),
});

const CutActionSchema = z.object({
  start: z.number().min(0),
  end: z.number().min(0),
  reason: z.string().optional().default(""),
});

const OptimizedBrollPlanSchema = z.object({
  brollPlacements: z.array(BrollPlacementSchema).optional().default([]),
  fillerActions: z.array(FillerActionSchema).optional().default([]),
  cutActions: z.array(CutActionSchema).optional().default([]),
});

const QualityMetricsSchema = z.object({
  pacing: z.enum(["slow", "moderate", "fast"]).optional().default("moderate"),
  brollRelevance: z.enum(["high", "medium", "low"]).optional().default("medium"),
  narrativeFlow: z.enum(["high", "medium", "low"]).optional().default("medium"),
  overallScore: z.number().min(0).max(100).optional().default(70),
});

const ReviewedEditPlanSchema = z.object({
  actions: z.array(EditActionSchema),
  qualityMetrics: QualityMetricsSchema.optional(),
  recommendations: z.array(z.string()).optional().default([]),
  warnings: z.array(z.string()).optional().default([]),
});

let geminiClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
  if (!geminiClient) {
    if (!process.env.AI_INTEGRATIONS_GEMINI_API_KEY) {
      throw new Error('Gemini API key is not configured. Please set up the Gemini integration.');
    }
    geminiClient = new GoogleGenAI({
      apiKey: process.env.AI_INTEGRATIONS_GEMINI_API_KEY,
      httpOptions: {
        apiVersion: "",
        baseUrl: process.env.AI_INTEGRATIONS_GEMINI_BASE_URL,
      },
    });
  }
  return geminiClient;
}

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

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
      throw new Error('OpenAI API key is not configured. Please set up the OpenAI integration.');
    }
    openaiClient = new OpenAI({
      apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
      baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
    });
  }
  return openaiClient;
}

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
  "scenes": [
    {
      "start": number,
      "end": number,
      "sceneType": "talking_head" | "demonstration" | "b_roll" | "text_slide" | "transition" | "intro" | "outro",
      "visualDescription": "string - what's visually happening in this scene",
      "emotionalTone": "calm" | "excited" | "serious" | "thoughtful" | "humorous" | "inspirational" | "tense" | "relaxed",
      "speakerId": "speaker_1" | "speaker_2" | null,
      "visualImportance": "high" | "medium" | "low"
    }
  ],
  "emotionFlow": [
    {
      "timestamp": number,
      "emotion": "calm" | "excited" | "serious" | "thoughtful" | "humorous" | "inspirational" | "tense" | "curious" | "satisfied",
      "intensity": number (0-100)
    }
  ],
  "speakers": [
    {
      "start": number,
      "end": number,
      "speakerId": "speaker_1" | "speaker_2" | etc,
      "speakerLabel": "host" | "guest" | "narrator" | null
    }
  ],
  "keyMoments": [
    {
      "timestamp": number,
      "type": "hook" | "climax" | "callToAction" | "keyPoint" | "transition",
      "description": "string - what makes this moment important",
      "importance": "high" | "medium" | "low",
      "hookScore": number (0-100, only for hook type moments)
    }
  ],
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
      "query": "string - ULTRA-SPECIFIC contextual search query (e.g., 'professional businessman walking through modern glass office building' not just 'office')",
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
    () => getGeminiClient().models.generateContent({
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

  let validatedData: VideoAnalysisResponse;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const validated = VideoAnalysisResponseSchema.safeParse(parsed);
    if (!validated.success) {
      aiLogger.warn("AI response validation failed, using defaults:", validated.error.issues);
      return {
        duration,
        frames: framePaths.map((_, i) => ({
          timestamp: frameInterval * (i + 1),
          description: "Frame analysis unavailable",
          keyMoment: false,
          suggestedStockQuery: undefined,
        })),
        silentSegments,
        summary: "Analysis unavailable - validation failed",
      };
    }
    validatedData = validated.data;
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

  const frames: FrameAnalysis[] = (validatedData.frames || []).map((f: RawFrameAnalysis, i: number) => ({
    timestamp: f.timestamp || frameInterval * (i + 1),
    description: f.description || "",
    keyMoment: f.keyMoment || false,
    suggestedStockQuery: f.suggestedStockQuery || undefined,
    energyLevel: f.energyLevel || undefined,
    speakingPace: f.speakingPace || undefined,
  }));

  const context: VideoContext | undefined = validatedData.context ? {
    genre: validatedData.context.genre || "other",
    subGenre: validatedData.context.subGenre,
    targetAudience: validatedData.context.targetAudience,
    tone: validatedData.context.tone || "casual",
    pacing: validatedData.context.pacing || "moderate",
    visualStyle: validatedData.context.visualStyle,
    suggestedEditStyle: validatedData.context.suggestedEditStyle || "moderate",
    regionalContext: validatedData.context.regionalContext ?? undefined,
    languageDetected: validatedData.context.languageDetected ?? undefined,
  } : undefined;

  const topicSegments: TopicSegment[] | undefined = validatedData.topicSegments?.map((t: RawTopicSegment) => ({
    start: t.start || 0,
    end: t.end || duration,
    topic: t.topic || "Unknown topic",
    importance: t.importance,
    suggestedBrollWindow: t.suggestedBrollWindow,
  }));

  const brollOpportunities = validatedData.brollOpportunities?.map((b: RawBrollOpportunity) => ({
    start: Math.max(0, b.start || 0),
    end: Math.min(duration, b.end || b.start + 3),
    suggestedDuration: Math.min(6, Math.max(2, b.suggestedDuration || 3)),
    query: b.query || "background footage",
    priority: b.priority || "medium",
    reason: b.reason || "Enhance visual interest",
  }));

  // Convert null to undefined for narrativeStructure fields
  const narrativeStructure = validatedData.narrativeStructure ? {
    hasIntro: validatedData.narrativeStructure.hasIntro ?? undefined,
    introEnd: validatedData.narrativeStructure.introEnd ?? undefined,
    hasOutro: validatedData.narrativeStructure.hasOutro ?? undefined,
    outroStart: validatedData.narrativeStructure.outroStart ?? undefined,
    mainContentStart: validatedData.narrativeStructure.mainContentStart ?? undefined,
    mainContentEnd: validatedData.narrativeStructure.mainContentEnd ?? undefined,
    peakMoments: validatedData.narrativeStructure.peakMoments ?? undefined,
  } : undefined;

  // Parse enhanced analysis fields (scenes, emotionFlow, speakers, keyMoments)
  const scenes: SceneSegment[] | undefined = validatedData.scenes?.map((s: RawSceneSegment) => ({
    start: s.start || 0,
    end: s.end || duration,
    sceneType: s.sceneType || "talking_head",
    visualDescription: s.visualDescription || "",
    emotionalTone: s.emotionalTone || "calm",
    speakerId: s.speakerId,
    visualImportance: s.visualImportance || "medium",
  }));

  const emotionFlow: EmotionFlowPoint[] | undefined = validatedData.emotionFlow?.map((e: RawEmotionFlowPoint) => ({
    timestamp: e.timestamp || 0,
    emotion: e.emotion || "calm",
    intensity: Math.min(100, Math.max(0, e.intensity || 50)),
  }));

  const speakers: SpeakerSegment[] | undefined = validatedData.speakers?.map((s: RawSpeakerSegment) => ({
    start: s.start || 0,
    end: s.end || duration,
    speakerId: s.speakerId || "speaker_1",
    speakerLabel: s.speakerLabel,
  }));

  const keyMoments: KeyMoment[] | undefined = validatedData.keyMoments?.map((k: RawKeyMomentResponse) => ({
    timestamp: k.timestamp || 0,
    type: k.type || "keyPoint",
    description: k.description || "",
    importance: k.importance || "medium",
    hookScore: k.hookScore ?? undefined,
  }));

  return {
    duration,
    frames,
    silentSegments,
    summary: validatedData.summary || "",
    context,
    topicSegments,
    narrativeStructure,
    brollOpportunities,
    scenes,
    emotionFlow,
    speakers,
    keyMoments,
  };
}

// Whisper.cpp model path - configurable via environment variable with sensible default
// Uses multilingual base model for non-English support
const DEFAULT_WHISPER_MODEL_PATH = "/tmp/whisper_models/ggml-base.bin";
const WHISPER_MODEL_PATH = process.env.WHISPER_MODEL_PATH || DEFAULT_WHISPER_MODEL_PATH;
const WHISPER_MODEL_URL = process.env.WHISPER_MODEL_URL || "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";

/**
 * Fallback transcription using OpenAI API
 * Uses gpt-4o-mini-transcribe with verbose_json for accurate word-level timestamps
 */
async function transcribeWithOpenAI(audioPath: string): Promise<TranscriptSegment[]> {
  try {
    aiLogger.info("Using OpenAI gpt-4o-mini-transcribe for transcription with word-level timestamps...");
    const audioBuffer = await fs.readFile(audioPath);
    const file = await toFile(audioBuffer, "audio.mp3");

    const response = await getOpenAIClient().audio.transcriptions.create({
      file,
      model: "gpt-4o-mini-transcribe",
      response_format: "verbose_json",
      timestamp_granularities: ["word", "segment"],
    }) as any;

    const segments: TranscriptSegment[] = [];
    
    if (response.segments && Array.isArray(response.segments)) {
      aiLogger.info(`OpenAI transcription successful. Processing ${response.segments.length} segments...`);
      
      for (const segment of response.segments) {
        if (segment.words && Array.isArray(segment.words) && segment.words.length > 0) {
          for (const word of segment.words) {
            if (word.word && typeof word.start === 'number' && typeof word.end === 'number') {
              segments.push({
                start: word.start,
                end: word.end,
                text: word.word.trim(),
              });
            }
          }
        } else if (typeof segment.start === 'number' && typeof segment.end === 'number' && segment.text) {
          segments.push({
            start: segment.start,
            end: segment.end,
            text: segment.text.trim(),
          });
        }
      }
      
      if (segments.length > 0) {
        aiLogger.info(`Extracted ${segments.length} transcript segments with accurate timestamps`);
        return segments;
      }
    }
    
    const text = response.text || "";
    if (text.trim() && segments.length === 0) {
      aiLogger.warn("No segment data available, falling back to estimated timestamps...");
      const sentences = text.split(/(?<=[.!?])\s+/).filter((s: string) => s.trim());
      
      const charsPerSecond = 12.5;
      let currentTime = 0;
      
      const estimatedSegments = sentences.map((sentence: string) => {
        const duration = Math.max(1.5, sentence.length / charsPerSecond);
        const segment = {
          start: currentTime,
          end: currentTime + duration,
          text: sentence.trim(),
        };
        currentTime += duration + 0.3;
        return segment;
      }).filter((s: TranscriptSegment) => s.text.length > 0);
      
      aiLogger.info(`Estimated ${estimatedSegments.length} transcript segments (timing is approximate)`);
      return estimatedSegments;
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    aiLogger.error("OpenAI transcription failed:", errorMessage);
  }
  
  return [];
}

// Type for promisified exec function
type ExecPromise = (cmd: string, options?: { timeout?: number }) => Promise<{ stdout: string; stderr: string }>;

/**
 * Ensure whisper model is available, downloading if necessary
 * Returns true if model is ready, false if unavailable (triggers OpenAI fallback)
 */
async function ensureWhisperModel(execPromise: ExecPromise): Promise<boolean> {
  try {
    await fs.access(WHISPER_MODEL_PATH);
    aiLogger.debug(`Whisper model found at ${WHISPER_MODEL_PATH}`);
    return true;
  } catch {
    aiLogger.warn(`Whisper model not found at ${WHISPER_MODEL_PATH}`);
    
    // Try to download the model
    try {
      const modelDir = WHISPER_MODEL_PATH.substring(0, WHISPER_MODEL_PATH.lastIndexOf("/"));
      aiLogger.info(`Downloading whisper model from ${WHISPER_MODEL_URL}...`);
      await fs.mkdir(modelDir, { recursive: true });
      await execPromise(
        `curl -L -o "${WHISPER_MODEL_PATH}" "${WHISPER_MODEL_URL}"`,
        { timeout: 120000 }
      );
      
      // Verify download succeeded
      await fs.access(WHISPER_MODEL_PATH);
      aiLogger.info("Whisper model downloaded successfully");
      return true;
    } catch (downloadError: unknown) {
      const errorMessage = downloadError instanceof Error ? downloadError.message : String(downloadError);
      aiLogger.error(`Failed to download whisper model: ${errorMessage}`);
      aiLogger.info("Will use OpenAI API fallback for transcription");
      return false;
    }
  }
}

/**
 * Transcribe audio using local whisper.cpp for accurate timestamps
 * This is the single source of truth for transcription timing
 * Falls back to OpenAI API if local whisper is unavailable
 */
export async function transcribeAudio(
  audioPath: string
): Promise<TranscriptSegment[]> {
  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const execPromise = promisify(exec);
  const { v4: uuidv4 } = await import("uuid");
  
  aiLogger.info(`Transcription starting...`);
  
  // Check if whisper model is available (downloads if missing)
  const whisperAvailable = await ensureWhisperModel(execPromise);
  
  if (!whisperAvailable) {
    // Skip directly to OpenAI fallback
    aiLogger.info("Whisper model unavailable, using OpenAI API for transcription");
    return await transcribeWithOpenAI(audioPath);
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
    
    aiLogger.warn("Whisper.cpp returned no segments, trying OpenAI fallback...");
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    aiLogger.error("Whisper.cpp transcription failed:", errorMessage);
    // Only fallback if whisper completely failed (not if parsing failed)
    // The parsing failure case returns early above
  } finally {
    // Always cleanup temp files
    await cleanupTempFiles();
  }
  
  // Fallback: Use OpenAI API for transcription
  // This only runs if whisper.cpp completely failed or returned zero segments
  const fallbackResult = await transcribeWithOpenAI(audioPath);
  if (fallbackResult.length > 0) {
    return fallbackResult;
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

// Common filler words to detect in transcripts
const FILLER_WORDS = [
  "um", "uh", "erm", "er", "ah", "uhh", "umm",
  "like", "you know", "so", "basically", "actually", "literally",
  "i mean", "you see", "right", "okay", "well", "just",
  "kind of", "sort of", "you know what i mean", "at the end of the day"
];

/**
 * Detect filler words in transcript segments
 * Returns array of { start, end, word } for each filler detected
 */
export function detectFillerWords(
  transcript: TranscriptSegment[]
): { start: number; end: number; word: string }[] {
  const fillerSegments: { start: number; end: number; word: string }[] = [];
  
  for (const segment of transcript) {
    const text = segment.text.toLowerCase();
    const segmentDuration = segment.end - segment.start;
    const words = text.split(/\s+/);
    const wordsPerSecond = words.length / Math.max(segmentDuration, 0.1);
    
    // Check for single-word fillers
    for (const filler of FILLER_WORDS) {
      const fillerLower = filler.toLowerCase();
      
      if (filler.includes(" ")) {
        // Multi-word filler phrase
        if (text.includes(fillerLower)) {
          // Estimate timing based on position in segment
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
        // Single word filler - check each word
        for (let i = 0; i < words.length; i++) {
          const word = words[i].replace(/[^a-z]/g, ""); // Remove punctuation
          if (word === fillerLower) {
            // Estimate timing based on word position
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
  
  // Sort by start time
  fillerSegments.sort((a, b) => a.start - b.start);
  
  aiLogger.debug(`Detected ${fillerSegments.length} filler word instances`);
  return fillerSegments;
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
    
    // Validate and clamp B-roll windows
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
      .slice(0, 15); // Maximum 15 B-roll windows (1 per ~5-6 seconds of video)

    // Parse enhanced fields
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
      // Enhanced analysis fields
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
      () => getGeminiClient().models.generateContent({
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
      (part: { inlineData?: { data?: string; mimeType?: string } }) => part.inlineData
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
    () => getGeminiClient().models.generateContent({
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

  let parsed: z.infer<typeof EditPlanResponseSchema>;
  try {
    parsed = JSON.parse(jsonMatch[0]) as z.infer<typeof EditPlanResponseSchema>;
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
      const validAction = actionValidation.data;
      if ('start' in validAction && validAction.start !== undefined && validAction.start < 0) {
        (validAction as { start: number }).start = 0;
      }
      if ('end' in validAction && validAction.end !== undefined && validAction.end > analysis.duration) {
        (validAction as { end: number }).end = analysis.duration;
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

// ============================================================================
// MULTI-PASS SMART EDIT PLANNING SYSTEM
// ============================================================================

// Interface for Pass 1: Structure Analysis output
interface StructuredPlan {
  introSection: { start: number; end: number } | null;
  mainContentSection: { start: number; end: number };
  outroSection: { start: number; end: number } | null;
  sectionMarkers: Array<{
    timestamp: number;
    type: "intro_end" | "section_change" | "climax" | "outro_start" | "transition";
    description: string;
  }>;
  narrativeArc: "linear" | "problem_solution" | "story" | "tutorial" | "listicle" | "conversational";
}

// Interface for Pass 2: Quality Assessment output
interface QualityMap {
  segmentScores: Array<{
    start: number;
    end: number;
    engagementScore: number; // 0-100
    valueLevel: "must_keep" | "high" | "medium" | "low" | "cut_candidate";
    reason: string;
  }>;
  hookStrength: number; // 0-100
  overallEngagement: number; // 0-100
  lowValueSegments: Array<{ start: number; end: number; reason: string }>;
  mustKeepSegments: Array<{ start: number; end: number; reason: string }>;
}

// Interface for Pass 3: B-Roll Optimization output
interface OptimizedBrollPlan {
  brollPlacements: Array<{
    start: number;
    duration: number;
    query: string;
    transcriptContext: string;
    priority: "high" | "medium" | "low";
    reason: string;
  }>;
  fillerActions: Array<{
    start: number;
    end: number;
    word: string;
    action: "cut" | "overlay";
  }>;
  cutActions: Array<{
    start: number;
    end: number;
    reason: string;
  }>;
}

// Interface for Pass 4: Quality Review output
interface ReviewedEditPlan {
  actions: EditAction[];
  qualityMetrics: {
    pacing: "slow" | "moderate" | "fast";
    brollRelevance: "high" | "medium" | "low";
    narrativeFlow: "high" | "medium" | "low";
    overallScore: number;
  };
  recommendations: string[];
  warnings: string[];
}

/**
 * Pass 1: Structure Analysis
 * Identifies intro, main content, and outro sections
 * Determines overall video structure and narrative arc
 */
async function executePass1StructureAnalysis(
  analysis: VideoAnalysis,
  transcript: TranscriptSegment[],
  semanticAnalysis: SemanticAnalysis
): Promise<StructuredPlan> {
  const duration = analysis.duration;
  const transcriptText = transcript.slice(0, 30).map(t => 
    `[${t.start.toFixed(1)}s]: ${t.text}`
  ).join("\n");

  const prompt = `You are an expert video structure analyst. Analyze this video to identify its structural components.

VIDEO ANALYSIS:
- Duration: ${duration.toFixed(1)} seconds
- Genre: ${analysis.context?.genre || "general"}
- Tone: ${analysis.context?.tone || "casual"}
- Existing narrative structure: ${JSON.stringify(analysis.narrativeStructure || {})}

SEMANTIC ANALYSIS:
- Main topics: ${semanticAnalysis.mainTopics.join(", ")}
- Structure hints: ${JSON.stringify(semanticAnalysis.structureAnalysis || {})}
- Topic flow: ${JSON.stringify(semanticAnalysis.topicFlow?.slice(0, 5) || [])}

TRANSCRIPT (first 30 segments):
${transcriptText}

ANALYZE THE VIDEO STRUCTURE:

1. INTRO SECTION: Identify where the introduction ends (typically 5-30 seconds)
   - Look for: greetings, channel plugs, video previews, hook statements
   - Mark null if no distinct intro

2. MAIN CONTENT SECTION: Core content that delivers value
   - This is the "meat" of the video
   - Should be the majority of the video

3. OUTRO SECTION: Identify where conclusion begins (typically last 10-60 seconds)
   - Look for: summary statements, CTAs, "thanks for watching", subscribe reminders
   - Mark null if no distinct outro

4. SECTION MARKERS: Key structural points where topics change or transitions occur
   - intro_end: Where intro concludes
   - section_change: Topic or activity transitions
   - climax: Peak engagement/important reveal
   - outro_start: Beginning of conclusion
   - transition: Natural pause or shift points

5. NARRATIVE ARC: Classify the overall structure
   - linear: Straightforward progression
   - problem_solution: Presents problem, then solution
   - story: Beginning, middle, end narrative
   - tutorial: Step-by-step instruction
   - listicle: List of items/points
   - conversational: Casual, flowing discussion

Respond in JSON format only (no markdown):
{
  "introSection": {"start": 0, "end": number} | null,
  "mainContentSection": {"start": number, "end": number},
  "outroSection": {"start": number, "end": ${duration.toFixed(1)}} | null,
  "sectionMarkers": [
    {"timestamp": number, "type": "intro_end|section_change|climax|outro_start|transition", "description": "string"}
  ],
  "narrativeArc": "linear|problem_solution|story|tutorial|listicle|conversational"
}`;

  try {
    const response = await withRetry(
      () => getGeminiClient().models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      }),
      "pass1StructureAnalysis",
      AI_RETRY_OPTIONS
    );

    const text = response.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) {
      aiLogger.warn("Pass 1: Failed to parse structure analysis, using defaults");
      return getDefaultStructuredPlan(duration, analysis, semanticAnalysis);
    }

    const parsed = JSON.parse(jsonMatch[0]);
    
    // Validate with Zod schema
    const validated = StructuredPlanSchema.safeParse(parsed);
    if (!validated.success) {
      aiLogger.warn("Pass 1: Schema validation failed, using defaults:", validated.error.issues);
      return getDefaultStructuredPlan(duration, analysis, semanticAnalysis);
    }
    
    return {
      introSection: validated.data.introSection || null,
      mainContentSection: validated.data.mainContentSection || { start: 0, end: duration },
      outroSection: validated.data.outroSection || null,
      sectionMarkers: validated.data.sectionMarkers.map((m) => ({
        timestamp: m.timestamp,
        type: m.type,
        description: m.description,
      })),
      narrativeArc: validated.data.narrativeArc,
    };
  } catch (error) {
    aiLogger.error("Pass 1 error:", error);
    return getDefaultStructuredPlan(duration, analysis, semanticAnalysis);
  }
}

function getDefaultStructuredPlan(
  duration: number, 
  analysis: VideoAnalysis, 
  semanticAnalysis: SemanticAnalysis
): StructuredPlan {
  const introEnd = semanticAnalysis.structureAnalysis?.introEnd || 
                   analysis.narrativeStructure?.introEnd || 
                   Math.min(10, duration * 0.1);
  const outroStart = semanticAnalysis.structureAnalysis?.outroStart || 
                     analysis.narrativeStructure?.outroStart || 
                     Math.max(duration - 15, duration * 0.9);
  
  return {
    introSection: introEnd > 3 ? { start: 0, end: introEnd } : null,
    mainContentSection: { start: introEnd || 0, end: outroStart || duration },
    outroSection: outroStart < duration - 5 ? { start: outroStart, end: duration } : null,
    sectionMarkers: [],
    narrativeArc: "linear",
  };
}

/**
 * Pass 2: Quality Assessment
 * Scores each segment for engagement potential
 */
async function executePass2QualityAssessment(
  analysis: VideoAnalysis,
  transcript: TranscriptSegment[],
  semanticAnalysis: SemanticAnalysis,
  structuredPlan: StructuredPlan,
  fillerSegments: { start: number; end: number; word: string }[]
): Promise<QualityMap> {
  const duration = analysis.duration;
  
  const keyMomentsSummary = [
    ...(analysis.keyMoments || []).map(k => `[${k.timestamp.toFixed(1)}s] ${k.type}: ${k.description} (${k.importance})`),
    ...(semanticAnalysis.keyMoments || []).map(k => `[${k.timestamp.toFixed(1)}s] ${k.description} (${k.importance})`),
  ].slice(0, 15).join("\n");

  const scenesSummary = (analysis.scenes || []).slice(0, 10).map(s => 
    `[${s.start.toFixed(1)}s-${s.end.toFixed(1)}s] ${s.sceneType} - ${s.emotionalTone}, visual importance: ${s.visualImportance}`
  ).join("\n");

  const emotionFlowSummary = (analysis.emotionFlow || []).slice(0, 10).map(e =>
    `[${e.timestamp.toFixed(1)}s] ${e.emotion} (intensity: ${e.intensity})`
  ).join("\n");

  const prompt = `You are an expert video quality analyst. Score each segment of this video for engagement potential.

VIDEO INFO:
- Duration: ${duration.toFixed(1)} seconds
- Genre: ${analysis.context?.genre || "general"}
- Hook moments detected: ${JSON.stringify(semanticAnalysis.hookMoments?.slice(0, 3) || [])}
- Filler words count: ${fillerSegments.length}

STRUCTURE (from Pass 1):
- Intro: ${structuredPlan.introSection ? `${structuredPlan.introSection.start}s-${structuredPlan.introSection.end}s` : "None"}
- Main content: ${structuredPlan.mainContentSection.start}s-${structuredPlan.mainContentSection.end}s
- Outro: ${structuredPlan.outroSection ? `${structuredPlan.outroSection.start}s-${structuredPlan.outroSection.end}s` : "None"}
- Narrative arc: ${structuredPlan.narrativeArc}

KEY MOMENTS DETECTED:
${keyMomentsSummary || "None"}

SCENES DETECTED:
${scenesSummary || "None"}

EMOTION FLOW:
${emotionFlowSummary || "None"}

FILLER SEGMENTS (partial):
${fillerSegments.slice(0, 10).map(f => `[${f.start.toFixed(1)}s] "${f.word}"`).join(", ")}

SCORING GUIDELINES:
- 80-100: MUST KEEP - Key moments, climaxes, important reveals, strong hooks
- 60-79: HIGH VALUE - Good content, engaging, contributes to narrative
- 40-59: MEDIUM VALUE - Acceptable but not essential, could be trimmed
- 20-39: LOW VALUE - Filler, tangents, low energy sections
- 0-19: CUT CANDIDATE - Dead air, mistakes, very low value content

Break the video into 5-15 segments based on content quality shifts.
Identify segments that MUST be kept and segments that are candidates for cutting.

Respond in JSON format only (no markdown):
{
  "segmentScores": [
    {
      "start": number,
      "end": number,
      "engagementScore": number (0-100),
      "valueLevel": "must_keep|high|medium|low|cut_candidate",
      "reason": "why this score"
    }
  ],
  "hookStrength": number (0-100),
  "overallEngagement": number (0-100),
  "lowValueSegments": [{"start": number, "end": number, "reason": "string"}],
  "mustKeepSegments": [{"start": number, "end": number, "reason": "string"}]
}`;

  try {
    const response = await withRetry(
      () => getGeminiClient().models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      }),
      "pass2QualityAssessment",
      AI_RETRY_OPTIONS
    );

    const text = response.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) {
      aiLogger.warn("Pass 2: Failed to parse quality assessment, using defaults");
      return getDefaultQualityMap(duration, analysis, semanticAnalysis);
    }

    const parsed = JSON.parse(jsonMatch[0]);
    
    // Validate with Zod schema
    const validated = QualityMapSchema.safeParse(parsed);
    if (!validated.success) {
      aiLogger.warn("Pass 2: Schema validation failed, using defaults:", validated.error.issues);
      return getDefaultQualityMap(duration, analysis, semanticAnalysis);
    }
    
    return {
      segmentScores: validated.data.segmentScores.map((s) => ({
        start: s.start,
        end: s.end,
        engagementScore: s.engagementScore,
        valueLevel: s.valueLevel,
        reason: s.reason,
      })),
      hookStrength: validated.data.hookStrength,
      overallEngagement: validated.data.overallEngagement,
      lowValueSegments: validated.data.lowValueSegments,
      mustKeepSegments: validated.data.mustKeepSegments,
    };
  } catch (error) {
    aiLogger.error("Pass 2 error:", error);
    return getDefaultQualityMap(duration, analysis, semanticAnalysis);
  }
}

function getDefaultQualityMap(
  duration: number,
  analysis: VideoAnalysis,
  semanticAnalysis: SemanticAnalysis
): QualityMap {
  const hookStrength = semanticAnalysis.hookMoments?.[0]?.score || 50;
  
  return {
    segmentScores: [{ start: 0, end: duration, engagementScore: 60, valueLevel: "medium", reason: "Default assessment" }],
    hookStrength,
    overallEngagement: 60,
    lowValueSegments: [],
    mustKeepSegments: [],
  };
}

/**
 * Pass 3: B-Roll Optimization
 * Creates intelligent B-roll placement based on semantic analysis
 */
async function executePass3BrollOptimization(
  analysis: VideoAnalysis,
  transcript: TranscriptSegment[],
  semanticAnalysis: SemanticAnalysis,
  structuredPlan: StructuredPlan,
  qualityMap: QualityMap,
  fillerSegments: { start: number; end: number; word: string }[]
): Promise<OptimizedBrollPlan> {
  const duration = analysis.duration;
  const genre = analysis.context?.genre || "general";
  const tone = analysis.context?.tone || "casual";
  
  // Get low visual importance scenes (safe for B-roll)
  const lowImportanceScenes = (analysis.scenes || [])
    .filter(s => s.visualImportance === "low" || s.visualImportance === "medium")
    .map(s => `[${s.start.toFixed(1)}s-${s.end.toFixed(1)}s] ${s.visualDescription || s.sceneType}`);

  // Get B-roll windows from semantic analysis
  const brollWindowsSummary = semanticAnalysis.brollWindows.slice(0, 12).map(b =>
    `[${b.start.toFixed(1)}s-${b.end.toFixed(1)}s] Context: "${b.context}" - Query: "${b.suggestedQuery}" (${b.priority})`
  ).join("\n");

  // Get low-value segments from quality assessment
  const lowValueSummary = qualityMap.lowValueSegments.map(s =>
    `[${s.start.toFixed(1)}s-${s.end.toFixed(1)}s] ${s.reason}`
  ).join("\n");

  // Transcript context for B-roll queries
  const transcriptContext = transcript.slice(0, 25).map(t =>
    `[${t.start.toFixed(1)}s-${t.end.toFixed(1)}s]: ${t.text}`
  ).join("\n");

  const prompt = `You are an expert B-roll optimization specialist. Create an intelligent B-roll placement plan.

VIDEO CONTEXT:
- Duration: ${duration.toFixed(1)} seconds
- Genre: ${genre}
- Tone: ${tone}
- B-roll style hint: ${getBrollStyleHint(genre)}

STRUCTURE:
- Main content: ${structuredPlan.mainContentSection.start}s-${structuredPlan.mainContentSection.end}s
- Narrative arc: ${structuredPlan.narrativeArc}

LOW VISUAL IMPORTANCE SCENES (safe for B-roll overlay):
${lowImportanceScenes.slice(0, 10).join("\n") || "None identified"}

SEMANTIC B-ROLL WINDOWS (from transcript analysis):
${brollWindowsSummary || "None identified"}

LOW VALUE SEGMENTS (from quality assessment):
${lowValueSummary || "None identified"}

FILLER WORDS DETECTED:
${fillerSegments.slice(0, 15).map(f => `[${f.start.toFixed(1)}s-${f.end.toFixed(1)}s] "${f.word}"`).join("\n")}

TRANSCRIPT CONTEXT:
${transcriptContext}

B-ROLL OPTIMIZATION RULES:
1. NEVER place B-roll during "high" visual importance segments
2. Use ULTRA-SPECIFIC queries based on exact transcript context:
   - BAD: "business", "nature", "technology"
   - GOOD: "peaceful morning meditation routine person meditating with sunrise"
   - GOOD: "excited team celebrating business success high-five in modern office"
3. Match genre/tone: ${genre} content should get ${tone} imagery
4. DISTRIBUTE EVENLY across the entire video - no clustering
5. Minimum 3-5 second spacing between B-roll clips
6. Each B-roll should be 3-5 seconds duration
7. Target ${Math.min(12, Math.max(4, Math.ceil(duration / 8)))} B-roll placements for this ${duration.toFixed(0)}s video

FILLER WORD HANDLING:
- Prefer CUTTING filler words when possible (cleaner audio)
- Only use B-roll overlay on fillers when cutting would break flow
- Short fillers (<0.5s): usually cut
- Longer fillers in middle of sentence: consider overlay

CREATE OPTIMIZED B-ROLL PLAN:
1. B-roll placements with ultra-specific queries
2. Actions for filler words (cut or overlay)
3. Low-value segments to cut

Respond in JSON format only (no markdown):
{
  "brollPlacements": [
    {
      "start": number,
      "duration": number (3-5 seconds),
      "query": "ULTRA-SPECIFIC search query matching transcript context",
      "transcriptContext": "what speaker is saying at this moment",
      "priority": "high|medium|low",
      "reason": "why B-roll here"
    }
  ],
  "fillerActions": [
    {
      "start": number,
      "end": number,
      "word": "the filler word",
      "action": "cut|overlay"
    }
  ],
  "cutActions": [
    {
      "start": number,
      "end": number,
      "reason": "why to cut this segment"
    }
  ]
}`;

  try {
    const response = await withRetry(
      () => getGeminiClient().models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      }),
      "pass3BrollOptimization",
      AI_RETRY_OPTIONS
    );

    const text = response.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) {
      aiLogger.warn("Pass 3: Failed to parse B-roll optimization, using defaults");
      return getDefaultBrollPlan(duration, semanticAnalysis, fillerSegments);
    }

    const parsed = JSON.parse(jsonMatch[0]);
    
    // Validate with Zod schema
    const validated = OptimizedBrollPlanSchema.safeParse(parsed);
    if (!validated.success) {
      aiLogger.warn("Pass 3: Schema validation failed, using defaults:", validated.error.issues);
      return getDefaultBrollPlan(duration, semanticAnalysis, fillerSegments);
    }
    
    // Validate and ensure B-roll spacing
    const brollPlacements = validateBrollSpacing(
      validated.data.brollPlacements.map((b) => ({
        start: Math.max(0, b.start),
        duration: Math.min(6, Math.max(2, b.duration)),
        query: b.query || "background footage",
        transcriptContext: b.transcriptContext,
        priority: b.priority,
        reason: b.reason,
      })),
      duration
    );

    return {
      brollPlacements,
      fillerActions: validated.data.fillerActions.map((f) => ({
        start: f.start,
        end: f.end,
        word: f.word,
        action: f.action,
      })),
      cutActions: validated.data.cutActions.map((c) => ({
        start: c.start,
        end: c.end,
        reason: c.reason,
      })),
    };
  } catch (error) {
    aiLogger.error("Pass 3 error:", error);
    return getDefaultBrollPlan(duration, semanticAnalysis, fillerSegments);
  }
}

function validateBrollSpacing(
  placements: Array<{ start: number; duration: number; query: string; transcriptContext: string; priority: string; reason: string }>,
  duration: number
): Array<{ start: number; duration: number; query: string; transcriptContext: string; priority: "high" | "medium" | "low"; reason: string }> {
  // Sort by start time
  const sorted = [...placements].sort((a, b) => a.start - b.start);
  const validated: Array<{ start: number; duration: number; query: string; transcriptContext: string; priority: "high" | "medium" | "low"; reason: string }> = [];
  let lastEnd = -5; // Allow first B-roll at 0

  for (const placement of sorted) {
    // Ensure minimum 3 second spacing
    if (placement.start >= lastEnd + 3 && placement.start < duration - 1) {
      validated.push({
        ...placement,
        priority: placement.priority as "high" | "medium" | "low",
      });
      lastEnd = placement.start + placement.duration;
    } else {
      aiLogger.debug(`Pass 3: Skipping overlapping B-roll at ${placement.start}s (previous ended at ${lastEnd}s)`);
    }
  }

  return validated;
}

function getDefaultBrollPlan(
  duration: number,
  semanticAnalysis: SemanticAnalysis,
  fillerSegments: { start: number; end: number; word: string }[]
): OptimizedBrollPlan {
  // Use semantic B-roll windows as default placements
  const brollPlacements = semanticAnalysis.brollWindows
    .filter(b => b.start !== undefined && b.suggestedQuery)
    .slice(0, 8)
    .map(b => ({
      start: b.start,
      duration: Math.min(5, b.end - b.start),
      query: b.suggestedQuery,
      transcriptContext: b.context,
      priority: (b.priority || "medium") as "low" | "medium" | "high",
      reason: b.reason,
    }));

  // Default: cut short fillers
  const fillerActions = fillerSegments
    .filter(f => (f.end - f.start) < 1)
    .slice(0, 10)
    .map(f => ({
      start: f.start,
      end: f.end,
      word: f.word,
      action: "cut" as const,
    }));

  return {
    brollPlacements,
    fillerActions,
    cutActions: [],
  };
}

/**
 * Pass 4: Quality Review & Refinement
 * Reviews the combined edit plan for quality and consistency
 */
async function executePass4QualityReview(
  analysis: VideoAnalysis,
  structuredPlan: StructuredPlan,
  qualityMap: QualityMap,
  brollPlan: OptimizedBrollPlan,
  prompt: string
): Promise<ReviewedEditPlan> {
  const duration = analysis.duration;
  const genre = analysis.context?.genre || "general";

  // Build preliminary actions list
  const preliminaryActions: EditAction[] = [];

  // Add keep actions for must-keep segments
  for (const segment of qualityMap.mustKeepSegments) {
    preliminaryActions.push({
      type: "keep",
      start: segment.start,
      end: segment.end,
      reason: segment.reason,
      priority: "high",
    });
  }

  // Add cut actions
  for (const cut of brollPlan.cutActions) {
    preliminaryActions.push({
      type: "cut",
      start: cut.start,
      end: cut.end,
      reason: cut.reason,
    });
  }

  // Add filler cuts
  for (const filler of brollPlan.fillerActions.filter(f => f.action === "cut")) {
    preliminaryActions.push({
      type: "cut",
      start: filler.start,
      end: filler.end,
      reason: `Cut filler word: "${filler.word}"`,
    });
  }

  // Add B-roll insert actions
  for (const broll of brollPlan.brollPlacements) {
    preliminaryActions.push({
      type: "insert_stock",
      start: broll.start,
      duration: broll.duration,
      stockQuery: broll.query,
      transcriptContext: broll.transcriptContext,
      reason: broll.reason,
      priority: broll.priority,
    });
  }

  const actionsSummary = preliminaryActions.slice(0, 20).map(a => {
    if (a.type === "insert_stock") {
      return `[${a.start?.toFixed(1)}s] insert_stock: "${a.stockQuery}" (${a.duration}s)`;
    } else if (a.type === "cut") {
      return `[${a.start?.toFixed(1)}s-${a.end?.toFixed(1)}s] cut: ${a.reason}`;
    } else if (a.type === "keep") {
      return `[${a.start?.toFixed(1)}s-${a.end?.toFixed(1)}s] keep: ${a.reason}`;
    }
    return `[${a.start?.toFixed(1)}s] ${a.type}`;
  }).join("\n");

  const reviewPrompt = `You are a senior video editor performing quality review. Review this edit plan for consistency and quality.

USER'S EDITING INSTRUCTIONS: "${prompt}"

VIDEO INFO:
- Duration: ${duration.toFixed(1)} seconds
- Genre: ${genre}
- Quality map overall engagement: ${qualityMap.overallEngagement}
- Hook strength: ${qualityMap.hookStrength}

STRUCTURE:
- Intro: ${structuredPlan.introSection ? `${structuredPlan.introSection.start}s-${structuredPlan.introSection.end}s` : "None"}
- Main content: ${structuredPlan.mainContentSection.start}s-${structuredPlan.mainContentSection.end}s
- Outro: ${structuredPlan.outroSection ? `${structuredPlan.outroSection.start}s-${structuredPlan.outroSection.end}s` : "None"}

PRELIMINARY ACTIONS (${preliminaryActions.length} total):
${actionsSummary}

REVIEW CHECKLIST:
1. NO OVERLAPPING EDITS - cuts/B-roll should not conflict
2. PROPER B-ROLL SPACING - minimum 3 seconds between B-roll clips
3. NARRATIVE FLOW - edits should preserve story arc
4. PACING - matches content type (${genre})
5. B-ROLL RELEVANCE - queries match transcript context

SCORE EACH ACTION (0-100):
- 90-100: Excellent, essential edit
- 70-89: Good, adds value
- 50-69: Acceptable
- 30-49: Marginal, could skip
- 0-29: Remove this action

QUALITY METRICS:
- Pacing: Does edit pacing match content type?
- B-roll Relevance: How well do B-roll queries match spoken content?
- Narrative Flow: Do edits preserve the story/message?

Generate the FINAL reviewed and refined edit plan.
- Keep only valuable actions
- Add any missing keep segments
- Ensure complete video coverage
- Score each action

Respond in JSON format only (no markdown):
{
  "actions": [
    {
      "type": "keep|cut|insert_stock|add_caption|transition",
      "start": number,
      "end": number (for keep/cut),
      "duration": number (for insert_stock),
      "stockQuery": "string (for insert_stock)",
      "transcriptContext": "string (for insert_stock)",
      "reason": "string",
      "priority": "high|medium|low",
      "qualityScore": number (0-100)
    }
  ],
  "qualityMetrics": {
    "pacing": "slow|moderate|fast",
    "brollRelevance": "high|medium|low",
    "narrativeFlow": "high|medium|low",
    "overallScore": number (0-100)
  },
  "recommendations": ["improvement suggestions"],
  "warnings": ["potential issues detected"]
}`;

  try {
    const response = await withRetry(
      () => getGeminiClient().models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: reviewPrompt }] }],
      }),
      "pass4QualityReview",
      AI_RETRY_OPTIONS
    );

    const text = response.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) {
      aiLogger.warn("Pass 4: Failed to parse quality review, using preliminary actions");
      return getDefaultReviewedPlan(preliminaryActions, qualityMap, duration);
    }

    const parsed = JSON.parse(jsonMatch[0]);
    
    // Validate with Zod schema
    const validated = ReviewedEditPlanSchema.safeParse(parsed);
    if (!validated.success) {
      aiLogger.warn("Pass 4: Schema validation failed, using preliminary actions:", validated.error.issues);
      return getDefaultReviewedPlan(preliminaryActions, qualityMap, duration);
    }
    
    // Parse and validate actions with timing constraints
    // Cast to EditAction to handle discriminated union types
    const reviewedActions: EditAction[] = validated.data.actions.map(a => {
      const rawAction = a as Record<string, unknown>;
      const action: EditAction = {
        type: a.type,
        start: typeof rawAction.start === "number" ? Math.max(0, rawAction.start) : undefined,
        end: typeof rawAction.end === "number" ? Math.min(duration, rawAction.end) : undefined,
        duration: typeof rawAction.duration === "number" ? rawAction.duration : undefined,
        stockQuery: typeof rawAction.stockQuery === "string" ? rawAction.stockQuery : undefined,
        transcriptContext: typeof rawAction.transcriptContext === "string" ? rawAction.transcriptContext : undefined,
        reason: typeof rawAction.reason === "string" ? rawAction.reason : undefined,
        priority: typeof rawAction.priority === "string" ? (rawAction.priority as "low" | "medium" | "high") : undefined,
        qualityScore: typeof rawAction.qualityScore === "number" ? rawAction.qualityScore : 50,
      };
      return action;
    });

    // Ensure there's at least one keep action
    const hasKeepActions = reviewedActions.some(a => a.type === "keep");
    if (!hasKeepActions) {
      reviewedActions.push({
        type: "keep",
        start: 0,
        end: duration,
        reason: "Default keep - entire video",
        priority: "medium",
        qualityScore: 60,
      });
    }

    return {
      actions: reviewedActions,
      qualityMetrics: validated.data.qualityMetrics || {
        pacing: "moderate",
        brollRelevance: "medium",
        narrativeFlow: "medium",
        overallScore: 60,
      },
      recommendations: validated.data.recommendations,
      warnings: validated.data.warnings,
    };
  } catch (error) {
    aiLogger.error("Pass 4 error:", error);
    return getDefaultReviewedPlan(preliminaryActions, qualityMap, duration);
  }
}

function getDefaultReviewedPlan(
  preliminaryActions: EditAction[],
  qualityMap: QualityMap,
  duration: number
): ReviewedEditPlan {
  // Add default quality scores
  const scoredActions = preliminaryActions.map(a => ({
    ...a,
    qualityScore: a.type === "keep" ? 70 : a.type === "insert_stock" ? 60 : 50,
  }));

  // Ensure keep coverage
  const hasKeepActions = scoredActions.some(a => a.type === "keep");
  if (!hasKeepActions) {
    scoredActions.push({
      type: "keep",
      start: 0,
      end: duration,
      reason: "Default keep - entire video",
      priority: "medium",
      qualityScore: 60,
    });
  }

  return {
    actions: scoredActions,
    qualityMetrics: {
      pacing: "moderate",
      brollRelevance: "medium",
      narrativeFlow: "medium",
      overallScore: qualityMap.overallEngagement,
    },
    recommendations: [],
    warnings: [],
  };
}

/**
 * Generate Smart Edit Plan - Multi-Pass Intelligent Edit Planning System
 * 
 * Orchestrates 4 passes to create a high-quality, context-aware edit plan:
 * 1. Structure Analysis - Identify video sections and narrative arc
 * 2. Quality Assessment - Score segments for engagement potential
 * 3. B-Roll Optimization - Intelligent B-roll placement with ultra-specific queries
 * 4. Quality Review - Review and refine the final edit plan
 * 
 * @param prompt - User's editing instructions
 * @param analysis - Video analysis with frames, scenes, emotions, etc.
 * @param transcript - Array of transcript segments with timing
 * @param semanticAnalysis - Semantic analysis with topics, B-roll windows, etc.
 * @param fillerSegments - Detected filler word segments
 * @returns EditPlan with quality metrics and scored actions
 */
export async function generateSmartEditPlan(
  prompt: string,
  analysis: VideoAnalysis,
  transcript: TranscriptSegment[],
  semanticAnalysis: SemanticAnalysis,
  fillerSegments: { start: number; end: number; word: string }[]
): Promise<EditPlan> {
  aiLogger.info("Starting multi-pass smart edit planning...");
  const startTime = Date.now();

  // Pass 1: Structure Analysis
  aiLogger.info("Pass 1: Analyzing video structure...");
  const structuredPlan = await executePass1StructureAnalysis(analysis, transcript, semanticAnalysis);
  aiLogger.debug(`Pass 1 complete: ${structuredPlan.narrativeArc} structure with ${structuredPlan.sectionMarkers.length} markers`);

  // Pass 2: Quality Assessment
  aiLogger.info("Pass 2: Assessing segment quality...");
  const qualityMap = await executePass2QualityAssessment(
    analysis, transcript, semanticAnalysis, structuredPlan, fillerSegments
  );
  aiLogger.debug(`Pass 2 complete: ${qualityMap.segmentScores.length} segments scored, hook strength: ${qualityMap.hookStrength}`);

  // Pass 3: B-Roll Optimization
  aiLogger.info("Pass 3: Optimizing B-roll placement...");
  const brollPlan = await executePass3BrollOptimization(
    analysis, transcript, semanticAnalysis, structuredPlan, qualityMap, fillerSegments
  );
  aiLogger.debug(`Pass 3 complete: ${brollPlan.brollPlacements.length} B-roll placements, ${brollPlan.fillerActions.length} filler actions`);

  // Pass 4: Quality Review & Refinement
  aiLogger.info("Pass 4: Quality review and refinement...");
  const reviewedPlan = await executePass4QualityReview(
    analysis, structuredPlan, qualityMap, brollPlan, prompt
  );
  aiLogger.debug(`Pass 4 complete: ${reviewedPlan.actions.length} final actions, overall score: ${reviewedPlan.qualityMetrics.overallScore}`);

  // Validate and fix B-roll spacing one final time
  const validatedActions = validateAndFixBrollActions(reviewedPlan.actions, analysis.duration);

  // Build final edit plan
  const elapsedTime = Date.now() - startTime;
  aiLogger.info(`Multi-pass smart edit planning complete in ${elapsedTime}ms`);

  // Extract unique stock queries
  const stockQueriesSet = new Set(
    validatedActions
      .filter(a => a.type === "insert_stock" && a.stockQuery)
      .map(a => a.stockQuery!)
  );
  const stockQueries = Array.from(stockQueriesSet);

  // Extract key points from structure analysis
  const keyPoints = [
    ...(structuredPlan.sectionMarkers.filter(m => m.type === "climax" || m.type === "section_change").map(m => m.description)),
    ...(qualityMap.mustKeepSegments.map(s => s.reason)),
  ].slice(0, 10);

  // Estimate final duration after cuts
  const cutDuration = validatedActions
    .filter(a => a.type === "cut" && a.start !== undefined && a.end !== undefined)
    .reduce((total, a) => total + ((a.end || 0) - (a.start || 0)), 0);
  const estimatedDuration = Math.max(1, analysis.duration - cutDuration);

  return {
    actions: validatedActions,
    stockQueries,
    keyPoints,
    estimatedDuration,
    editingStrategy: {
      approach: `Multi-pass ${structuredPlan.narrativeArc} editing with ${brollPlan.brollPlacements.length} B-roll placements`,
      focusAreas: ["Narrative flow preservation", "Engagement optimization", "Context-aware B-roll"],
      avoidAreas: reviewedPlan.warnings.slice(0, 3),
    },
    qualityMetrics: reviewedPlan.qualityMetrics,
  };
}

/**
 * Deep Video Analysis - Comprehensive analysis combining multiple AI capabilities
 * 
 * This function performs a thorough analysis of a video by:
 * 1. Analyzing video frames for visual content, scenes, emotions, speakers
 * 2. Analyzing transcript for semantics, topics, hooks, and structure
 * 3. Detecting filler words in the transcript
 * 4. Computing quality insights and recommendations
 * 
 * @param framePaths - Array of paths to extracted video frames
 * @param duration - Total video duration in seconds
 * @param silentSegments - Array of detected silent segments
 * @param transcript - Array of transcript segments with timing
 * @returns Comprehensive analysis with video, semantic, filler, and quality data
 */
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
  aiLogger.info("Starting deep video analysis...");
  
  // Run frame analysis and transcript analysis in parallel for efficiency
  const [videoAnalysis, semanticAnalysisResult] = await Promise.all([
    analyzeVideoFrames(framePaths, duration, silentSegments),
    analyzeTranscriptSemantics(transcript, undefined, duration),
  ]);
  
  // Update semantic analysis with video context if available
  let semanticAnalysis = semanticAnalysisResult;
  if (videoAnalysis.context) {
    // Re-run semantic analysis with video context for better B-roll queries
    semanticAnalysis = await analyzeTranscriptSemantics(
      transcript,
      videoAnalysis.context,
      duration
    );
  }
  
  // Run filler word detection
  const fillerSegments = detectFillerWords(transcript);
  
  // Compute quality insights
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

/**
 * Compute quality insights from analysis results
 */
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
  
  // Calculate hook strength (0-100)
  let hookStrength = 50; // Default baseline
  
  // Check for hooks in video analysis keyMoments
  const hooks = videoAnalysis.keyMoments?.filter(k => k.type === "hook") || [];
  if (hooks.length > 0) {
    const maxHookScore = Math.max(...hooks.map(h => h.hookScore || 50));
    hookStrength = maxHookScore;
  }
  
  // Also check semantic analysis hook moments
  if (semanticAnalysis.hookMoments && semanticAnalysis.hookMoments.length > 0) {
    const maxSemanticHook = Math.max(...semanticAnalysis.hookMoments.map(h => h.score));
    hookStrength = Math.max(hookStrength, maxSemanticHook);
  }
  
  // Low hook strength recommendation
  if (hookStrength < 60) {
    recommendations.push("Consider adding a stronger hook in the first 3-5 seconds to grab viewer attention");
  }
  
  // Calculate pacing score based on scene changes and topic flow
  let pacingScore = 70; // Default baseline
  
  const sceneCount = videoAnalysis.scenes?.length || 1;
  const topicCount = semanticAnalysis.topicFlow?.length || 1;
  const averageSceneDuration = duration / sceneCount;
  const averageTopicDuration = duration / topicCount;
  
  // Optimal scene duration is 10-30 seconds for most content
  if (averageSceneDuration < 5) {
    pacingScore = Math.max(40, pacingScore - 20);
    recommendations.push("Pacing may be too fast - scenes change very quickly");
  } else if (averageSceneDuration > 60) {
    pacingScore = Math.max(40, pacingScore - 15);
    recommendations.push("Consider adding more visual variety - scenes are quite long");
  } else if (averageSceneDuration >= 10 && averageSceneDuration <= 30) {
    pacingScore = Math.min(100, pacingScore + 15);
  }
  
  // Topic flow affects pacing perception
  if (averageTopicDuration > 90) {
    recommendations.push("Topics could be broken into smaller segments for better engagement");
  }
  
  // Calculate engagement prediction
  let engagementPrediction = 60; // Default baseline
  
  // High visual importance segments increase engagement
  const highImportanceScenes = videoAnalysis.scenes?.filter(s => s.visualImportance === "high") || [];
  if (highImportanceScenes.length > 0) {
    const highImportanceRatio = highImportanceScenes.length / (sceneCount || 1);
    engagementPrediction += highImportanceRatio * 20;
  }
  
  // Key moments increase engagement
  const keyMomentCount = (videoAnalysis.keyMoments?.length || 0) + (semanticAnalysis.keyMoments?.length || 0);
  if (keyMomentCount >= 3) {
    engagementPrediction += 10;
  }
  
  // Filler words decrease engagement prediction
  const fillerRatio = fillerSegments.length / Math.max(transcript.length, 1);
  if (fillerRatio > 0.2) {
    engagementPrediction -= 15;
    recommendations.push("High number of filler words detected - consider editing them out for smoother delivery");
  } else if (fillerRatio > 0.1) {
    engagementPrediction -= 5;
    recommendations.push("Some filler words detected - minor edits could improve flow");
  }
  
  // Hook strength affects engagement
  engagementPrediction += (hookStrength - 50) * 0.3;
  
  // Emotion variety increases engagement
  const uniqueEmotions = new Set(videoAnalysis.emotionFlow?.map(e => e.emotion) || []);
  if (uniqueEmotions.size >= 3) {
    engagementPrediction += 10;
  } else if (uniqueEmotions.size === 1) {
    recommendations.push("Consider varying emotional tone throughout the video for better engagement");
  }
  
  // Check for climax/call-to-action
  const hasClimax = videoAnalysis.keyMoments?.some(k => k.type === "climax");
  const hasCallToAction = videoAnalysis.keyMoments?.some(k => k.type === "callToAction");
  
  if (!hasClimax) {
    recommendations.push("Consider adding a clear climax or peak moment to maintain viewer interest");
  }
  if (!hasCallToAction) {
    recommendations.push("Consider adding a call-to-action to improve viewer engagement and retention");
  }
  
  // Clamp values
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
