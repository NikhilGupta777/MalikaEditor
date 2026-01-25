import { toFile } from "openai";
import { promises as fs } from "fs";
import { createLogger } from "../../utils/logger";
import { getOpenAIClient, getGeminiClient } from "./clients";
import type { TranscriptSegment } from "@shared/schema";

const aiLogger = createLogger("ai-service");

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

export function logTranscriptionConfig(): void {
  const hasOpenAIKey = !!process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  const hasGeminiKey = !!process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
  
  aiLogger.info("═══════════════════════════════════════════════════════");
  aiLogger.info("TRANSCRIPTION SYSTEM INITIALIZED");
  
  if (hasOpenAIKey) {
    aiLogger.info("Primary: OpenAI gpt-4o-mini-transcribe (via AI Integrations)");
  }
  
  if (hasGeminiKey) {
    aiLogger.info("Fallback: Gemini 2.5 Flash audio transcription");
  }
  
  if (!hasOpenAIKey && !hasGeminiKey) {
    aiLogger.error("WARNING: No transcription API keys configured");
    aiLogger.error("Transcription will fail. Please set up OpenAI or Gemini integration.");
  } else {
    aiLogger.info("Status: Ready");
  }
  
  aiLogger.info("═══════════════════════════════════════════════════════");
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function transcribeWithOpenAI(audioPath: string): Promise<TranscriptSegment[]> {
  aiLogger.info("Using OpenAI gpt-4o-mini-transcribe for transcription...");
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const audioBuffer = await fs.readFile(audioPath);
      const file = await toFile(audioBuffer, "audio.mp3");

      const response = await getOpenAIClient().audio.transcriptions.create({
        file,
        model: "gpt-4o-mini-transcribe",
        response_format: "json",
      }) as any;

      const text = response.text || "";
      
      if (!text.trim()) {
        aiLogger.warn("OpenAI transcription returned empty text");
        return [];
      }

      aiLogger.info(`OpenAI transcription successful (attempt ${attempt}). Text length: ${text.length} chars`);
      
      const sentences = text.split(/(?<=[.!?।])\s+/).filter((s: string) => s.trim());
      
      if (sentences.length === 0) {
        return [{
          start: 0,
          end: 10,
          text: text.trim(),
        }];
      }
      
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
      
      aiLogger.info(`Created ${segments.length} transcript segments with estimated timestamps`);
      return segments;
      
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      aiLogger.error(`OpenAI transcription attempt ${attempt}/${MAX_RETRIES} failed:`, errorMessage);
      
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        aiLogger.info(`Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }
  
  return [];
}

async function transcribeWithGemini(audioPath: string): Promise<TranscriptSegment[]> {
  aiLogger.info("Using Gemini 2.5 Flash for audio transcription (fallback)...");
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const audioBuffer = await fs.readFile(audioPath);
      const base64Audio = audioBuffer.toString('base64');
      
      const ext = audioPath.split('.').pop()?.toLowerCase() || 'mp3';
      const mimeType = ext === 'wav' ? 'audio/wav' : 
                       ext === 'mp4' ? 'audio/mp4' :
                       ext === 'm4a' ? 'audio/mp4' :
                       ext === 'ogg' ? 'audio/ogg' :
                       ext === 'webm' ? 'audio/webm' :
                       'audio/mpeg';

      const gemini = getGeminiClient();
      const response = await gemini.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
          {
            role: "user",
            parts: [
              {
                inlineData: {
                  mimeType: mimeType,
                  data: base64Audio,
                }
              },
              {
                text: `Transcribe this audio accurately. Include all spoken words. 
If the audio contains speech in any language (including Hindi, English, or any other), transcribe it in the original language.
Return ONLY the transcription text, nothing else. No explanations, no timestamps, just the spoken words.`
              }
            ]
          }
        ],
        config: {
          maxOutputTokens: 8192,
        }
      });

      const text = response.text?.trim() || "";
      
      if (!text) {
        aiLogger.warn("Gemini transcription returned empty text");
        return [];
      }

      aiLogger.info(`Gemini transcription successful (attempt ${attempt}). Text length: ${text.length} chars`);
      
      const sentences = text.split(/(?<=[.!?।])\s+/).filter((s: string) => s.trim());
      
      if (sentences.length === 0) {
        return [{
          start: 0,
          end: 10,
          text: text.trim(),
        }];
      }
      
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
      
      aiLogger.info(`Created ${segments.length} transcript segments with estimated timestamps`);
      return segments;
      
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      aiLogger.error(`Gemini transcription attempt ${attempt}/${MAX_RETRIES} failed:`, errorMessage);
      
      if (errorMessage.includes("8 MB") || errorMessage.includes("too large")) {
        aiLogger.warn("Audio file too large for Gemini inline data. Consider chunking for very long videos.");
        break;
      }
      
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        aiLogger.info(`Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }
  
  return [];
}

export async function transcribeAudio(
  audioPath: string
): Promise<TranscriptSegment[]> {
  aiLogger.info("Starting audio transcription...");
  
  const hasOpenAI = !!process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  const hasGemini = !!process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
  
  if (hasOpenAI) {
    const openAIResult = await transcribeWithOpenAI(audioPath);
    if (openAIResult.length > 0) {
      aiLogger.info(`Transcription successful with OpenAI: ${openAIResult.length} segments extracted`);
      return openAIResult;
    }
    aiLogger.warn("OpenAI transcription failed, trying Gemini fallback...");
  }
  
  if (hasGemini) {
    const geminiResult = await transcribeWithGemini(audioPath);
    if (geminiResult.length > 0) {
      aiLogger.info(`Transcription successful with Gemini: ${geminiResult.length} segments extracted`);
      return geminiResult;
    }
  }
  
  aiLogger.error("All transcription methods failed. No segments extracted.");
  return [];
}
