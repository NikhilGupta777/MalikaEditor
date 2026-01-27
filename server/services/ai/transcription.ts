import { toFile } from "openai";
import { promises as fs } from "fs";
import { spawn } from "child_process";
import { createLogger } from "../../utils/logger";
import { getOpenAIClient, getGeminiClient } from "./clients";
import { AI_CONFIG } from "../../config/ai";
import type { TranscriptSegment } from "@shared/schema";

const aiLogger = createLogger("ai-service");

// AssemblyAI API configuration
const ASSEMBLYAI_BASE_URL = "https://api.assemblyai.com/v2";

interface AssemblyAIWord {
  text: string;
  start: number; // milliseconds
  end: number;   // milliseconds
  confidence: number;
  speaker?: string;
}

interface AssemblyAIUtterance {
  speaker: string;
  text: string;
  start: number;
  end: number;
  confidence: number;
  words: AssemblyAIWord[];
}

interface AssemblyAIChapter {
  gist: string;
  headline: string;
  summary: string;
  start: number;
  end: number;
}

interface AssemblyAISentiment {
  text: string;
  start: number;
  end: number;
  sentiment: "POSITIVE" | "NEGATIVE" | "NEUTRAL";
  confidence: number;
  speaker?: string;
}

interface AssemblyAIEntity {
  entity_type: string; // e.g., "person_name", "location", "date_time", "organization"
  text: string;
  start: number;
  end: number;
}

interface AssemblyAITranscript {
  id: string;
  status: "queued" | "processing" | "completed" | "error";
  text: string | null;
  words: AssemblyAIWord[] | null;
  error?: string;
  audio_duration?: number;
  language_code?: string;
  // Enhanced features
  utterances?: AssemblyAIUtterance[] | null;
  chapters?: AssemblyAIChapter[] | null;
  sentiment_analysis_results?: AssemblyAISentiment[] | null;
  entities?: AssemblyAIEntity[] | null;
}

// Extended transcript result with AI intelligence features
export interface TranscriptEnhancedResult {
  segments: TranscriptSegment[];
  speakers?: SpeakerInfo[];
  chapters?: ChapterInfo[];
  sentiments?: SentimentInfo[];
  entities?: EntityInfo[];
  detectedLanguage?: string;
}

export interface SpeakerInfo {
  id: string;
  label: string;
  wordCount: number;
  speakingTime: number; // seconds
}

export interface ChapterInfo {
  title: string;
  summary: string;
  gist: string;
  start: number;
  end: number;
}

export interface SentimentInfo {
  text: string;
  sentiment: "positive" | "negative" | "neutral";
  confidence: number;
  start: number;
  end: number;
  speaker?: string;
}

export interface EntityInfo {
  type: string;
  text: string;
  start: number;
  end: number;
}

/**
 * Transcribe audio using AssemblyAI API with enhanced AI features
 * AssemblyAI provides native word-level timestamps - ideal for karaoke captions
 * Also returns speaker diarization, auto chapters, sentiment analysis, and entity detection
 */
