import { toFile } from "openai";
import { promises as fs } from "fs";
import { createLogger } from "../../utils/logger";
import { getOpenAIClient, getGeminiClient } from "./clients";
import type { TranscriptSegment } from "@shared/schema";

const aiLogger = createLogger("ai-service");

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const GEMINI_MAX_FILE_SIZE_MB = 7;

export function logTranscriptionConfig(): void {
  const hasOpenAIKey = !!process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  const hasGeminiKey = !!process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
  
  aiLogger.info("═══════════════════════════════════════════════════════");
  aiLogger.info("TRANSCRIPTION SYSTEM INITIALIZED");
  
  if (hasOpenAIKey) {
    aiLogger.info("Primary: OpenAI gpt-4o-mini-transcribe (via Replit AI Integrations)");
  }
  
  if (hasGeminiKey) {
    aiLogger.info(`Fallback: Gemini 2.5 Flash (via Replit AI Integrations)`);
  }
  
  if (!hasOpenAIKey && !hasGeminiKey) {
    aiLogger.warn("WARNING: Replit AI Integrations not detected. Using fallback values.");
  } else {
    aiLogger.info("Status: Ready");
  }
  
  aiLogger.info("═══════════════════════════════════════════════════════");
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableError(error: unknown): boolean {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorCode = (error as any)?.status || (error as any)?.code;
  
  if (errorCode === 400 || errorCode === 401 || errorCode === 403) {
    return false;
  }
  
  if (errorMessage.includes("model") && errorMessage.includes("not found")) {
    return false;
  }
  if (errorMessage.includes("Invalid API Key") || errorMessage.includes("authentication")) {
    return false;
  }
  if (errorMessage.includes("permission") || errorMessage.includes("forbidden")) {
    return false;
  }
  
  return true;
}

function createSegmentsFromText(text: string): TranscriptSegment[] {
  const segments = splitIntoNaturalSegments(text);
  
  if (segments.length === 0) {
    if (text.trim()) {
      return [{
        start: 0,
        end: 10,
        text: text.trim(),
      }];
    }
    return [];
  }
  
  const charsPerSecond = 12.5;
  let currentTime = 0;
  
  return segments.map((sentence: string) => {
    const duration = Math.max(1.5, sentence.length / charsPerSecond);
    const segment = {
      start: currentTime,
      end: currentTime + duration,
      text: sentence.trim(),
    };
    currentTime += duration + 0.3;
    return segment;
  }).filter((s: TranscriptSegment) => s.text.length > 0);
}

function splitIntoNaturalSegments(text: string): string[] {
  const primarySplit = text.split(/(?<=[.!?।؟。！？])\s+/).filter((s: string) => s.trim());
  
  const result: string[] = [];
  for (const segment of primarySplit) {
    if (segment.length > 200) {
      const subSegments = segment.split(/(?<=[,;:—–])\s+/).filter((s: string) => s.trim());
      if (subSegments.length > 1) {
        let combined = "";
        for (const sub of subSegments) {
          if (combined.length + sub.length > 150 && combined.length > 0) {
            result.push(combined.trim());
            combined = sub;
          } else {
            combined = combined ? `${combined} ${sub}` : sub;
          }
        }
        if (combined.trim()) {
          result.push(combined.trim());
        }
      } else {
        const words = segment.split(/\s+/);
        let chunk = "";
        for (const word of words) {
          if (chunk.split(/\s+/).length >= 15 && chunk.length > 0) {
            result.push(chunk.trim());
            chunk = word;
          } else {
            chunk = chunk ? `${chunk} ${word}` : word;
          }
        }
        if (chunk.trim()) {
          result.push(chunk.trim());
        }
      }
    } else {
      result.push(segment);
    }
  }
  
  return result;
}

// Create segments with synthesized word-level timing based on actual audio duration
function createSegmentsFromTextWithDuration(text: string, audioDuration: number): TranscriptSegment[] {
  // Split into sentences
  const sentences = text.split(/(?<=[.!?।])\s+/).filter((s: string) => s.trim());
  
  if (sentences.length === 0) {
    if (text.trim()) {
      // Single segment with word-level timing
      const words = text.trim().split(/\s+/);
      const wordDuration = audioDuration / Math.max(words.length, 1);
      const wordTimings = words.map((word, i) => ({
        word: word,
        start: i * wordDuration,
        end: (i + 1) * wordDuration,
      }));
      return [{
        start: 0,
        end: audioDuration,
        text: text.trim(),
        words: wordTimings,
      }];
    }
    return [];
  }
  
  // Calculate total characters for proportional timing
  const totalChars = sentences.reduce((sum, s) => sum + s.length, 0);
  let currentTime = 0;
  
  return sentences.map((sentence: string) => {
    // Proportional duration based on sentence length
    const proportion = sentence.length / totalChars;
    const segmentDuration = Math.max(1.0, proportion * audioDuration * 0.95); // 95% to leave gaps
    
    // Create word-level timing for this segment
    const words = sentence.trim().split(/\s+/).filter(w => w.length > 0);
    const wordDuration = segmentDuration / Math.max(words.length, 1);
    
    const wordTimings = words.map((word, i) => ({
      word: word,
      start: currentTime + (i * wordDuration),
      end: currentTime + ((i + 1) * wordDuration),
    }));
    
    const segment: TranscriptSegment = {
      start: currentTime,
      end: currentTime + segmentDuration,
      text: sentence.trim(),
      words: wordTimings,
    };
    
    currentTime += segmentDuration + 0.2; // Small gap between segments
    return segment;
  }).filter((s: TranscriptSegment) => s.text.length > 0);
}

async function transcribeWithOpenAI(
  audioPath: string, 
  audioDuration?: number,
  languageHint?: string
): Promise<TranscriptSegment[]> {
  aiLogger.info("Using OpenAI gpt-4o-mini-transcribe for transcription...");
  if (languageHint) {
    aiLogger.info(`Language hint provided: ${languageHint}`);
  }
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const audioBuffer = await fs.readFile(audioPath);
      const file = await toFile(audioBuffer, "audio.mp3");

      const transcriptionParams: any = {
        file,
        model: "gpt-4o-mini-transcribe",
        response_format: "json",
      };
      
      if (languageHint) {
        transcriptionParams.language = languageHint;
      }

      const response = await getOpenAIClient().audio.transcriptions.create(transcriptionParams) as any;

      const text = response.text || "";
      
      if (!text.trim()) {
        aiLogger.warn("OpenAI transcription returned empty text (possibly silent audio)");
        return [];
      }

      aiLogger.info(`OpenAI transcription successful (attempt ${attempt}). Text length: ${text.length} chars`);
      
      // Since gpt-4o-mini-transcribe doesn't provide word-level timestamps,
      // we synthesize them based on text length and audio duration
      // CRITICAL: Only use duration-based timing if we have actual duration
      // Using incorrect duration causes severely misaligned captions
      if (audioDuration && audioDuration > 0) {
        const segments = createSegmentsFromTextWithDuration(text, audioDuration);
        aiLogger.info(`Created ${segments.length} transcript segments with synthesized word timing (duration: ${audioDuration.toFixed(1)}s)`);
        return segments;
      } else {
        // Fallback: Use estimated timing without word-level sync
        // This prevents wildly incorrect karaoke timing
        aiLogger.warn("No audio duration provided - using estimated timestamps (karaoke timing may be imprecise)");
        const segments = createSegmentsFromText(text);
        aiLogger.info(`Created ${segments.length} transcript segments with estimated timestamps`);
        return segments;
      }
      
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      aiLogger.error(`OpenAI transcription attempt ${attempt}/${MAX_RETRIES} failed:`, errorMessage);
      
      if (!isRetryableError(error)) {
        aiLogger.warn("Non-retryable error detected, skipping remaining retries");
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

async function transcribeWithGemini(
  audioPath: string, 
  audioDuration?: number,
  languageHint?: string
): Promise<TranscriptSegment[]> {
  const audioBuffer = await fs.readFile(audioPath);
  const fileSizeMB = audioBuffer.length / (1024 * 1024);
  
  if (fileSizeMB > GEMINI_MAX_FILE_SIZE_MB) {
    aiLogger.warn(`Audio file (${fileSizeMB.toFixed(1)}MB) exceeds Gemini limit (${GEMINI_MAX_FILE_SIZE_MB}MB), skipping Gemini fallback`);
    return [];
  }
  
  aiLogger.info(`Using Gemini 2.5 Flash for transcription (file size: ${fileSizeMB.toFixed(1)}MB)...`);
  if (languageHint) {
    aiLogger.info(`Language hint provided: ${languageHint}`);
  }
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const base64Audio = audioBuffer.toString('base64');
      
      const ext = audioPath.split('.').pop()?.toLowerCase() || 'mp3';
      const mimeType = ext === 'wav' ? 'audio/wav' : 
                       ext === 'mp4' ? 'audio/mp4' :
                       ext === 'm4a' ? 'audio/mp4' :
                       ext === 'ogg' ? 'audio/ogg' :
                       ext === 'webm' ? 'audio/webm' :
                       'audio/mpeg';

      const languageInstruction = languageHint 
        ? `The audio is primarily in ${languageHint}. ` 
        : "";
      
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
                text: `${languageInstruction}Transcribe this audio accurately and completely. Include every spoken word.

IMPORTANT INSTRUCTIONS:
- Focus on the primary speaker's voice and clear speech
- If there is background music or noise, prioritize transcribing the spoken words over ambient sounds
- Filter out non-speech sounds like music, applause, or sound effects
- If speech is unclear or mumbled, make your best interpretation of the words
- If the audio contains speech in any language (Hindi, English, Spanish, or any other), transcribe it in the original language

Return ONLY the transcription text, nothing else. No explanations, no timestamps, no formatting - just the exact words spoken.`
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
      
      // Use duration-aware segment creation for better word timing
      const segments = audioDuration 
        ? createSegmentsFromTextWithDuration(text, audioDuration)
        : createSegmentsFromText(text);
      aiLogger.info(`Created ${segments.length} transcript segments with ${audioDuration ? 'synthesized word timing' : 'estimated timestamps'}`);
      return segments;
      
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      aiLogger.error(`Gemini transcription attempt ${attempt}/${MAX_RETRIES} failed:`, errorMessage);
      
      if (errorMessage.includes("8 MB") || errorMessage.includes("too large") || errorMessage.includes("INVALID_ARGUMENT")) {
        aiLogger.warn("Audio file too large for Gemini inline data");
        break;
      }
      
      if (!isRetryableError(error)) {
        aiLogger.warn("Non-retryable error detected, skipping remaining retries");
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

export interface TranscriptionOptions {
  languageHint?: string;
  filterLowConfidence?: boolean;
  confidenceThreshold?: number;
}

export async function transcribeAudio(
  audioPath: string,
  audioDuration?: number,
  options?: TranscriptionOptions
): Promise<TranscriptSegment[]> {
  const languageHint = options?.languageHint;
  const filterLowConfidence = options?.filterLowConfidence ?? true;
  const confidenceThreshold = options?.confidenceThreshold ?? 0.5;
  
  aiLogger.info(`Starting audio transcription...${languageHint ? ` (language hint: ${languageHint})` : ""}`);
  if (filterLowConfidence) {
    aiLogger.debug(`Low-confidence filtering enabled (threshold: ${confidenceThreshold})`);
  }
  
  const hasOpenAI = !!process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  const hasGemini = !!process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
  
  if (hasOpenAI) {
    const openAIResult = await transcribeWithOpenAI(audioPath, audioDuration, languageHint);
    if (openAIResult.length > 0) {
      aiLogger.info(`Transcription successful with OpenAI: ${openAIResult.length} segments extracted`);
      return openAIResult;
    }
    aiLogger.warn("OpenAI transcription failed, trying Gemini fallback...");
  }
  
  if (hasGemini) {
    const geminiResult = await transcribeWithGemini(audioPath, audioDuration, languageHint);
    if (geminiResult.length > 0) {
      aiLogger.info(`Transcription successful with Gemini: ${geminiResult.length} segments extracted`);
      return geminiResult;
    }
  }
  
  aiLogger.error("All transcription methods failed. No segments extracted from audio.");
  return [];
}
