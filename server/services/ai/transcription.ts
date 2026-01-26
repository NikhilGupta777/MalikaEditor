import { toFile } from "openai";
import { promises as fs } from "fs";
import { createLogger } from "../../utils/logger";
import { getOpenAIClient, getGeminiClient } from "./clients";
import { AI_CONFIG } from "../../config/ai";
import type { TranscriptSegment } from "@shared/schema";

const aiLogger = createLogger("ai-service");

const MAX_RETRIES = AI_CONFIG.limits.maxRetries;
const RETRY_DELAY_MS = 2000;
const GEMINI_MAX_FILE_SIZE_MB = AI_CONFIG.limits.geminiMaxFileSizeMB;

export function logTranscriptionConfig(): void {
  const hasOpenAIKey = !!process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  const hasGeminiKey = !!process.env.AI_INTEGRATIONS_GEMINI_API_KEY;

  aiLogger.info("═══════════════════════════════════════════════════════");
  aiLogger.info("TRANSCRIPTION SYSTEM INITIALIZED");

  if (hasOpenAIKey) {
    aiLogger.info(`Primary: Replit AI OpenAI ${AI_CONFIG.models.transcription.primary} (with word-level timestamps)`);
  }

  if (hasGeminiKey) {
    aiLogger.info(`Fallback: Replit AI Gemini 2.5 Flash (audio files < ${GEMINI_MAX_FILE_SIZE_MB}MB)`);
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

// Estimate syllable count for a word (approximation for timing)
function estimateSyllables(word: string): number {
  const cleaned = word.toLowerCase().replace(/[^a-z]/g, '');
  if (cleaned.length === 0) return 1;
  if (cleaned.length <= 3) return 1;
  
  // Count vowel groups as approximate syllables
  const vowelGroups = cleaned.match(/[aeiouy]+/g);
  let syllables = vowelGroups ? vowelGroups.length : 1;
  
  // Adjust for silent e at end
  if (cleaned.endsWith('e') && syllables > 1) {
    syllables--;
  }
  
  // Adjust for common suffixes
  if (cleaned.endsWith('le') && cleaned.length > 2 && !/[aeiouy]/.test(cleaned.charAt(cleaned.length - 3))) {
    syllables++;
  }
  
  return Math.max(1, syllables);
}

// Calculate speaking time weight for a word based on syllables and complexity
// IMPROVED: More accurate speech rate modeling based on average speaking rates
// Average speaking rate: 125-150 words per minute = ~400-500ms per word
// Average syllables per word: 1.5 = ~250-350ms per syllable
function calculateWordWeight(word: string): number {
  const syllables = estimateSyllables(word);
  
  // Base time per syllable (200ms is more accurate for natural speech)
  // Short words get slightly more time per syllable (articulation overhead)
  const syllableTime = word.length <= 4 ? 0.22 : 0.18;
  const baseWeight = syllables * syllableTime;
  
  // Add minimum word duration to account for word boundaries (~80ms)
  const wordBoundary = 0.08;
  
  // Add time for punctuation (natural pauses) - slightly increased for realism
  let pauseWeight = 0;
  if (word.endsWith('.') || word.endsWith('!') || word.endsWith('?')) {
    pauseWeight = 0.5; // Longer pause at sentence end (~500ms)
  } else if (word.endsWith(',') || word.endsWith(';') || word.endsWith(':')) {
    pauseWeight = 0.25; // Medium pause at clause boundaries (~250ms)
  } else if (word.endsWith('...') || word.includes('—')) {
    pauseWeight = 0.6; // Longer pause for ellipsis/em-dash (~600ms)
  }
  
  // Numbers and acronyms take longer to say
  if (/^\d+$/.test(word) || /^[A-Z]{2,}$/.test(word)) {
    return baseWeight * 1.5 + wordBoundary + pauseWeight;
  }
  
  return baseWeight + wordBoundary + pauseWeight;
}

// Calculate total weight for a sentence
function calculateSentenceWeight(sentence: string): number {
  const words = sentence.trim().split(/\s+/).filter(w => w.length > 0);
  return words.reduce((sum, word) => sum + calculateWordWeight(word), 0);
}

// OpenAI word timestamp interface
interface OpenAIWord {
  word: string;
  start: number;
  end: number;
}

// OpenAI segment timestamp interface
interface OpenAISegment {
  id: number;
  text: string;
  start: number;
  end: number;
  words?: OpenAIWord[];
}

// Validate and sanitize word timestamps to ensure they are valid
// Returns sanitized words with invalid entries filtered out
function sanitizeWordTimestamps(words: OpenAIWord[], audioDuration?: number): OpenAIWord[] {
  if (!words || words.length === 0) return [];
  
  const sanitized: OpenAIWord[] = [];
  let lastEndTime = 0;
  let invalidCount = 0;
  
  for (const word of words) {
    // Skip empty/whitespace-only words
    if (!word.word || word.word.trim().length === 0) {
      invalidCount++;
      continue;
    }
    
    // Validate timestamps are finite numbers
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end)) {
      aiLogger.warn(`Skipping word with invalid timestamps: "${word.word}" (start=${word.start}, end=${word.end})`);
      invalidCount++;
      continue;
    }
    
    // Ensure non-negative
    let start = Math.max(0, word.start);
    let end = Math.max(0, word.end);
    
    // Ensure end >= start (minimum word duration of 50ms)
    if (end <= start) {
      end = start + 0.05;
    }
    
    // Clamp to audio duration if provided
    if (audioDuration && audioDuration > 0) {
      start = Math.min(start, audioDuration);
      end = Math.min(end, audioDuration);
    }
    
    // Ensure monotonic (word starts after previous word ended, or at least at same time)
    if (start < lastEndTime) {
      // Word overlaps with previous - adjust start to previous end
      start = lastEndTime;
      if (end <= start) {
        end = start + 0.05;
      }
    }
    
    sanitized.push({
      word: word.word.trim(),
      start,
      end,
    });
    
    lastEndTime = end;
  }
  
  if (invalidCount > 0) {
    aiLogger.warn(`Filtered ${invalidCount} invalid word timestamps from transcription`);
  }
  
  return sanitized;
}