async function transcribeWithAssemblyAI(
  audioPath: string,
  audioDuration?: number,
  languageHint?: string
): Promise<TranscriptEnhancedResult | null> {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    aiLogger.debug("AssemblyAI API key not configured, skipping");
    return null;
  }

  aiLogger.info(`Using AssemblyAI ${AI_CONFIG.models.transcription.primary} for transcription...`);

  try {
    // Step 1: Upload audio file to AssemblyAI
    aiLogger.debug("Uploading audio to AssemblyAI...");
    const audioBuffer = await fs.readFile(audioPath);
    
    const uploadResponse = await fetch(`${ASSEMBLYAI_BASE_URL}/upload`, {
      method: "POST",
      headers: {
        "Authorization": apiKey,
        "Content-Type": "application/octet-stream",
      },
      body: audioBuffer,
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      throw new Error(`Upload failed: ${uploadResponse.status} - ${errorText}`);
    }

    const uploadResult = await uploadResponse.json() as { upload_url: string };
    const audioUrl = uploadResult.upload_url;
    aiLogger.debug("Audio uploaded successfully");

    // Step 2: Submit transcription request with enhanced AI features
    const transcriptionConfig: Record<string, unknown> = {
      audio_url: audioUrl,
      language_detection: !languageHint, // Auto-detect if no hint provided
      // Enable speaker diarization for multi-speaker content
      speaker_labels: true,
      // Enable auto chapters for long-form content (podcasts, interviews)
      auto_chapters: true,
      // Enable sentiment analysis for emotional context
      sentiment_analysis: true,
      // Enable entity detection for names, dates, locations
      entity_detection: true,
    };

    if (languageHint) {
      transcriptionConfig.language_code = languageHint;
    }

    const submitResponse = await fetch(`${ASSEMBLYAI_BASE_URL}/transcript`, {
      method: "POST",
      headers: {
        "Authorization": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(transcriptionConfig),
    });

    if (!submitResponse.ok) {
      const errorText = await submitResponse.text();
      throw new Error(`Submit failed: ${submitResponse.status} - ${errorText}`);
    }

    const submitResult = await submitResponse.json() as AssemblyAITranscript;
    const transcriptId = submitResult.id;
    aiLogger.debug(`Transcription submitted, ID: ${transcriptId}`);

    // Step 3: Poll for completion
    const maxWaitMs = 5 * 60 * 1000; // 5 minutes max
    const pollIntervalMs = 3000; // Poll every 3 seconds
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

      const pollResponse = await fetch(`${ASSEMBLYAI_BASE_URL}/transcript/${transcriptId}`, {
        headers: { "Authorization": apiKey },
      });

      if (!pollResponse.ok) {
        throw new Error(`Poll failed: ${pollResponse.status}`);
      }

      const transcript = await pollResponse.json() as AssemblyAITranscript;

      if (transcript.status === "completed") {
        aiLogger.info(`AssemblyAI transcription completed${transcript.language_code ? ` (detected: ${transcript.language_code})` : ""}`);
        
        // Extract enhanced features
        const segments = createSegmentsFromAssemblyAI(transcript, audioDuration);
        const enhanced = extractEnhancedFeatures(transcript);
        
        // Log enhanced features
        if (enhanced.speakers && enhanced.speakers.length > 0) {
          aiLogger.info(`Speaker diarization: ${enhanced.speakers.length} speakers detected`);
        }
        if (enhanced.chapters && enhanced.chapters.length > 0) {
          aiLogger.info(`Auto chapters: ${enhanced.chapters.length} chapters generated`);
        }
        if (enhanced.sentiments && enhanced.sentiments.length > 0) {
          const positive = enhanced.sentiments.filter(s => s.sentiment === "positive").length;
          const negative = enhanced.sentiments.filter(s => s.sentiment === "negative").length;
          aiLogger.info(`Sentiment analysis: ${positive} positive, ${negative} negative segments`);
        }
        if (enhanced.entities && enhanced.entities.length > 0) {
          aiLogger.info(`Entity detection: ${enhanced.entities.length} entities found`);
        }
        
        return {
          segments,
          ...enhanced,
          detectedLanguage: transcript.language_code,
        };
      }

      if (transcript.status === "error") {
        throw new Error(`Transcription error: ${transcript.error}`);
      }

      aiLogger.debug(`Transcription status: ${transcript.status}...`);
    }

    throw new Error("Transcription timed out after 5 minutes");

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    aiLogger.error(`AssemblyAI transcription failed: ${errorMessage}`);
    return null;
  }
}

/**
 * Extract enhanced features from AssemblyAI transcript
 */
