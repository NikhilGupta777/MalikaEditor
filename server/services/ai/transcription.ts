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
    aiLogger.info("Primary: OpenAI gpt-4o-mini-transcribe (with synthesized word timing)");
  }
  
  if (hasGeminiKey) {
    aiLogger.info(`Fallback: Gemini 2.5 Flash (audio files < ${GEMINI_MAX_FILE_SIZE_MB}MB)`);
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
  const sentences = text.split(/(?<=[.!?।])\s+/).filter((s: string) => s.trim());
  
  if (sentences.length === 0) {
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
  
  return sentences.map((sentence: string) => {
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

async function transcribeWithOpenAI(audioPath: string, audioDuration?: number): Promise<TranscriptSegment[]> {
  // Replit AI Integrations only supports gpt-4o-mini-transcribe with 'json' format
  // whisper-1 and verbose_json are NOT available through the integration
  aiLogger.info("Using OpenAI gpt-4o-mini-transcribe for transcription...");
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const audioBuffer = await fs.readFile(audioPath);
      const file = await toFile(audioBuffer, "audio.mp3");

      // Use json format (only format supported by gpt-4o-mini-transcribe via Replit AI)
      const response = await getOpenAIClient().audio.transcriptions.create({
        file,
        model: "gpt-4o-mini-transcribe",
        response_format: "json",
      }) as any;

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

async function transcribeWithGemini(audioPath: string, audioDuration?: number): Promise<TranscriptSegment[]> {
  const audioBuffer = await fs.readFile(audioPath);
  const fileSizeMB = audioBuffer.length / (1024 * 1024);
  
  if (fileSizeMB > GEMINI_MAX_FILE_SIZE_MB) {
    aiLogger.warn(`Audio file (${fileSizeMB.toFixed(1)}MB) exceeds Gemini limit (${GEMINI_MAX_FILE_SIZE_MB}MB), skipping Gemini fallback`);
    return [];
  }
  
  aiLogger.info(`Using Gemini 2.5 Flash for transcription (file size: ${fileSizeMB.toFixed(1)}MB)...`);
  
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
                text: `Transcribe this audio accurately and completely. Include every spoken word.
If the audio contains speech in any language (Hindi, English, Spanish, or any other), transcribe it in the original language.
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

export async function transcribeAudio(
  audioPath: string,
  audioDuration?: number
): Promise<TranscriptSegment[]> {
  aiLogger.info("Starting audio transcription...");
  
  const hasOpenAI = !!process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  const hasGemini = !!process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
  
  if (hasOpenAI) {
    const openAIResult = await transcribeWithOpenAI(audioPath, audioDuration);
    if (openAIResult.length > 0) {
      aiLogger.info(`Transcription successful with OpenAI: ${openAIResult.length} segments extracted`);
      return openAIResult;
    }
    aiLogger.warn("OpenAI transcription failed, trying Gemini fallback...");
  }
  
  if (hasGemini) {
    const geminiResult = await transcribeWithGemini(audioPath, audioDuration);
    if (geminiResult.length > 0) {
      aiLogger.info(`Transcription successful with Gemini: ${geminiResult.length} segments extracted`);
      return geminiResult;
    }
  }
  
  aiLogger.error("All transcription methods failed. No segments extracted from audio.");
  return [];
}