// Check if any segments have embedded word timings
function segmentsHaveWords(segments: OpenAISegment[]): boolean {
  if (!segments || segments.length === 0) return false;
  // Check ALL segments, not just the first one
  return segments.some(seg => seg.words && seg.words.length > 0);
}

// Create segments from OpenAI word-level timestamps for accurate caption timing
function createSegmentsFromOpenAIWords(
  words: OpenAIWord[],
  segments?: OpenAISegment[],
  audioDuration?: number
): TranscriptSegment[] {
  if (!words || words.length === 0) return [];
  
  // Sanitize word timestamps before processing
  const sanitizedWords = sanitizeWordTimestamps(words, audioDuration);
  if (sanitizedWords.length === 0) return [];
  
  // If we have segments with words embedded, use segment boundaries
  // Check ALL segments for words, not just the first one
  if (segments && segmentsHaveWords(segments)) {
    // Sanitize embedded word timings in each segment
    return segments.map(seg => {
      const sanitizedSegWords = seg.words ? sanitizeWordTimestamps(seg.words, audioDuration) : [];
      return {
        start: Math.max(0, seg.start),
        end: Math.max(seg.start + 0.1, seg.end),
        text: seg.text.trim(),
        words: sanitizedSegWords.map(w => ({
          word: w.word,
          start: w.start,
          end: w.end,
        })),
      };
    }).filter(seg => seg.text.length > 0);
  }
  
  // Group sanitized words into sentence-like segments based on punctuation and timing gaps
  const result: TranscriptSegment[] = [];
  let currentWords: OpenAIWord[] = [];
  let currentText: string[] = [];
  
  const GAP_THRESHOLD = 1.0; // 1 second gap triggers new segment
  
  for (let i = 0; i < sanitizedWords.length; i++) {
    const word = sanitizedWords[i];
    const prevWord = i > 0 ? sanitizedWords[i - 1] : null;
    
    // Check for sentence break conditions
    const hasLargeGap = prevWord ? (word.start - prevWord.end) > GAP_THRESHOLD : false;
    const endsWithPunctuation = prevWord ? /[.!?]$/.test(prevWord.word) : false;
    const shouldBreak = hasLargeGap || (endsWithPunctuation && currentWords.length >= 3);
    
    if (shouldBreak && currentWords.length > 0) {
      // Save current segment
      result.push({
        start: currentWords[0].start,
        end: currentWords[currentWords.length - 1].end,
        text: currentText.join(' ').trim(),
        words: currentWords.map(w => ({
          word: w.word,
          start: w.start,
          end: w.end,
        })),
      });
      currentWords = [];
      currentText = [];
    }
    
    currentWords.push(word);
    currentText.push(word.word);
  }
  
  // Don't forget the last segment
  if (currentWords.length > 0) {
    result.push({
      start: currentWords[0].start,
      end: currentWords[currentWords.length - 1].end,
      text: currentText.join(' ').trim(),
      words: currentWords.map(w => ({
        word: w.word,
        start: w.start,
        end: w.end,
      })),
    });
  }
  
  aiLogger.debug(`Created ${result.length} segments from ${words.length} OpenAI word timestamps`);
  return result;
}