function extractEnhancedFeatures(transcript: AssemblyAITranscript): Omit<TranscriptEnhancedResult, "segments" | "detectedLanguage"> {
  const result: Omit<TranscriptEnhancedResult, "segments" | "detectedLanguage"> = {};
  
  // Extract speaker information from utterances
  if (transcript.utterances && transcript.utterances.length > 0) {
    const speakerMap = new Map<string, { wordCount: number; speakingTime: number }>();
    
    for (const utterance of transcript.utterances) {
      const existing = speakerMap.get(utterance.speaker) || { wordCount: 0, speakingTime: 0 };
      existing.wordCount += utterance.words?.length || utterance.text.split(/\s+/).length;
      existing.speakingTime += (utterance.end - utterance.start) / 1000; // Convert ms to seconds
      speakerMap.set(utterance.speaker, existing);
    }
    
    result.speakers = Array.from(speakerMap.entries()).map(([id, stats], index) => ({
      id,
      label: `Speaker ${index + 1}`,
      wordCount: stats.wordCount,
      speakingTime: Math.round(stats.speakingTime * 10) / 10,
    }));
  }
  
  // Extract chapters
  if (transcript.chapters && transcript.chapters.length > 0) {
    result.chapters = transcript.chapters.map(ch => ({
      title: ch.headline,
      summary: ch.summary,
      gist: ch.gist,
      start: ch.start / 1000, // Convert ms to seconds
      end: ch.end / 1000,
    }));
  }
  
  // Extract sentiment analysis
  if (transcript.sentiment_analysis_results && transcript.sentiment_analysis_results.length > 0) {
    result.sentiments = transcript.sentiment_analysis_results.map(s => ({
      text: s.text,
      sentiment: s.sentiment.toLowerCase() as "positive" | "negative" | "neutral",
      confidence: s.confidence,
      start: s.start / 1000,
      end: s.end / 1000,
      speaker: s.speaker,
    }));
  }
  
  // Extract entities
  if (transcript.entities && transcript.entities.length > 0) {
    result.entities = transcript.entities.map(e => ({
      type: e.entity_type,
      text: e.text,
      start: e.start / 1000,
      end: e.end / 1000,
    }));
  }
  
  return result;
}

/**
 * Convert AssemblyAI transcript response to TranscriptSegment format
 * Groups words into natural sentence segments based on punctuation and timing gaps
 */
function createSegmentsFromAssemblyAI(
  transcript: AssemblyAITranscript,
  audioDuration?: number
): TranscriptSegment[] {
  // Determine effective duration from param or response (AssemblyAI returns duration in seconds)
  const effectiveDuration = audioDuration ?? (transcript.audio_duration ? transcript.audio_duration : undefined);
  
  if (!transcript.words || transcript.words.length === 0) {
    aiLogger.warn("AssemblyAI returned no words, falling back to text-only");
    if (transcript.text) {
      // Pass audioDuration to ensure timestamps are clamped
      return createSegmentsFromText(transcript.text, effectiveDuration);
    }
    return [];
  }

  // Convert to ms for comparison, use Infinity only if no duration available
  const maxTime = effectiveDuration ? effectiveDuration * 1000 : Infinity;
  const result: TranscriptSegment[] = [];
  let currentWords: AssemblyAIWord[] = [];
  
  const GAP_THRESHOLD_MS = 1000; // 1 second gap triggers new segment
  const MAX_SEGMENT_WORDS = 15; // Prevent overly long segments

  for (let i = 0; i < transcript.words.length; i++) {
    const word = transcript.words[i];
    const prevWord = currentWords.length > 0 ? currentWords[currentWords.length - 1] : null;
    
    // Skip words that exceed audio duration
    if (word.start > maxTime) continue;

    // Check for segment break conditions
    const hasLargeGap = prevWord ? (word.start - prevWord.end) > GAP_THRESHOLD_MS : false;
    const endsWithPunctuation = prevWord ? /[.!?]$/.test(prevWord.text) : false;
    const tooManyWords = currentWords.length >= MAX_SEGMENT_WORDS;
    const shouldBreak = hasLargeGap || (endsWithPunctuation && currentWords.length >= 3) || tooManyWords;

    if (shouldBreak && currentWords.length > 0) {
      // Save current segment
      result.push(createSegmentFromAssemblyAIWords(currentWords, maxTime));
      currentWords = [];
    }

    currentWords.push(word);
  }

  // Don't forget the last segment
  if (currentWords.length > 0) {
    result.push(createSegmentFromAssemblyAIWords(currentWords, maxTime));
  }

  aiLogger.info(`Created ${result.length} segments from AssemblyAI with native word timestamps`);
  return result;
}

