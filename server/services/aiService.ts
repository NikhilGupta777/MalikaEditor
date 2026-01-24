import { GoogleGenAI } from "@google/genai";
import OpenAI, { toFile } from "openai";
import { promises as fs } from "fs";
import type {
  VideoAnalysis,
  FrameAnalysis,
  EditPlan,
  EditAction,
  TranscriptSegment,
} from "@shared/schema";

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
    throw new Error("Failed to parse AI response");
  }

  const parsed = JSON.parse(jsonMatch[0]);

  const frames: FrameAnalysis[] = parsed.frames.map((f: any, i: number) => ({
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
    });

    const text = response.text || "";
    
    if (!text.trim()) {
      return [];
    }

    const sentences = text.split(/[.!?]+/).filter(s => s.trim());
    const segmentDuration = 5;
    
    return sentences.map((sentence, i) => ({
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
- "cut": Remove boring or silent sections
- "keep": Keep important segments
- "insert_stock": Suggest where to add stock footage/images
- "add_caption": Add captions at key moments
- "add_text_overlay": Add text overlays for emphasis
- "transition": Add transitions between segments

Be cost-effective: minimize unnecessary edits while maximizing engagement based on the user's goals.

For each action, provide:
- type: the action type
- start: start time in seconds (for cuts/keeps)
- end: end time in seconds (for cuts/keeps)
- text: caption or overlay text (if applicable)
- stockQuery: search term for stock media (if applicable)
- reason: brief explanation of why this edit is recommended

Important: Ensure "keep" segments cover the parts of the video that should remain. The final video will be constructed from "keep" segments.`;

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
  if (!jsonMatch) {
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
  }

  const parsed = JSON.parse(jsonMatch[0]);

  const actions: EditAction[] = parsed.actions.map((a: any) => ({
    type: a.type,
    start: a.start,
    end: a.end,
    text: a.text,
    stockQuery: a.stockQuery,
    transitionType: a.transitionType,
    speed: a.speed,
    reason: a.reason,
  }));

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