// Create segments from OpenAI segment-level timestamps with synthesized word timing
function createSegmentsFromOpenAISegments(
  segments: OpenAISegment[],
  audioDuration?: number
): TranscriptSegment[] {
  if (!segments || segments.length === 0) return [];
  
  return segments.map(seg => {
    const segmentDuration = seg.end - seg.start;
    const words = seg.text.trim().split(/\s+/).filter(w => w.length > 0);
    
    // Synthesize word timing within segment bounds using improved algorithm
    const wordWeights = words.map(w => calculateWordWeight(w));
    const totalWeight = wordWeights.reduce((sum, w) => sum + w, 0);
    
    let wordTime = seg.start;
    const wordTimings = words.map((word, i) => {
      const weight = wordWeights[i];
      const wordDuration = (weight / totalWeight) * segmentDuration;
      const timing = {
        word: word,
        start: wordTime,
        end: wordTime + wordDuration,
      };
      wordTime += wordDuration;
      return timing;
    });
    
    return {
      start: seg.start,
      end: seg.end,
      text: seg.text.trim(),
      words: wordTimings,
    };
  });
}

// Create segments with improved word-level timing using syllable-based estimation
function createSegmentsFromTextWithDuration(text: string, audioDuration: number): TranscriptSegment[] {
  // Split into sentences using natural language boundaries
  const sentences = splitIntoNaturalSegments(text);
  
  if (sentences.length === 0) {
    if (text.trim()) {
      // Single segment with syllable-weighted word timing
      const words = text.trim().split(/\s+/).filter(w => w.length > 0);
      const totalWeight = words.reduce((sum, word) => sum + calculateWordWeight(word), 0);
      const effectiveDuration = audioDuration * 0.95; // Leave small buffer
      
      let currentTime = 0;
      const wordTimings = words.map(word => {
        const weight = calculateWordWeight(word);
        const wordDuration = (weight / totalWeight) * effectiveDuration;
        const timing = {
          word: word,
          start: currentTime,
          end: currentTime + wordDuration,
        };
        currentTime += wordDuration;
        return timing;
      });
      
      return [{
        start: 0,
        end: audioDuration,
        text: text.trim(),
        words: wordTimings,
      }];
    }
    return [];
  }
  
  // Calculate total weight across all sentences for proportional timing
  const sentenceWeights = sentences.map(s => calculateSentenceWeight(s));
  const totalWeight = sentenceWeights.reduce((sum, w) => sum + w, 0);
  
  // Reserve time for inter-sentence gaps (natural pauses between sentences)
  const gapTime = 0.15; // 150ms between segments
  const totalGapTime = (sentences.length - 1) * gapTime;
  const availableSpeakingTime = audioDuration - totalGapTime;
  
  let currentTime = 0;
  
  return sentences.map((sentence: string, idx: number) => {
    // Calculate segment duration proportionally based on syllable weight
    const sentenceWeight = sentenceWeights[idx];
    const proportion = sentenceWeight / totalWeight;
    const segmentDuration = Math.max(0.5, proportion * availableSpeakingTime);
    
    // Create word-level timing using syllable-weighted distribution
    const words = sentence.trim().split(/\s+/).filter(w => w.length > 0);
    const wordWeights = words.map(w => calculateWordWeight(w));
    const segmentTotalWeight = wordWeights.reduce((sum, w) => sum + w, 0);
    
    let wordTime = currentTime;
    const wordTimings = words.map((word, i) => {
      const wordWeight = wordWeights[i];
      const wordDuration = (wordWeight / segmentTotalWeight) * segmentDuration;
      const timing = {
        word: word,
        start: wordTime,
        end: wordTime + wordDuration,
      };
      wordTime += wordDuration;
      return timing;
    });
    
    const segment: TranscriptSegment = {
      start: currentTime,
      end: currentTime + segmentDuration,
      text: sentence.trim(),
      words: wordTimings,
    };
    
    currentTime += segmentDuration + gapTime;
    return segment;
  }).filter((s: TranscriptSegment) => s.text.length > 0);
}