/**
 * Create a single TranscriptSegment from AssemblyAI words
 * Converts millisecond timestamps to seconds
 */
function createSegmentFromAssemblyAIWords(
  words: AssemblyAIWord[],
  maxTimeMs: number
): TranscriptSegment {
  const firstWord = words[0];
  const lastWord = words[words.length - 1];
  
  // Convert ms to seconds and clamp to audio duration
  const maxTimeSec = maxTimeMs === Infinity ? Infinity : maxTimeMs / 1000;
  
  return {
    start: Math.min(firstWord.start / 1000, maxTimeSec),
    end: Math.min(lastWord.end / 1000, maxTimeSec),
    text: words.map(w => w.text).join(" "),
    words: words.map(w => ({
      word: w.text,
      start: Math.min(w.start / 1000, maxTimeSec),
      end: Math.min(w.end / 1000, maxTimeSec),
    })),
  };
}

// Cache for speech start times to avoid redundant FFmpeg calls
const speechStartCache = new Map<string, number>();

/**
 * Detect when speech first starts in an audio file using FFmpeg silencedetect
 * This helps offset synthesized word timing to match actual speech start
 * @param audioPath Path to the audio file
 * @returns Time in seconds when speech first starts (0 if detection fails)
 */
async function detectSpeechStart(audioPath: string): Promise<number> {
  // Check cache first
  if (speechStartCache.has(audioPath)) {
    return speechStartCache.get(audioPath)!;
  }
  
  return new Promise((resolve) => {
    const timeoutMs = 15000; // 15 second timeout
    let completed = false;
    let speechStart = 0;
    
    // Use silencedetect with sensitive settings to find first speech
    // noise=-35dB catches most speech, d=0.2 catches short silences
    const ffmpegArgs = [
      '-i', audioPath,
      '-af', 'silencedetect=noise=-35dB:d=0.2',
      '-f', 'null',
      '-'
    ];
    
    const process = spawn('ffmpeg', ffmpegArgs);
    
    const timeoutId = setTimeout(() => {
      if (!completed) {
        completed = true;
        process.kill('SIGKILL');
        aiLogger.warn('Speech start detection timed out, using default offset 0');
        speechStartCache.set(audioPath, 0);
        resolve(0);
      }
    }, timeoutMs);
    
    let stderrData = '';
    
    process.stderr.on('data', (data) => {
      stderrData += data.toString();
    });
    
    process.on('close', () => {
      if (!completed) {
        completed = true;
        clearTimeout(timeoutId);
        
        // Parse silence_start/end PAIRS from output to find leading silence
        // FFmpeg outputs: silence_start: X ... silence_end: Y | silence_duration: Z
        // We need to capture pairs in sequence to avoid mismatched arrays
        // Use regex to capture start followed by its corresponding end
        const silencePairRegex = /silence_start:\s*([\d.]+)[\s\S]*?silence_end:\s*([\d.]+)/g;
        
        const silencePairs: { start: number; end: number }[] = [];
        let match;
        while ((match = silencePairRegex.exec(stderrData)) !== null) {
          silencePairs.push({
            start: parseFloat(match[1]),
            end: parseFloat(match[2])
          });
        }
        
        // Find the first silence block that starts at t=0 (within tolerance)
        // The corresponding end time tells us when speech actually starts
        for (const pair of silencePairs) {
          if (pair.start < 0.1) { // Silence starts at beginning
            speechStart = pair.end;
            // Cap at reasonable value (don't offset more than 5 seconds)
            speechStart = Math.min(speechStart, 5.0);
            aiLogger.info(`Detected leading silence of ${speechStart.toFixed(2)}s, speech starts after`);
            break;
          }
        }
        
        if (speechStart === 0 && silencePairs.length > 0) {
          // No leading silence found (first silence starts later in audio)
          aiLogger.debug(`No leading silence detected (first silence at ${silencePairs[0].start.toFixed(2)}s), speech starts at 0s`);
        } else if (silencePairs.length === 0) {
          // No silence detected at all - continuous speech
          aiLogger.debug('No silence detected, speech starts at 0s');
        }
        
        speechStartCache.set(audioPath, speechStart);
        resolve(speechStart);
      }
    });
    
    process.on('error', (err) => {
      if (!completed) {
        completed = true;
        clearTimeout(timeoutId);
        aiLogger.warn(`Speech start detection failed: ${err.message}, using default offset 0`);
        speechStartCache.set(audioPath, 0);
        resolve(0);
      }
    });
  });
}

