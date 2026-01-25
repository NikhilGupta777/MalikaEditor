import { toFile } from "openai";
import { promises as fs } from "fs";
import { createLogger } from "../../utils/logger";
import { getOpenAIClient } from "./clients";
import type { TranscriptSegment } from "@shared/schema";

const aiLogger = createLogger("ai-service");

export function logTranscriptionConfig(): void {
  const hasOpenAIKey = !!process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  
  if (hasOpenAIKey) {
    aiLogger.info("═══════════════════════════════════════════════════════");
    aiLogger.info("TRANSCRIPTION SYSTEM INITIALIZED");
    aiLogger.info("Mode: OpenAI whisper-1 (primary transcription method)");
    aiLogger.info("Status: Ready");
    aiLogger.info("═══════════════════════════════════════════════════════");
  } else {
    aiLogger.error("═══════════════════════════════════════════════════════");
    aiLogger.error("WARNING: OpenAI API key not configured");
    aiLogger.error("Transcription will fail. Please set up OpenAI integration.");
    aiLogger.error("═══════════════════════════════════════════════════════");
  }
  
  aiLogger.debug("Local whisper.cpp: NOT CONFIGURED (using OpenAI API)");
}

async function transcribeWithOpenAI(audioPath: string): Promise<TranscriptSegment[]> {
  try {
    aiLogger.info("Using OpenAI whisper-1 for transcription with word-level timestamps...");
    const audioBuffer = await fs.readFile(audioPath);
    const file = await toFile(audioBuffer, "audio.mp3");

    const response = await getOpenAIClient().audio.transcriptions.create({
      file,
      model: "whisper-1",
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

export async function transcribeAudio(
  audioPath: string
): Promise<TranscriptSegment[]> {
  aiLogger.info("Starting audio transcription with OpenAI whisper-1...");
  const result = await transcribeWithOpenAI(audioPath);
  
  if (result.length > 0) {
    aiLogger.info(`Transcription successful: ${result.length} segments extracted`);
  } else {
    aiLogger.error("Transcription failed: no segments extracted from audio");
  }
  
  return result;
}