async function transcribeWithOpenAI(
  audioPath: string, 
  audioDuration?: number,
  languageHint?: string
): Promise<TranscriptSegment[]> {
  aiLogger.info(`Using OpenAI ${AI_CONFIG.models.transcription.primary} for transcription...`);
  if (languageHint) {
    aiLogger.info(`Language hint provided: ${languageHint}`);
  }
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const audioBuffer = await fs.readFile(audioPath);
      const file = await toFile(audioBuffer, "audio.mp3");

      const transcriptionParams: any = {
        file,
        model: AI_CONFIG.models.transcription.primary,
        response_format: "verbose_json",  // Use verbose_json to get word-level timestamps
        timestamp_granularities: ["word", "segment"],  // Request both word and segment timestamps
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
      
      // Check if we got word-level timestamps from OpenAI
      if (response.words && Array.isArray(response.words) && response.words.length > 0) {
        // Use actual word timestamps from OpenAI for accurate caption timing
        aiLogger.info(`Got ${response.words.length} word-level timestamps from OpenAI`);
        const segments = createSegmentsFromOpenAIWords(response.words, response.segments, audioDuration);
        aiLogger.info(`Created ${segments.length} transcript segments with actual word timing`);
        return segments;
      }
      
      // Check if we got segment-level timestamps
      if (response.segments && Array.isArray(response.segments) && response.segments.length > 0) {
        aiLogger.info(`Got ${response.segments.length} segment-level timestamps from OpenAI (no word timestamps)`);
        const segments = createSegmentsFromOpenAISegments(response.segments, audioDuration);
        aiLogger.info(`Created ${segments.length} transcript segments with segment timing`);
        return segments;
      }
      
      // Fallback: Synthesize timing based on text length and audio duration
      aiLogger.warn("OpenAI returned no timestamps, falling back to synthesized timing");
      if (audioDuration && audioDuration > 0) {
        const segments = createSegmentsFromTextWithDuration(text, audioDuration);
        aiLogger.info(`Created ${segments.length} transcript segments with synthesized word timing (duration: ${audioDuration.toFixed(1)}s)`);
        return segments;
      } else {
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
        model: AI_CONFIG.models.transcription.fallback,
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