/**
 * Clear speech start cache (useful when processing new video)
 */
export function clearSpeechStartCache(): void {
  speechStartCache.clear();
}

const MAX_RETRIES = AI_CONFIG.limits.maxRetries;
const RETRY_DELAY_MS = 2000;
const GEMINI_MAX_FILE_SIZE_MB = AI_CONFIG.limits.geminiMaxFileSizeMB;

export function logTranscriptionConfig(): void {
  const hasAssemblyAIKey = !!process.env.ASSEMBLYAI_API_KEY;
  const hasOpenAIKey = !!process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  const hasGeminiKey = !!process.env.AI_INTEGRATIONS_GEMINI_API_KEY;

  aiLogger.info("═══════════════════════════════════════════════════════");
  aiLogger.info("TRANSCRIPTION SYSTEM INITIALIZED");

  if (hasAssemblyAIKey) {
    aiLogger.info(`Primary: AssemblyAI Universal (native word-level timestamps)`);
  }

  if (hasOpenAIKey) {
    aiLogger.info(`${hasAssemblyAIKey ? "Secondary" : "Primary"}: Replit AI OpenAI ${AI_CONFIG.models.transcription.secondary} (synthesized word timing)`);
  }

  if (hasGeminiKey) {
    aiLogger.info(`Fallback: Replit AI Gemini 2.5 Flash (audio files < ${GEMINI_MAX_FILE_SIZE_MB}MB)`);
  }
  
  if (!hasAssemblyAIKey && !hasOpenAIKey && !hasGeminiKey) {
    aiLogger.error("WARNING: No transcription API keys configured");
    aiLogger.error("Transcription will fail. Please set up AssemblyAI, OpenAI, or Gemini.");
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

function createSegmentsFromText(text: string, audioDuration?: number): TranscriptSegment[] {
  const segments = splitIntoNaturalSegments(text);
  const maxTime = audioDuration && audioDuration > 0 ? audioDuration : Infinity;
  
  if (segments.length === 0) {
    if (text.trim()) {
      return [{
        start: 0,
        end: Math.min(10, maxTime),
        text: text.trim(),
      }];
    }
    return [];
  }
  
  const charsPerSecond = 12.5;
  let currentTime = 0;
  const result: TranscriptSegment[] = [];
  
  for (const sentence of segments) {
    // Stop if we've exceeded audio duration
    if (currentTime >= maxTime) break;
    
    const rawDuration = Math.max(1.5, sentence.length / charsPerSecond);
    // Clamp end time to audio duration
    const endTime = Math.min(currentTime + rawDuration, maxTime);
    
    if (sentence.trim().length > 0) {
      result.push({
        start: currentTime,
        end: endTime,
        text: sentence.trim(),
      });
    }
    
    currentTime = endTime + 0.3;
  }
  
  return result;
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
  
  // Use audioDuration for clamping if available, otherwise use a large value
  const maxTime = audioDuration && audioDuration > 0 ? audioDuration : Infinity;
  
  return segments.map(seg => {
    // Clamp segment times to audio duration
    const segStart = Math.max(0, Math.min(seg.start, maxTime));
    const segEnd = Math.max(segStart, Math.min(seg.end, maxTime));
    const segmentDuration = Math.max(0.1, segEnd - segStart);
    
    const words = seg.text.trim().split(/\s+/).filter(w => w.length > 0);
    
    // Synthesize word timing within segment bounds using improved algorithm
    const wordWeights = words.map(w => calculateWordWeight(w));
    const totalWeight = wordWeights.reduce((sum, w) => sum + w, 0);
    
    let wordTime = segStart;
    const wordTimings = words.map((word, i) => {
      const weight = wordWeights[i];
      const wordDuration = totalWeight > 0 ? (weight / totalWeight) * segmentDuration : segmentDuration / words.length;
      // Clamp word times to never exceed audio duration
      const timing = {
        word: word,
        start: Math.min(wordTime, maxTime),
        end: Math.min(wordTime + wordDuration, maxTime),
      };
      wordTime += wordDuration;
      return timing;
    });
    
    return {
      start: segStart,
      end: segEnd,
      text: seg.text.trim(),
      words: wordTimings,
    };
  });
}

// Create segments with improved word-level timing using syllable-based estimation
// speechStartOffset: time when speech actually starts (from silence detection)
function createSegmentsFromTextWithDuration(
  text: string, 
  audioDuration: number, 
  speechStartOffset: number = 0
): TranscriptSegment[] {
  // Split into sentences using natural language boundaries
  const sentences = splitIntoNaturalSegments(text);
  
  // Minimum speaking duration to prevent invalid timings
  const MIN_SPEAKING_DURATION = 0.5;
  
  // Handle very short audio clips - skip offset entirely and scale to fit
  if (audioDuration < MIN_SPEAKING_DURATION) {
    aiLogger.debug(`Audio too short (${audioDuration.toFixed(2)}s), using minimal timing`);
    // For very short audio, just use the full duration without offset
    const words = text.trim().split(/\s+/).filter(w => w.length > 0);
    const wordDuration = audioDuration / Math.max(1, words.length);
    let t = 0;
    const wordTimings = words.map(word => {
      const timing = { word, start: t, end: Math.min(t + wordDuration, audioDuration) };
      t += wordDuration;
      return timing;
    });
    return [{
      start: 0,
      end: audioDuration,
      text: text.trim(),
      words: wordTimings,
    }];
  }
  
  // Clamp speechStartOffset to ensure we have at least MIN_SPEAKING_DURATION of speaking time
  // This prevents negative/zero effective durations in edge cases
  const safeOffset = Math.max(0, Math.min(speechStartOffset, audioDuration - MIN_SPEAKING_DURATION));
  
  // If audio is too short for any meaningful offset, start at 0
  const finalOffset = audioDuration < MIN_SPEAKING_DURATION * 2 ? 0 : safeOffset;
  
  if (finalOffset !== speechStartOffset && speechStartOffset > 0) {
    aiLogger.debug(`Adjusted speech offset from ${speechStartOffset.toFixed(2)}s to ${finalOffset.toFixed(2)}s (audio: ${audioDuration.toFixed(2)}s)`);
  }
  
  // Effective duration is from speech start to audio end, capped to actual audio
  const effectiveDuration = Math.min(audioDuration, Math.max(MIN_SPEAKING_DURATION, audioDuration - finalOffset));
  
  if (sentences.length === 0) {
    if (text.trim()) {
      // Single segment with syllable-weighted word timing
      const words = text.trim().split(/\s+/).filter(w => w.length > 0);
      const totalWeight = words.reduce((sum, word) => sum + calculateWordWeight(word), 0);
      const speakingDuration = effectiveDuration * 0.95; // Leave small buffer
      
      let currentTime = finalOffset; // Start timing at detected speech start
      const wordTimings = words.map(word => {
        const weight = calculateWordWeight(word);
        const wordDuration = (weight / totalWeight) * speakingDuration;
        // Clamp word times to never exceed audio duration
        const timing = {
          word: word,
          start: Math.min(currentTime, audioDuration),
          end: Math.min(currentTime + wordDuration, audioDuration),
        };
        currentTime += wordDuration;
        return timing;
      });
      
      return [{
        start: Math.min(finalOffset, audioDuration),
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
  
  // Scale speaking time to fit within effective duration
  // If total gap time exceeds effective duration, reduce gaps proportionally
  const targetGapTime = Math.min(gapTime, effectiveDuration * 0.1 / Math.max(1, sentences.length - 1));
  const actualTotalGapTime = (sentences.length - 1) * targetGapTime;
  const availableSpeakingTime = Math.max(0.5, effectiveDuration - actualTotalGapTime);
  
  let currentTime = finalOffset; // Start timing at detected speech start
  const result: TranscriptSegment[] = [];
  
  for (let idx = 0; idx < sentences.length; idx++) {
    const sentence = sentences[idx];
    
    // Calculate remaining audio time - stop if exhausted
    const remainingTime = audioDuration - currentTime;
    if (remainingTime <= 0.1) {
      aiLogger.debug(`Stopping segment creation at ${idx}/${sentences.length} - no remaining audio time`);
      break;
    }
    
    // Calculate segment duration proportionally based on syllable weight
    const sentenceWeight = sentenceWeights[idx];
    const proportion = sentenceWeight / totalWeight;
    // Calculate duration and ensure it doesn't exceed remaining audio time
    const rawSegmentDuration = proportion * availableSpeakingTime;
    const segmentDuration = Math.max(0.1, Math.min(rawSegmentDuration, remainingTime * 0.95));
    
    // Create word-level timing using syllable-weighted distribution
    const words = sentence.trim().split(/\s+/).filter(w => w.length > 0);
    const wordWeights = words.map(w => calculateWordWeight(w));
    const segmentTotalWeight = wordWeights.reduce((sum, w) => sum + w, 0);
    
    let wordTime = currentTime;
    const wordTimings = words.map((word, i) => {
      const wordWeight = wordWeights[i];
      const wordDuration = segmentTotalWeight > 0 ? (wordWeight / segmentTotalWeight) * segmentDuration : segmentDuration / words.length;
      // Clamp word end time to never exceed audio duration
      const timing = {
        word: word,
        start: Math.min(wordTime, audioDuration),
        end: Math.min(wordTime + wordDuration, audioDuration),
      };
      wordTime += wordDuration;
      return timing;
    });
    
    const segment: TranscriptSegment = {
      start: Math.min(currentTime, audioDuration),
      end: Math.min(currentTime + segmentDuration, audioDuration),
      text: sentence.trim(),
      words: wordTimings,
    };
    
    if (segment.text.length > 0) {
      result.push(segment);
    }
    
    currentTime += segmentDuration + targetGapTime;
  }
  
  return result;
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
        // Replit AI Integration only supports 'json' format for gpt-4o-mini-transcribe
        // Word timing will be synthesized using improved segment-aware algorithm
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
      // Use speech start detection to align captions with actual speech
      aiLogger.warn("OpenAI returned no timestamps, falling back to synthesized timing");
      if (audioDuration && audioDuration > 0) {
        // Detect when speech actually starts to offset timing
        const speechStart = await detectSpeechStart(audioPath);
        const segments = createSegmentsFromTextWithDuration(text, audioDuration, speechStart);
        aiLogger.info(`Created ${segments.length} transcript segments with synthesized word timing (duration: ${audioDuration.toFixed(1)}s, speech starts at ${speechStart.toFixed(2)}s)`);
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
      
      // Check for model-not-found or format-not-supported errors - these won't be fixed by retrying
      const isModelError = errorMessage.toLowerCase().includes("model") || 
                          errorMessage.toLowerCase().includes("not compatible") ||
                          errorMessage.toLowerCase().includes("response_format");
      
      if (isModelError) {
        aiLogger.warn(`Model or format error detected - will fall back to Gemini`);
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
      // Include speech start detection to align captions with actual speech
      if (audioDuration) {
        const speechStart = await detectSpeechStart(audioPath);
        const segments = createSegmentsFromTextWithDuration(text, audioDuration, speechStart);
        aiLogger.info(`Created ${segments.length} transcript segments with synthesized word timing (speech starts at ${speechStart.toFixed(2)}s)`);
        return segments;
      } else {
        const segments = createSegmentsFromText(text);
        aiLogger.info(`Created ${segments.length} transcript segments with estimated timestamps`);
        return segments;
      }
      
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

/**
 * Transcribe audio with enhanced AI features (speakers, chapters, sentiment, entities)
 * Returns full TranscriptEnhancedResult when using AssemblyAI, or just segments for fallback providers
 */
export async function transcribeAudioEnhanced(
  audioPath: string,
  audioDuration?: number,
  options?: TranscriptionOptions
): Promise<TranscriptEnhancedResult> {
  const languageHint = options?.languageHint;
  const filterLowConfidence = options?.filterLowConfidence ?? true;
  const confidenceThreshold = options?.confidenceThreshold ?? 0.5;
  
  aiLogger.info(`Starting audio transcription...${languageHint ? ` (language hint: ${languageHint})` : ""}`);
  if (filterLowConfidence) {
    aiLogger.debug(`Low-confidence filtering enabled (threshold: ${confidenceThreshold})`);
  }
  
  const hasAssemblyAI = !!process.env.ASSEMBLYAI_API_KEY;
  const hasOpenAI = !!process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  const hasGemini = !!process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
  
  // Primary: AssemblyAI (best for captions - native word-level timestamps + enhanced AI features)
  if (hasAssemblyAI) {
    const assemblyAIResult = await transcribeWithAssemblyAI(audioPath, audioDuration, languageHint);
    if (assemblyAIResult && assemblyAIResult.segments.length > 0) {
      aiLogger.info(`Transcription successful with AssemblyAI: ${assemblyAIResult.segments.length} segments with native word timing`);
      return assemblyAIResult;
    }
    aiLogger.warn("AssemblyAI transcription failed, trying OpenAI fallback...");
  }
  
  // Secondary: OpenAI (synthesized word timing) - no enhanced features
  if (hasOpenAI) {
    const openAIResult = await transcribeWithOpenAI(audioPath, audioDuration, languageHint);
    if (openAIResult.length > 0) {
      aiLogger.info(`Transcription successful with OpenAI: ${openAIResult.length} segments extracted`);
      return { segments: openAIResult };
    }
    aiLogger.warn("OpenAI transcription failed, trying Gemini fallback...");
  }
  
  // Fallback: Gemini - no enhanced features
  if (hasGemini) {
    const geminiResult = await transcribeWithGemini(audioPath, audioDuration, languageHint);
    if (geminiResult.length > 0) {
      aiLogger.info(`Transcription successful with Gemini: ${geminiResult.length} segments extracted`);
      return { segments: geminiResult };
    }
  }
  
  aiLogger.error("All transcription methods failed. No segments extracted from audio.");
  return { segments: [] };
}

/**
 * Transcribe audio and return just segments (backward compatible)
 */
export async function transcribeAudio(
  audioPath: string,
  audioDuration?: number,
  options?: TranscriptionOptions
): Promise<TranscriptSegment[]> {
  const result = await transcribeAudioEnhanced(audioPath, audioDuration, options);
  return result.segments;
}
