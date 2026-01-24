import { GoogleGenAI } from "@google/genai";
import OpenAI, { toFile } from "openai";
import { promises as fs } from "fs";
import { z } from "zod";
import type {
  VideoAnalysis,
  FrameAnalysis,
  EditPlan,
  EditAction,
  TranscriptSegment,
  VideoContext,
  TopicSegment,
} from "@shared/schema";

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
});

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
  const brollActions = actions.filter(a => a.type === "insert_stock");
  const otherActions = actions.filter(a => a.type !== "insert_stock");
  
  const brollWithTiming = brollActions.map((a, index) => ({
    ...a,
    start: a.start ?? (index * 10),
  }));
  
  brollWithTiming.sort((a, b) => (a.start || 0) - (b.start || 0));
  
  const validatedBroll: EditAction[] = [];
  let lastEnd = -2;
  
  for (const action of brollWithTiming) {
    const start = Math.max(0, action.start || 0);
    const actionDuration = action.duration || 3;
    
    if (start >= lastEnd + 2 && start < duration - 1) {
      validatedBroll.push({
        ...action,
        start,
        duration: Math.min(6, Math.max(2, actionDuration)),
      });
      lastEnd = start + actionDuration;
    } else {
      console.log(`Skipping overlapping B-roll at ${start}s (previous ended at ${lastEnd}s)`);
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

  const response = await geminiClient.models.generateContent({
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
  });

  const text = response.text || "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.warn("Failed to parse AI response for frame analysis, using defaults");
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
      console.warn("AI response validation failed:", validated.error);
    }
  } catch (parseError) {
    console.warn("JSON parse error in frame analysis:", parseError);
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

export async function transcribeAudio(
  audioPath: string
): Promise<TranscriptSegment[]> {
  try {
    const audioBuffer = await fs.readFile(audioPath);
    const file = await toFile(audioBuffer, "audio.mp3");

    const response = await openaiClient.audio.transcriptions.create({
      file,
      model: "whisper-1",
      response_format: "verbose_json",
      timestamp_granularities: ["segment"],
    }) as any;

    if (response.segments && Array.isArray(response.segments)) {
      return response.segments.map((seg: any) => ({
        start: seg.start || 0,
        end: seg.end || (seg.start || 0) + 3,
        text: (seg.text || "").trim(),
      })).filter((s: TranscriptSegment) => s.text.length > 0);
    }

    const text = response.text || "";
    if (!text.trim()) {
      return [];
    }

    console.warn("Transcription returned text only, timestamps will be approximate");
    const sentences = text.split(/[.!?]+/).filter((s: string) => s.trim());
    const segmentDuration = 4;
    
    return sentences.map((sentence: string, i: number) => ({
      start: i * segmentDuration,
      end: (i + 1) * segmentDuration,
      text: sentence.trim(),
    }));
  } catch (error) {
    console.error("Transcription error:", error);
    return [];
  }
}

export async function generateEditPlan(
  prompt: string,
  analysis: VideoAnalysis,
  transcript: TranscriptSegment[]
): Promise<EditPlan> {
  const contextInfo = analysis.context;
  const editStyleGuidance = getEditStyleGuidance(contextInfo);
  
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

3. "insert_stock" - OVERLAY B-roll footage (original audio CONTINUES)
   - This is a VISUAL OVERLAY - the speaker's voice keeps playing
   - Use to illustrate concepts, add visual interest during explanatory speech
   - NEVER place during important visual moments (demonstrations, facial expressions)
   - Provide: start time, duration (2-6 seconds), specific search query
   - Priority: high for abstract concepts, medium for examples, low for optional enhancement

4. "add_caption" - Add captions for key dialogue
   - Use for: important quotes, key takeaways, memorable lines

5. "add_text_overlay" - Add emphasis text
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

  const brollOppsSummary = analysis.brollOpportunities?.slice(0, 5).map(b => 
    `  - ${b.start.toFixed(1)}s-${b.end.toFixed(1)}s: "${b.query}" (${b.priority} priority) - ${b.reason}`
  ).join("\n") || "No specific opportunities identified";

  const topicsSummary = analysis.topicSegments?.map(t =>
    `  - ${t.start.toFixed(1)}s-${t.end.toFixed(1)}s: ${t.topic} (${t.importance || "medium"} importance)`
  ).join("\n") || "No topic segments identified";

  const userPrompt = `User's editing instructions: "${prompt}"

VIDEO SUMMARY:
${analysis.summary || "No summary available"}

NARRATIVE STRUCTURE:
${analysis.narrativeStructure ? `
- Has intro: ${analysis.narrativeStructure.hasIntro ? `Yes, ends at ${analysis.narrativeStructure.introEnd}s` : "No"}
- Main content: ${analysis.narrativeStructure.mainContentStart || 0}s to ${analysis.narrativeStructure.mainContentEnd || analysis.duration}s
- Has outro: ${analysis.narrativeStructure.hasOutro ? `Yes, starts at ${analysis.narrativeStructure.outroStart}s` : "No"}
- Peak moments: ${analysis.narrativeStructure.peakMoments?.map(t => t.toFixed(1) + "s").join(", ") || "None identified"}
` : "Not analyzed"}

TOPIC SEGMENTS:
${topicsSummary}

PRE-IDENTIFIED B-ROLL OPPORTUNITIES:
${brollOppsSummary}

SILENT SEGMENTS (candidates for cutting):
${analysis.silentSegments?.map(s => `  - ${s.start.toFixed(1)}s to ${s.end.toFixed(1)}s`).join("\n") || "None detected"}

TRANSCRIPT:
${transcript.slice(0, 50).map(t => `[${t.start.toFixed(1)}s-${t.end.toFixed(1)}s]: ${t.text}`).join("\n")}
${transcript.length > 50 ? `\n... (${transcript.length - 50} more segments)` : ""}

Total video duration: ${analysis.duration.toFixed(1)} seconds

CREATE YOUR EDIT PLAN:
1. Use the pre-identified B-roll opportunities as a starting point
2. Adjust timing based on transcript alignment
3. Ensure B-roll doesn't overlap and has appropriate spacing
4. Cut silent/boring sections while preserving narrative flow
5. Add captions for key moments

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
  }
}`;

  const response = await geminiClient.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [{ text: systemPrompt + "\n\n" + userPrompt }],
      },
    ],
  });

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
    console.warn("No JSON found in AI response for edit plan");
    return fallbackPlan();
  }

  let parsed: any;
  try {
    parsed = JSON.parse(jsonMatch[0]);
    const validated = EditPlanResponseSchema.safeParse(parsed);
    if (!validated.success) {
      console.warn("Edit plan validation warning:", validated.error);
    }
  } catch (parseError) {
    console.warn("JSON parse error in edit plan:", parseError);
    return fallbackPlan();
  }

  if (!parsed.actions || !Array.isArray(parsed.actions)) {
    console.warn("No valid actions array in AI response");
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
      console.warn("Skipping invalid action:", a, actionValidation.error);
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
