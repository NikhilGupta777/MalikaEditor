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
} from "@shared/schema";

const CutKeepActionSchema = z.object({
  type: z.enum(["cut", "keep"]),
  start: z.number().min(0),
  end: z.number().min(0),
  reason: z.string().optional(),
}).refine(data => data.end >= data.start, { message: "end must be >= start" });

const InsertStockActionSchema = z.object({
  type: z.literal("insert_stock"),
  start: z.number().min(0).optional(),
  stockQuery: z.string(),
  reason: z.string().optional(),
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
});

const FrameAnalysisSchema = z.object({
  timestamp: z.number().optional(),
  description: z.string().optional().default(""),
  keyMoment: z.boolean().optional().default(false),
  suggestedStockQuery: z.string().nullable().optional(),
});

const VideoAnalysisResponseSchema = z.object({
  frames: z.array(FrameAnalysisSchema),
  summary: z.string().optional().default(""),
  contentType: z.string().optional(),
});

const geminiClient = new GoogleGenAI({
  apiKey: process.env.AI_INTEGRATIONS_GEMINI_API_KEY,
  httpOptions: {
    apiVersion: "",
    baseUrl: process.env.AI_INTEGRATIONS_GEMINI_BASE_URL,
  },
});

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

  const prompt = `Analyze these ${framePaths.length} frames from a video that is ${duration.toFixed(1)} seconds long.
  
For each frame, provide:
1. A brief description of what's happening
2. Whether it appears to be a key moment worth keeping
3. If relevant, suggest a stock media search query that could enhance this section

Also provide an overall summary of the video content.

Silent segments detected in the video: ${JSON.stringify(silentSegments)}

Respond in JSON format only (no markdown):
{
  "frames": [
    {
      "timestamp": number,
      "description": "string",
      "keyMoment": boolean,
      "suggestedStockQuery": "string or null"
    }
  ],
  "summary": "string",
  "contentType": "string (e.g., 'tutorial', 'vlog', 'interview', 'presentation')"
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
  }));

  return {
    duration,
    frames,
    silentSegments,
    summary: parsed.summary || "",
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
      model: "gpt-4o-mini-transcribe",
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
  const systemPrompt = `You are an expert video editor AI. Based on the user's editing instructions, video analysis, and transcript, create a detailed edit plan.

The edit plan should include actions like:
- "cut": Remove boring or silent sections (the audio and video in this range will be removed)
- "keep": Keep important segments
- "insert_stock": Suggest where to OVERLAY stock footage/images visually. IMPORTANT: This does NOT cut the video - the stock media will fade in/out ON TOP of the original video while the original audio continues playing. Use this for B-roll to illustrate what the speaker is talking about.
- "add_caption": Add captions at key moments
- "add_text_overlay": Add text overlays for emphasis

Be cost-effective: minimize unnecessary edits while maximizing engagement based on the user's goals.

For each action, provide:
- type: the action type
- start: start time in seconds
- end: end time in seconds (for cuts/keeps, determines overlay duration for insert_stock)
- text: caption or overlay text (if applicable)
- stockQuery: search term for stock media (if applicable)
- reason: brief explanation of why this edit is recommended

Important notes:
- "keep" segments define what parts of the original video to include
- "insert_stock" actions are OVERLAYS - the original video and audio continue underneath while the stock media appears on top with fade effects
- Stock media overlays should be 2-4 seconds long and placed at moments where visual illustration would enhance the content`;

  const userPrompt = `User's editing instructions: "${prompt}"

Video Analysis:
${JSON.stringify(analysis, null, 2)}

Transcript:
${JSON.stringify(transcript, null, 2)}

Create an edit plan that follows the user's instructions. Make sure to:
1. Identify and mark boring/silent parts for removal
2. Keep engaging content
3. Suggest relevant stock media to enhance the video
4. Add captions for key dialogue
5. Estimate the final video duration

Respond with a JSON object only (no markdown code blocks):
{
  "actions": [...],
  "stockQueries": ["unique stock search terms"],
  "keyPoints": ["main topics/highlights"],
  "estimatedDuration": number
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

  return {
    actions,
    stockQueries: parsed.stockQueries || [],
    keyPoints: parsed.keyPoints || [],
    estimatedDuration: parsed.estimatedDuration || analysis.duration,
  };
}
