import ffmpeg from "fluent-ffmpeg";
import { promises as fs, createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import axios from "axios";
import type { VideoAnalysis, FrameAnalysis, EditPlan, EditAction, TranscriptSegment, StockMediaItem, SemanticAnalysis } from "@shared/schema";
import { createLogger } from "../utils/logger";

export interface ChapterInfo {
  title: string;
  startTime: number;
  endTime: number;
  type?: "intro" | "section" | "climax" | "outro" | "keypoint";
}

export interface ChapterExtractionInput {
  editPlan?: EditPlan;
  semanticAnalysis?: SemanticAnalysis;
  videoDuration: number;
  outputTimeMapping?: { sourceStart: number; sourceEnd: number; outputStart: number }[];
}

const videoLogger = createLogger("video-processor");

const UPLOADS_DIR = "/tmp/uploads";
const FRAMES_DIR = "/tmp/frames";
const OUTPUT_DIR = "/tmp/output";
const AUDIO_DIR = "/tmp/audio";
const STOCK_DIR = "/tmp/stock";

const FFPROBE_TIMEOUT_MS = 30000;
const FFMPEG_SHORT_TIMEOUT_MS = 2 * 60 * 1000;
const FFMPEG_LONG_TIMEOUT_MS = 10 * 60 * 1000;
const CHAPTERS_DIR = "/tmp/chapters";

export function generateChaptersFromEditPlan(input: ChapterExtractionInput): ChapterInfo[] {
  const { editPlan, semanticAnalysis, videoDuration, outputTimeMapping } = input;
  const chapters: ChapterInfo[] = [];
  const usedTimestamps = new Set<number>();
  
  const mapSourceToOutputTime = (sourceTime: number): number | null => {
    if (!outputTimeMapping || outputTimeMapping.length === 0) {
      return sourceTime;
    }
    
    for (const mapping of outputTimeMapping) {
      if (sourceTime >= mapping.sourceStart && sourceTime < mapping.sourceEnd) {
        return mapping.outputStart + (sourceTime - mapping.sourceStart);
      }
    }
    return null;
  };
  
  const addChapter = (title: string, sourceTime: number, type: ChapterInfo["type"]) => {
    const outputTime = mapSourceToOutputTime(sourceTime);
    if (outputTime === null || outputTime < 0 || outputTime >= videoDuration) {
      return;
    }
    
    const roundedTime = Math.round(outputTime * 10) / 10;
    if (usedTimestamps.has(roundedTime)) {
      return;
    }
    
    usedTimestamps.add(roundedTime);
    chapters.push({
      title: title.slice(0, 80),
      startTime: roundedTime,
      endTime: videoDuration,
      type,
    });
  };
  
  if (semanticAnalysis?.structureAnalysis) {
    const structure = semanticAnalysis.structureAnalysis;
    
    if (structure.introEnd !== undefined && structure.introEnd > 0) {
      addChapter("Introduction", 0, "intro");
    }
    
    if (structure.mainStart !== undefined) {
      addChapter("Main Content", structure.mainStart, "section");
    }
    
    if (structure.outroStart !== undefined) {
      addChapter("Conclusion", structure.outroStart, "outro");
    }
  }
  
  if (semanticAnalysis?.keyMoments && semanticAnalysis.keyMoments.length > 0) {
    for (const moment of semanticAnalysis.keyMoments) {
      if (moment.importance === "high" || moment.importance === "medium") {
        const title = moment.description || "Key Point";
        addChapter(title, moment.timestamp, "keypoint");
      }
    }
  }
  
  if (semanticAnalysis?.topicFlow && semanticAnalysis.topicFlow.length > 0) {
    for (const topic of semanticAnalysis.topicFlow) {
      if (topic.name && topic.start >= 0) {
        addChapter(topic.name, topic.start, "section");
      }
    }
  }
  
  if (editPlan?.keyPoints && editPlan.keyPoints.length > 0) {
    const interval = videoDuration / (editPlan.keyPoints.length + 1);
    editPlan.keyPoints.forEach((point, idx) => {
      const estimatedTime = interval * (idx + 1);
      addChapter(point, estimatedTime, "keypoint");
    });
  }
  
  chapters.sort((a, b) => a.startTime - b.startTime);
  
  for (let i = 0; i < chapters.length - 1; i++) {
    chapters[i].endTime = chapters[i + 1].startTime;
  }
  
  if (chapters.length > 0) {
    chapters[chapters.length - 1].endTime = videoDuration;
  }
  
  if (chapters.length === 0 && videoDuration > 30) {
    chapters.push({
      title: "Video",
      startTime: 0,
      endTime: videoDuration,
      type: "section",
    });
  }
  
  const validChapters = chapters.filter((ch, idx) => {
    const duration = ch.endTime - ch.startTime;
    if (duration < 2) {
      videoLogger.debug(`[Chapters] Removing short chapter: "${ch.title}" (${duration.toFixed(1)}s)`);
      return false;
    }
    return true;
  });
  
  for (let i = 0; i < validChapters.length - 1; i++) {
    validChapters[i].endTime = validChapters[i + 1].startTime;
  }
  if (validChapters.length > 0) {
    validChapters[validChapters.length - 1].endTime = videoDuration;
  }
  
  videoLogger.info(`[Chapters] Generated ${validChapters.length} chapters for ${videoDuration.toFixed(1)}s video`);
  validChapters.forEach((ch, i) => {
    videoLogger.debug(`  [${i}] ${ch.startTime.toFixed(1)}s - ${ch.endTime.toFixed(1)}s: "${ch.title}" (${ch.type})`);
  });
  
  return validChapters;
}

export function generateFFmpegChapterMetadata(chapters: ChapterInfo[]): string {
  if (chapters.length === 0) {
    return "";
  }
  
  const lines: string[] = [";FFMETADATA1"];
  
  for (const chapter of chapters) {
    const startMs = Math.round(chapter.startTime * 1000);
    const endMs = Math.round(chapter.endTime * 1000);
    
    const escapedTitle = chapter.title
      .replace(/\\/g, "\\\\")
      .replace(/=/g, "\\=")
      .replace(/;/g, "\\;")
      .replace(/#/g, "\\#")
      .replace(/\n/g, " ");
    
    lines.push("");
    lines.push("[CHAPTER]");
    lines.push("TIMEBASE=1/1000");
    lines.push(`START=${startMs}`);
    lines.push(`END=${endMs}`);
    lines.push(`title=${escapedTitle}`);
  }
  
  return lines.join("\n") + "\n";
}

export async function embedChapterMetadata(
  inputPath: string,
  outputPath: string,
  chapters: ChapterInfo[],
  tempFiles: string[]
): Promise<void> {
  if (chapters.length === 0) {
    videoLogger.info("[Chapters] No chapters to embed, copying file as-is");
    await fs.copyFile(inputPath, outputPath);
    return;
  }
  
  await fs.mkdir(CHAPTERS_DIR, { recursive: true });
  
  const chapterMetadataPath = path.join(CHAPTERS_DIR, `chapters_${uuidv4()}.txt`);
  const metadataContent = generateFFmpegChapterMetadata(chapters);
  await fs.writeFile(chapterMetadataPath, metadataContent, "utf-8");
  tempFiles.push(chapterMetadataPath);
  
  videoLogger.info(`[Chapters] Embedding ${chapters.length} chapters into output video`);
  videoLogger.debug(`[Chapters] Metadata file: ${chapterMetadataPath}`);
  
  const cmd = ffmpeg()
    .input(inputPath)
    .input(chapterMetadataPath)
    .inputOptions(["-f", "ffmetadata"])
    .outputOptions([
      "-map", "0",
      "-map_metadata", "1",
      "-c", "copy",
    ])
    .output(outputPath);
  
  await runFfmpegWithTimeout(cmd, FFMPEG_SHORT_TIMEOUT_MS, [outputPath, chapterMetadataPath]);
  
  videoLogger.info(`[Chapters] Successfully embedded ${chapters.length} chapters`);
}

class FFmpegTimeoutError extends Error {
  constructor(message: string, public tempFiles?: string[]) {
    super(message);
    this.name = "FFmpegTimeoutError";
  }
}

function runFfmpegWithTimeout(
  command: ffmpeg.FfmpegCommand,
  timeoutMs: number,
  tempFiles: string[] = []
): Promise<void> {
  return new Promise((resolve, reject) => {
    let completed = false;
    let ffmpegProcess: any = null;

    const timeoutId = setTimeout(() => {
      if (!completed) {
        completed = true;
        if (ffmpegProcess) {
          try {
            ffmpegProcess.kill("SIGKILL");
          } catch {}
        }
        cleanupTempFilesSync(tempFiles);
        reject(new FFmpegTimeoutError(`FFmpeg process timed out after ${timeoutMs}ms`, tempFiles));
      }
    }, timeoutMs);

    command
      .on("start", (cmdline: string) => {
        ffmpegProcess = (command as any).ffmpegProc;
      })
      .on("end", () => {
        if (!completed) {
          completed = true;
          clearTimeout(timeoutId);
          resolve();
        }
      })
      .on("error", (err: Error) => {
        if (!completed) {
          completed = true;
          clearTimeout(timeoutId);
          reject(err);
        }
      })
      .run();
  });
}

function runFfprobeWithTimeout(
  filePath: string,
  timeoutMs: number = FFPROBE_TIMEOUT_MS
): Promise<ffmpeg.FfprobeData> {
  return new Promise((resolve, reject) => {
    let completed = false;

    const timeoutId = setTimeout(() => {
      if (!completed) {
        completed = true;
        reject(new FFmpegTimeoutError(`FFprobe timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (!completed) {
        completed = true;
        clearTimeout(timeoutId);
        if (err) {
          reject(err);
        } else {
          resolve(metadata);
        }
      }
    });
  });
}

function cleanupTempFilesSync(paths: string[]): void {
  for (const p of paths) {
    try {
      fs.unlink(p).catch(() => {});
    } catch {}
  }
}

// Temp file tracking for cleanup on unhandled errors
const ALL_TEMP_DIRS = [UPLOADS_DIR, FRAMES_DIR, OUTPUT_DIR, AUDIO_DIR, STOCK_DIR, CHAPTERS_DIR];

// Proxy video dimensions for fast preview rendering
const PROXY_HEIGHT = 480;

// Generate a low-resolution proxy video for faster editing/preview
export async function generateProxyVideo(
  inputPath: string,
  outputPath: string
): Promise<{ width: number; height: number; duration: number }> {
  await ensureDirs();
  
  const metadata = await getVideoMetadata(inputPath);
  const scale = PROXY_HEIGHT / metadata.height;
  const proxyWidth = Math.round(metadata.width * scale / 2) * 2; // Ensure even
  
  videoLogger.info(`Generating ${proxyWidth}x${PROXY_HEIGHT} proxy from ${metadata.width}x${metadata.height} original`);
  
  const cmd = ffmpeg(inputPath)
    .outputOptions([
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "32",
      "-vf", `scale=${proxyWidth}:${PROXY_HEIGHT}`,
      "-c:a", "aac",
      "-b:a", "64k",
      "-threads", "4",
    ])
    .output(outputPath);
  
  await runFfmpegWithTimeout(cmd, FFMPEG_LONG_TIMEOUT_MS, [outputPath]);
  
  videoLogger.info(`Proxy video generated: ${outputPath}`);
  
  return { width: proxyWidth, height: PROXY_HEIGHT, duration: metadata.duration };
}

// Clean up stale temp files older than maxAgeHours
// This should be called on server startup to prevent disk space from filling
export async function cleanupStaleTempFiles(maxAgeHours: number = 2): Promise<{ cleaned: number; errors: number }> {
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  const now = Date.now();
  let cleaned = 0;
  let errors = 0;

  for (const dir of ALL_TEMP_DIRS) {
    try {
      await fs.mkdir(dir, { recursive: true });
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        try {
          const stat = await fs.stat(fullPath);
          const age = now - stat.mtimeMs;
          
          if (age > maxAgeMs) {
            if (entry.isDirectory()) {
              await fs.rm(fullPath, { recursive: true });
            } else {
              await fs.unlink(fullPath);
            }
            cleaned++;
            videoLogger.debug(`[TempCleanup] Removed stale file: ${fullPath} (age: ${(age / 1000 / 60).toFixed(1)} min)`);
          }
        } catch (e) {
          errors++;
          // File may have been removed by another process
        }
      }
    } catch (e) {
      // Directory may not exist yet
    }
  }

  if (cleaned > 0 || errors > 0) {
    videoLogger.info(`[TempCleanup] Completed: ${cleaned} files cleaned, ${errors} errors`);
  }
  
  return { cleaned, errors };
}

async function ensureDirs() {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  await fs.mkdir(FRAMES_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.mkdir(AUDIO_DIR, { recursive: true });
  await fs.mkdir(STOCK_DIR, { recursive: true });
}

export async function getVideoMetadata(
  filePath: string
): Promise<{ duration: number; width: number; height: number; fps: number }> {
  const metadata = await runFfprobeWithTimeout(filePath, FFPROBE_TIMEOUT_MS);
  
  const videoStream = metadata.streams.find((s) => s.codec_type === "video");
  const duration = metadata.format.duration || 0;

  let fps = 30;
  if (videoStream?.r_frame_rate) {
    const parts = videoStream.r_frame_rate.split("/");
    if (parts.length === 2) {
      const num = parseFloat(parts[0]);
      const den = parseFloat(parts[1]);
      if (den !== 0 && !isNaN(num) && !isNaN(den)) {
        fps = num / den;
      }
    } else {
      const parsed = parseFloat(videoStream.r_frame_rate);
      if (!isNaN(parsed)) {
        fps = parsed;
      }
    }
  }

  return {
    duration,
    width: videoStream?.width || 1920,
    height: videoStream?.height || 1080,
    fps,
  };
}

export async function extractFrames(
  videoPath: string,
  numFrames: number = 12
): Promise<string[]> {
  await ensureDirs();

  const metadata = await getVideoMetadata(videoPath);
  const duration = metadata.duration;
  const frameId = uuidv4();
  const frameDir = path.join(FRAMES_DIR, frameId);
  await fs.mkdir(frameDir, { recursive: true });

  const interval = duration / (numFrames + 1);
  const framePaths: string[] = [];

  for (let i = 1; i <= numFrames; i++) {
    const timestamp = interval * i;
    const framePath = path.join(frameDir, `frame_${String(i).padStart(3, "0")}.jpg`);

    const cmd = ffmpeg(videoPath)
      .seekInput(timestamp)
      .frames(1)
      .output(framePath)
      .outputOptions(["-q:v 2"]);
    
    await runFfmpegWithTimeout(cmd, FFMPEG_SHORT_TIMEOUT_MS, [framePath]);

    framePaths.push(framePath);
  }

  return framePaths;
}

export async function extractAudio(videoPath: string): Promise<string> {
  await ensureDirs();

  const audioId = uuidv4();
  const audioPath = path.join(AUDIO_DIR, `${audioId}.mp3`);

  const cmd = ffmpeg(videoPath)
    .noVideo()
    .audioCodec("libmp3lame")
    .audioBitrate("64k")
    .audioChannels(1)
    .audioFrequency(16000)
    .output(audioPath);
  
  await runFfmpegWithTimeout(cmd, FFMPEG_SHORT_TIMEOUT_MS, [audioPath]);

  return audioPath;
}

export async function detectSilence(
  videoPath: string,
  silenceThreshold: number = -30,
  silenceDuration: number = 1.5
): Promise<{ start: number; end: number }[]> {
  return new Promise((resolve, reject) => {
    const silentSegments: { start: number; end: number }[] = [];
    let silenceStart: number | null = null;
    let completed = false;
    let ffmpegProcess: any = null;

    const timeoutId = setTimeout(() => {
      if (!completed) {
        completed = true;
        if (ffmpegProcess) {
          try {
            ffmpegProcess.kill("SIGKILL");
          } catch {}
        }
        reject(new FFmpegTimeoutError(`Silence detection timed out after ${FFMPEG_SHORT_TIMEOUT_MS}ms`));
      }
    }, FFMPEG_SHORT_TIMEOUT_MS);

    const cmd = ffmpeg(videoPath)
      .audioFilters([
        `silencedetect=noise=${silenceThreshold}dB:d=${silenceDuration}`,
      ])
      .format("null")
      .output("-")
      .on("start", () => {
        ffmpegProcess = (cmd as any).ffmpegProc;
      })
      .on("stderr", (line: string) => {
        const startMatch = line.match(/silence_start: ([\d.]+)/);
        const endMatch = line.match(/silence_end: ([\d.]+)/);

        if (startMatch) {
          silenceStart = parseFloat(startMatch[1]);
        }
        if (endMatch && silenceStart !== null) {
          silentSegments.push({
            start: silenceStart,
            end: parseFloat(endMatch[1]),
          });
          silenceStart = null;
        }
      })
      .on("end", () => {
        if (!completed) {
          completed = true;
          clearTimeout(timeoutId);
          resolve(silentSegments);
        }
      })
      .on("error", (err) => {
        if (!completed) {
          completed = true;
          clearTimeout(timeoutId);
          reject(err);
        }
      });
    
    cmd.run();
  });
}

async function downloadFile(url: string, outputPath: string): Promise<void> {
  const response = await axios({
    method: "GET",
    url,
    responseType: "stream",
    timeout: 120000,
  });
  
  const writer = createWriteStream(outputPath);
  await pipeline(response.data, writer);
}

function escapeFFmpegText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "'\\''")
    .replace(/:/g, "\\:")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

// Word timing type for karaoke-style captions
interface WordTiming {
  word: string;
  start: number;
  end: number;
}

interface CaptionWithWords {
  start: number;
  end: number;
  text: string;
  words?: WordTiming[];
}

// Escape special ASS characters in text
function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')  // Escape backslashes first
    .replace(/\{/g, '\\{')   // Escape opening braces
    .replace(/\}/g, '\\}')   // Escape closing braces
    .replace(/\n/g, '\\N');  // Convert newlines to ASS format
}

// Check if two time intervals overlap using proper mathematical intersection
// Two intervals [start1, end1) and [start2, end2) overlap if start1 < end2 AND start2 < end1
// This correctly handles all cases: partial overlap, complete containment, and edge cases
function intervalsOverlap(start1: number, end1: number, start2: number, end2: number): boolean {
  return start1 < end2 && start2 < end1;
}

// Generate ASS (Advanced SubStation Alpha) subtitle file for karaoke-style captions
// Hormozi/Reels style: 2-3 words at a time with word-by-word highlight animation
function generateAssContent(
  captions: CaptionWithWords[],
  videoWidth: number,
  videoHeight: number
): string {
  // Position captions near the bottom of the video (15% from bottom)
  const marginBottom = Math.round(videoHeight * 0.12);
  
  // Large, bold font for impact (scales with video height)
  const fontSize = Math.max(Math.round(videoHeight / 12), 48);
  
  // Hormozi-style colors (BGR format in ASS):
  // - PrimaryColour: Yellow highlight color (shown as word is spoken)
  // - SecondaryColour: White (color before word is highlighted)
  const highlightColor = "&H0000FFFF";  // Yellow (BGR: 00FFFF = Yellow)
  const baseColor = "&H00FFFFFF";       // White base color
  const outlineColor = "&H00000000";    // Black outline
  const backColor = "&H00000000";       // Transparent background
  
  // ASS file header with bold styling
  const header = `[Script Info]
Title: Karaoke Captions
ScriptType: v4.00+
PlayResX: ${videoWidth}
PlayResY: ${videoHeight}
WrapStyle: 0
Timer: 100.0000

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans,${fontSize},${highlightColor},${baseColor},${outlineColor},${backColor},1,0,0,0,100,100,0,0,1,4,2,2,30,30,${marginBottom},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const formatAssTime = (seconds: number): string => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const cs = Math.floor((seconds % 1) * 100);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  };

  // Collect all words from all captions with timing
  const allWords: WordTiming[] = [];
  for (const cap of captions) {
    if (cap.words && cap.words.length > 0) {
      allWords.push(...cap.words);
    }
  }

  if (allWords.length === 0) {
    // Fallback: synthesize word-level timing from segments
    // Split each segment's text into words and estimate timing
    for (const cap of captions) {
      const words = cap.text.split(/\s+/).filter(w => w.trim());
      if (words.length === 0) continue;
      
      const segDuration = cap.end - cap.start;
      const wordDuration = segDuration / words.length;
      
      for (let i = 0; i < words.length; i++) {
        allWords.push({
          word: words[i],
          start: cap.start + (i * wordDuration),
          end: cap.start + ((i + 1) * wordDuration),
        });
      }
    }
    
    // If still no words after synthesis, return empty
    if (allWords.length === 0) {
      return header;
    }
  }
  
  // Sort words by start time to handle any out-of-order input
  allWords.sort((a, b) => a.start - b.start);
  
  // Filter out words with invalid timing (end <= start)
  const validWords = allWords.filter(w => w.end > w.start);

  // Use validated words for phrase grouping
  if (validWords.length === 0) {
    return header;
  }
  
  // Group words into phrases of 2-3 words
  // Force new line on gaps > 0.5 seconds
  const WORDS_PER_PHRASE = 3;
  const GAP_THRESHOLD = 0.5; // seconds
  
  const phrases: WordTiming[][] = [];
  let currentPhrase: WordTiming[] = [];
  
  for (let i = 0; i < validWords.length; i++) {
    const word = validWords[i];
    const prevWord = i > 0 ? validWords[i - 1] : null;
    
    // Check if we should start a new phrase
    const gapToPrevious = prevWord ? word.start - prevWord.end : 0;
    const shouldBreak = gapToPrevious > GAP_THRESHOLD || currentPhrase.length >= WORDS_PER_PHRASE;
    
    if (shouldBreak && currentPhrase.length > 0) {
      phrases.push(currentPhrase);
      currentPhrase = [];
    }
    
    currentPhrase.push(word);
  }
  
  // Don't forget the last phrase
  if (currentPhrase.length > 0) {
    phrases.push(currentPhrase);
  }
  
  // FINAL VALIDATION: Ensure phrases are sorted by start time and non-overlapping
  // Sort phrases by their first word's start time
  phrases.sort((a, b) => (a[0]?.start || 0) - (b[0]?.start || 0));
  
  // Remove any phrases that would create overlap (start before previous end)
  const sanitizedPhrases: WordTiming[][] = [];
  let lastEnd = -Infinity;
  
  for (const phrase of phrases) {
    if (phrase.length === 0) continue;
    const phraseStart = phrase[0].start;
    
    // Only include phrases that start after the previous phrase ended
    if (phraseStart >= lastEnd) {
      sanitizedPhrases.push(phrase);
      lastEnd = phrase[phrase.length - 1].end;
    }
    // Otherwise skip this phrase to prevent overlap
  }

  // Build dialogue lines with karaoke effect
  // CRITICAL: Each phrase must have NON-OVERLAPPING timing to show one at a time
  const dialogueLines: string[] = [];
  
  for (let p = 0; p < sanitizedPhrases.length; p++) {
    const phrase = sanitizedPhrases[p];
    if (phrase.length === 0) continue;
    
    const phraseStart = phrase[0].start;
    // End this phrase RIGHT BEFORE the next phrase starts (no overlap)
    // This ensures only ONE phrase shows at any time
    const nextPhrase = sanitizedPhrases[p + 1];
    let phraseEnd: number;
    
    if (nextPhrase && nextPhrase.length > 0) {
      // CRITICAL: End BEFORE next phrase starts to prevent overlap
      const nextPhraseStart = nextPhrase[0].start;
      const lastWordEnd = phrase[phrase.length - 1].end;
      
      // Calculate end time: earlier of word end or next phrase start - 0.01s
      phraseEnd = Math.min(lastWordEnd, nextPhraseStart - 0.01);
      
      // Edge case: if phraseEnd <= phraseStart (malformed/unsorted timing)
      if (phraseEnd <= phraseStart) {
        // Try to give minimum duration while respecting next phrase
        const minEnd = phraseStart + 0.05; // Absolute minimum 50ms duration
        if (minEnd < nextPhraseStart - 0.01) {
          phraseEnd = minEnd;
        } else {
          // Extreme edge case: phrases are too close, skip this phrase
          continue;
        }
      }
      
      // FINAL INVARIANT: Absolutely ensure phraseEnd < nextPhraseStart
      // This is the ultimate guard against any overlap
      if (phraseEnd >= nextPhraseStart) {
        phraseEnd = nextPhraseStart - 0.01;
        if (phraseEnd <= phraseStart) {
          continue; // Skip phrase entirely if impossible to fit
        }
      }
    } else {
      // Last phrase - use actual end time with minimum duration
      phraseEnd = Math.max(phrase[phrase.length - 1].end, phraseStart + 0.3);
    }
    
    // Build karaoke text with \k timing for each word
    let karaokeText = '';
    
    for (let i = 0; i < phrase.length; i++) {
      const word = phrase[i];
      // Duration in centiseconds (1/100th of a second)
      const wordDuration = Math.max(Math.round((word.end - word.start) * 100), 15);
      const escapedWord = escapeAssText(word.word);
      
      // \k creates the karaoke highlight effect
      karaokeText += `{\\k${wordDuration}}${escapedWord}`;
      
      // Add space between words (not after last word)
      if (i < phrase.length - 1) {
        karaokeText += ' ';
      }
    }
    
    dialogueLines.push(
      `Dialogue: 0,${formatAssTime(phraseStart)},${formatAssTime(phraseEnd)},Default,,0,0,0,,${karaokeText}`
    );
  }
  
  return header + dialogueLines.join('\n') + '\n';
}

// Legacy SRT generation (kept for compatibility)
function generateSrtContent(captions: { start: number; end: number; text: string }[]): string {
  return captions.map((cap, i) => {
    const formatTime = (seconds: number) => {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      const ms = Math.floor((seconds % 1) * 1000);
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
    };
    return `${i + 1}\n${formatTime(cap.start)} --> ${formatTime(cap.end)}\n${cap.text}\n`;
  }).join("\n");
}

export interface EditOptions {
  addCaptions: boolean;
  addBroll: boolean;
  removeSilence: boolean;
  generateAiImages?: boolean;
  addTransitions?: boolean;
  renderQuality?: "preview" | "balanced" | "quality";
}

interface DownloadedStock {
  item: StockMediaItem;
  localPath: string;
}

async function createImageBroll(
  imagePath: string,
  outputPath: string,
  duration: number,
  width: number,
  height: number,
  textOverlay?: string
): Promise<void> {
  const filters: string[] = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `zoompan=z='min(zoom+0.0015,1.2)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${Math.ceil(duration * 25)}:s=${width}x${height}:fps=25`
  ];
  
  if (textOverlay) {
    const escapedText = escapeFFmpegText(textOverlay);
    filters.push(`drawtext=text='${escapedText}':fontcolor=white:fontsize=36:borderw=3:bordercolor=black:x=(w-text_w)/2:y=h-th-40`);
  }

  const cmd = ffmpeg()
    .input(imagePath)
    .inputOptions(["-loop", "1"])
    .input("anullsrc=channel_layout=stereo:sample_rate=44100")
    .inputOptions(["-f", "lavfi"])
    .outputOptions([
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-t", String(duration),
      "-vf", filters.join(","),
      "-shortest",
      "-threads", "2",
    ])
    .output(outputPath);
  
  await runFfmpegWithTimeout(cmd, FFMPEG_LONG_TIMEOUT_MS, [outputPath]);
}

async function createVideoBroll(
  videoPath: string,
  outputPath: string,
  duration: number,
  width: number,
  height: number,
  textOverlay?: string
): Promise<void> {
  const filters: string[] = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`
  ];
  
  if (textOverlay) {
    const escapedText = escapeFFmpegText(textOverlay);
    filters.push(`drawtext=text='${escapedText}':fontcolor=white:fontsize=36:borderw=3:bordercolor=black:x=(w-text_w)/2:y=h-th-40`);
  }

  const cmd = ffmpeg(videoPath)
    .setDuration(duration)
    .outputOptions([
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "96k",
      "-vf", filters.join(","),
      "-threads", "2",
    ])
    .output(outputPath);
  
  await runFfmpegWithTimeout(cmd, FFMPEG_LONG_TIMEOUT_MS, [outputPath]);
}

async function createVideoSegment(
  sourcePath: string,
  outputPath: string,
  start: number,
  duration: number,
  textOverlays?: { text: string; startOffset: number; endOffset: number }[]
): Promise<void> {
  const filters: string[] = [];
  
  if (textOverlays && textOverlays.length > 0) {
    for (const overlay of textOverlays) {
      const escapedText = escapeFFmpegText(overlay.text);
      filters.push(
        `drawtext=text='${escapedText}':fontcolor=white:fontsize=42:borderw=3:bordercolor=black:x=(w-text_w)/2:y=h-th-80:enable='between(t,${overlay.startOffset},${overlay.endOffset})'`
      );
    }
  }

  let cmd = ffmpeg(sourcePath)
    .setStartTime(start)
    .setDuration(duration);

  const outputOptions = [
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "23",
    "-c:a", "aac",
    "-b:a", "96k",
    "-max_muxing_queue_size", "1024",
    "-threads", "2",
  ];

  if (filters.length > 0) {
    cmd = cmd.videoFilters(filters);
  }

  cmd.outputOptions(outputOptions).output(outputPath);
  
  await runFfmpegWithTimeout(cmd, FFMPEG_LONG_TIMEOUT_MS, [outputPath]);
}

async function getFileDuration(filePath: string): Promise<number> {
  const metadata = await runFfprobeWithTimeout(filePath, FFPROBE_TIMEOUT_MS);
  return metadata.format.duration || 0;
}

async function concatSegmentsSimple(
  segmentPaths: string[],
  outputPath: string
): Promise<void> {
  const concatListPath = path.join(OUTPUT_DIR, `concat_${uuidv4()}.txt`);
  const concatContent = segmentPaths.map(p => `file '${p}'`).join("\n");
  await fs.writeFile(concatListPath, concatContent);

  try {
    const cmd = ffmpeg()
      .input(concatListPath)
      .inputOptions(["-f", "concat", "-safe", "0"])
      .outputOptions([
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "96k",
        "-max_muxing_queue_size", "1024",
        "-threads", "2",
      ])
      .output(outputPath);
    
    await runFfmpegWithTimeout(cmd, FFMPEG_LONG_TIMEOUT_MS, [outputPath, concatListPath]);
  } finally {
    await fs.unlink(concatListPath).catch(() => {});
  }
}

async function concatSegmentsWithTransitions(
  segmentPaths: string[],
  outputPath: string,
  transitionDuration: number = 0.5,
  tempFiles: string[]
): Promise<void> {
  if (segmentPaths.length === 0) {
    throw new Error("No segments to concatenate");
  }
  
  if (segmentPaths.length === 1) {
    await fs.copyFile(segmentPaths[0], outputPath);
    return;
  }

  videoLogger.info(`Concatenating ${segmentPaths.length} segments with crossfade transitions (${transitionDuration}s)`);
  
  let currentPath = segmentPaths[0];
  
  for (let i = 1; i < segmentPaths.length; i++) {
    const nextSegment = segmentPaths[i];
    const isLastPair = i === segmentPaths.length - 1;
    const intermediatePath = isLastPair 
      ? outputPath 
      : path.join(OUTPUT_DIR, `trans_${uuidv4()}_${i}.mp4`);
    
    try {
      await concatTwoWithTransition(
        currentPath,
        nextSegment,
        intermediatePath,
        "fade",
        transitionDuration
      );
      
      videoLogger.debug(`Applied crossfade transition between segment ${i-1} and ${i}`);
      
      if (!isLastPair) {
        tempFiles.push(intermediatePath);
        currentPath = intermediatePath;
      }
    } catch (err) {
      videoLogger.error(`Failed to apply transition between segments ${i-1} and ${i}:`, err);
      throw err;
    }
  }
  
  videoLogger.info(`Successfully concatenated ${segmentPaths.length} segments with transitions`);
}

async function burnSubtitles(
  inputPath: string,
  outputPath: string,
  subtitlePath: string
): Promise<void> {
  const escapedPath = subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''");
  const isAss = subtitlePath.endsWith('.ass');
  
  const cmd = ffmpeg(inputPath);
  
  if (isAss) {
    cmd.videoFilters([`ass='${escapedPath}'`]);
  } else {
    cmd.videoFilters([
      `subtitles='${escapedPath}':force_style='FontSize=24,PrimaryColour=&Hffffff,OutlineColour=&H000000,BorderStyle=3,Outline=2,Shadow=1'`
    ]);
  }
  
  cmd.outputOptions([
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "23",
      "-c:a", "copy",
      "-threads", "2",
    ])
    .output(outputPath);
  
  await runFfmpegWithTimeout(cmd, FFMPEG_LONG_TIMEOUT_MS, [outputPath]);
}

async function hasAudioStream(filePath: string): Promise<boolean> {
  try {
    const metadata = await runFfprobeWithTimeout(filePath, FFPROBE_TIMEOUT_MS);
    const audioStream = metadata.streams.find((s) => s.codec_type === "audio");
    return !!audioStream;
  } catch {
    return false;
  }
}

async function concatTwoWithTransition(
  segment1Path: string,
  segment2Path: string,
  outputPath: string,
  transitionType: string = "fade",
  transitionDuration: number = 0.5
): Promise<number> {
  const validTransitions = ["fade", "wipeleft", "wiperight", "wipeup", "wipedown", "slideleft", "slideright", "circleopen", "circleclose"];
  const transition = validTransitions.includes(transitionType) ? transitionType : "fade";
  
  const seg1Duration = await getFileDuration(segment1Path);
  const offset = Math.max(0, seg1Duration - transitionDuration);
  
  const [hasAudio1, hasAudio2] = await Promise.all([
    hasAudioStream(segment1Path),
    hasAudioStream(segment2Path)
  ]);

  const complexFilterArray: string[] = [
    `[0:v][1:v]xfade=transition=${transition}:duration=${transitionDuration}:offset=${offset}[v]`
  ];
  
  const outputOptions: string[] = [
    "-map", "[v]",
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "23",
    "-threads", "2",
  ];

  if (hasAudio1 && hasAudio2) {
    // Use acrossfade for smooth audio blending during video transition
    // This properly fades out audio 1 while fading in audio 2 at the transition point
    const offsetMs = Math.floor(offset * 1000);
    complexFilterArray.push(
      `[0:a][1:a]acrossfade=d=${transitionDuration}:c1=tri:c2=tri[a]`
    );
    outputOptions.push("-map", "[a]", "-c:a", "aac", "-b:a", "128k");
  } else if (hasAudio1) {
    // Only first segment has audio - just pass it through
    outputOptions.push("-map", "0:a", "-c:a", "aac", "-b:a", "128k");
  } else if (hasAudio2) {
    // Only second segment has audio - delay it to start at offset
    const offsetMs = Math.floor(offset * 1000);
    complexFilterArray.push(`[1:a]adelay=${offsetMs}|${offsetMs}[a]`);
    outputOptions.push("-map", "[a]", "-c:a", "aac", "-b:a", "128k");
  } else {
    outputOptions.push("-an");
  }

  const cmd = ffmpeg()
    .input(segment1Path)
    .input(segment2Path)
    .complexFilter(complexFilterArray)
    .outputOptions(outputOptions)
    .output(outputPath);
  
  await runFfmpegWithTimeout(cmd, FFMPEG_LONG_TIMEOUT_MS, [outputPath]);
  
  return transitionDuration;
}

// Overlay info for B-roll on main video
interface BrollOverlay {
  localPath: string;
  type: "image" | "video" | "ai_generated";
  startTime: number; // When to show overlay (in output timeline)
  duration: number;
  text?: string;
}

// Prepare stock media as overlay video (full-frame for traditional B-roll)
// The overlay fades in/out to smoothly blend with the base video
// Audio continues uninterrupted during the overlay
async function prepareOverlayMedia(
  stock: DownloadedStock,
  duration: number,
  width: number,
  height: number,
  outputPath: string
): Promise<void> {
  if (stock.item.type === "video") {
    const cmd = ffmpeg(stock.localPath)
      .setDuration(duration)
      .outputOptions([
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "23",
        "-an",
        "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
        "-pix_fmt", "yuv420p",
        "-threads", "2",
      ])
      .output(outputPath);
    
    await runFfmpegWithTimeout(cmd, FFMPEG_LONG_TIMEOUT_MS, [outputPath]);
  } else {
    const cmd = ffmpeg()
      .input(stock.localPath)
      .inputOptions(["-loop", "1"])
      .outputOptions([
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "23",
        "-an",
        "-t", String(duration),
        "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,zoompan=z='min(zoom+0.001,1.1)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${Math.ceil(duration * 25)}:s=${width}x${height}:fps=25`,
        "-pix_fmt", "yuv420p",
        "-threads", "2",
      ])
      .output(outputPath);
    
    await runFfmpegWithTimeout(cmd, FFMPEG_LONG_TIMEOUT_MS, [outputPath]);
  }
}

// Encoding presets for different quality modes
const ENCODING_PRESETS = {
  preview: { preset: "ultrafast", crf: 28 },
  balanced: { preset: "fast", crf: 23 },
  quality: { preset: "medium", crf: 20 },
};

type EncodingQuality = keyof typeof ENCODING_PRESETS;

// OPTIMIZED: Apply all overlays in a single FFmpeg pass using complex filter chain
// This is 10-15x faster than applying overlays one at a time
async function applyAllBrollOverlays(
  baseVideoPath: string,
  overlays: BrollOverlay[],
  outputPath: string,
  width: number,
  height: number,
  tempFiles: string[],
  quality: EncodingQuality = "balanced"
): Promise<void> {
  if (overlays.length === 0) {
    await fs.copyFile(baseVideoPath, outputPath);
    return;
  }

  const outputId = uuidv4();
  const fadeDuration = 0.3;
  const { preset, crf } = ENCODING_PRESETS[quality];
  
  videoLogger.info(`Applying ${overlays.length} overlays in single pass (quality: ${quality})`);
  
  // Step 1: Prepare all overlay video files in parallel (scaled to match base video)
  const preparedOverlays: { path: string; startTime: number; duration: number }[] = [];
  
  const preparationPromises = overlays.map(async (overlay, i) => {
    const overlayVideoPath = path.join(OUTPUT_DIR, `overlay_${outputId}_${i}.mp4`);
    
    try {
      await prepareOverlayMedia(
        { item: { type: overlay.type, url: "", query: "", duration: overlay.duration }, localPath: overlay.localPath },
        overlay.duration,
        width,
        height,
        overlayVideoPath
      );
      
      tempFiles.push(overlayVideoPath);
      videoLogger.debug(`Prepared overlay ${i}: at ${overlay.startTime}s for ${overlay.duration}s`);
      
      return {
        index: i,
        path: overlayVideoPath,
        startTime: overlay.startTime,
        duration: overlay.duration,
      };
    } catch (err) {
      videoLogger.error(`Failed to prepare overlay ${i}:`, err);
      return null;
    }
  });
  
  const results = await Promise.all(preparationPromises);
  
  // Filter out failed preparations and sort by index to maintain order
  const validResults = results.filter((r): r is NonNullable<typeof r> => r !== null);
  validResults.sort((a, b) => a.index - b.index);
  
  for (const result of validResults) {
    preparedOverlays.push({
      path: result.path,
      startTime: result.startTime,
      duration: result.duration,
    });
  }

  if (preparedOverlays.length === 0) {
    await fs.copyFile(baseVideoPath, outputPath);
    return;
  }

  // Step 2: Build single-pass complex filter chain for ALL overlays
  // This is the key optimization - instead of N encoding passes, we do just ONE
  videoLogger.info(`Building single-pass complex filter for ${preparedOverlays.length} overlays`);
  
  const filterParts: string[] = [];
  let currentStream = "[0:v]";
  
  // Process each overlay and chain them together
  for (let i = 0; i < preparedOverlays.length; i++) {
    const overlay = preparedOverlays[i];
    const inputIndex = i + 1; // Input 0 is base video, overlays start at 1
    const overlayStream = `[ov${i}]`;
    const outputStream = i === preparedOverlays.length - 1 ? "[outv]" : `[tmp${i}]`;
    
    // Apply fade effects and timing shift to overlay
    filterParts.push(
      `[${inputIndex}:v]format=yuva420p,fade=t=in:st=0:d=${fadeDuration}:alpha=1,fade=t=out:st=${Math.max(0, overlay.duration - fadeDuration)}:d=${fadeDuration}:alpha=1,setpts=PTS-STARTPTS+${overlay.startTime}/TB${overlayStream}`
    );
    
    // Composite overlay onto current stream
    filterParts.push(
      `${currentStream}${overlayStream}overlay=0:0:eof_action=pass${outputStream}`
    );
    
    currentStream = outputStream;
  }
  
  const complexFilter = filterParts.join(";");
  
  // Step 3: Build FFmpeg command with all inputs
  const cmd = ffmpeg().input(baseVideoPath);
  
  // Add all overlay files as inputs
  for (const overlay of preparedOverlays) {
    cmd.input(overlay.path);
  }
  
  cmd.complexFilter(complexFilter)
    .outputOptions([
      "-map", "[outv]",
      "-map", "0:a?",
      "-c:v", "libx264",
      "-preset", preset,
      "-crf", crf.toString(),
      "-c:a", "copy",
      "-threads", "4",
      "-max_muxing_queue_size", "4096",
    ])
    .output(outputPath);
  
  videoLogger.info(`Starting single-pass render with ${preparedOverlays.length} overlays (preset: ${preset}, crf: ${crf})`);
  
  await runFfmpegWithTimeout(cmd, FFMPEG_LONG_TIMEOUT_MS * 2, [outputPath]);
  
  videoLogger.info(`Single-pass render complete: ${outputPath}`);
}

export interface EditResult {
  outputPath: string;
  aiImagesApplied: number;
  aiImagesSkipped: number;
  stockMediaApplied: number;
  brollOverlaysTotal: number;
}

export async function applyEdits(
  videoPath: string,
  editPlan: EditPlan,
  transcript: TranscriptSegment[],
  stockMedia: StockMediaItem[],
  options: EditOptions,
  outputFileName?: string,
  semanticAnalysis?: SemanticAnalysis
): Promise<EditResult> {
  await ensureDirs();
  
  videoLogger.info("=== APPLY EDITS START (OVERLAY MODE) ===");
  videoLogger.debug("Options:", JSON.stringify(options));
  videoLogger.debug("Transcript segments:", transcript.length);
  videoLogger.debug("Stock media items:", stockMedia.length);
  videoLogger.debug("Edit plan actions:", editPlan.actions?.length || 0);
  videoLogger.debug("Semantic analysis available:", !!semanticAnalysis);

  const outputId = outputFileName || uuidv4();
  const outputPath = path.join(OUTPUT_DIR, `${outputId}.mp4`);
  const metadata = await getVideoMetadata(videoPath);
  
  // Track temp files for cleanup on error
  const tempFiles: string[] = [];
  
  try {
    const result = await applyEditsInternal(
      videoPath,
      editPlan,
      transcript,
      stockMedia,
      options,
      outputId,
      outputPath,
      metadata,
      tempFiles,
      semanticAnalysis
    );
    
    // Success - internal function handles its own cleanup
    return result;
  } catch (error) {
    // On error, clean up all temp files (they won't be cleaned by internal function)
    videoLogger.info(`[TempCleanup] Error occurred, cleaning up ${tempFiles.length} temp files`);
    for (const tempPath of tempFiles) {
      if (tempPath !== outputPath) {
        await fs.unlink(tempPath).catch(() => {});
      }
    }
    // Re-throw the error
    throw error;
  }
}

async function applyEditsInternal(
  videoPath: string,
  editPlan: EditPlan,
  transcript: TranscriptSegment[],
  stockMedia: StockMediaItem[],
  options: EditOptions,
  outputId: string,
  outputPath: string,
  metadata: { duration: number; width: number; height: number; fps: number },
  tempFiles: string[],
  semanticAnalysis?: SemanticAnalysis
): Promise<EditResult> {

  // Extract action types from edit plan
  const keepSegments = editPlan.actions
    .filter((a: EditAction) => a.type === "keep" && a.start !== undefined && a.end !== undefined)
    .sort((a, b) => (a.start || 0) - (b.start || 0));

  const cutSegments = editPlan.actions
    .filter((a: EditAction) => a.type === "cut" && a.start !== undefined && a.end !== undefined)
    .sort((a, b) => (a.start || 0) - (b.start || 0));

  const insertStockActions = editPlan.actions
    .filter((a: EditAction) => a.type === "insert_stock" && a.start !== undefined)
    .sort((a, b) => (a.start || 0) - (b.start || 0));

  // Note: insert_ai_image actions are no longer used in edit plans
  // AI images are auto-placed from semantic analysis with embedded timing

  // Text overlays disabled for now - reserved for future "Chapters" feature
  // where chapter titles will appear with nice dark background transitions
  // TODO: Implement chapters feature with topic titles at chapter start points
  const textOverlayActions: EditAction[] = [];
  // Original code (disabled):
  // const textOverlayActions = editPlan.actions
  //   .filter((a: EditAction) => a.type === "add_text_overlay" && a.text && a.start !== undefined);

  const captionActions = editPlan.actions.filter((a: EditAction) => 
    a.type === "add_caption" && a.text
  );

  videoLogger.debug(`Keep segments: ${keepSegments.length}`);
  videoLogger.debug(`Cut segments: ${cutSegments.length}`);
  videoLogger.debug(`Insert stock actions: ${insertStockActions.length}`);
  videoLogger.debug(`Text overlay actions: ${textOverlayActions.length}`);
  videoLogger.debug(`Caption actions: ${captionActions.length}`);

  // Download stock media for B-roll overlays (separating stock and AI-generated)
  const downloadedStockMedia: DownloadedStock[] = [];
  const downloadedAiMedia: DownloadedStock[] = [];
  
  // First: Always process AI-generated images if present (independent of addBroll option)
  const aiGeneratedItems = stockMedia.filter(item => item.type === "ai_generated");
  if (aiGeneratedItems.length > 0) {
    videoLogger.info(`Processing ${aiGeneratedItems.length} AI-generated images...`);
    
    for (let i = 0; i < aiGeneratedItems.length; i++) {
      const item = aiGeneratedItems[i];
      try {
        // AI-generated images are already saved locally, use path directly
        const localPath = item.url; // URL is the local file path for AI images
        videoLogger.debug(`Using AI-generated image ${i}: ${item.query}`);
        
        // Verify file exists
        try {
          await fs.access(localPath);
          downloadedAiMedia.push({ 
            item: { ...item, type: "image" as const }, // Treat as image for overlay
            localPath 
          });
          videoLogger.debug(`AI image ready: ${localPath}`);
        } catch {
          videoLogger.error(`AI image file not found: ${localPath}`);
        }
      } catch (e) {
        videoLogger.error(`Failed to process AI image ${i}:`, e);
      }
    }
    
    videoLogger.info(`AI media processed: ${downloadedAiMedia.length}`);
  }
  
  // Second: Process stock media only if addBroll is enabled
  const stockItems = stockMedia.filter(item => item.type !== "ai_generated");
  if (options.addBroll && stockItems.length > 0) {
    videoLogger.info(`Processing ${Math.min(stockItems.length, 8)} stock media items for overlays...`);
    
    for (let i = 0; i < Math.min(stockItems.length, 8); i++) {
      const item = stockItems[i];
      try {
        let localPath: string;
        
        if (item.type === "video") {
          localPath = path.join(STOCK_DIR, `${outputId}_stock_${i}.mp4`);
          videoLogger.debug(`Downloading stock video ${i}: ${item.query}`);
          await downloadFile(item.url, localPath);
          downloadedStockMedia.push({ item, localPath });
          tempFiles.push(localPath);
          videoLogger.debug(`Downloaded: ${localPath}`);
        } else {
          const ext = item.url.includes(".png") ? "png" : "jpg";
          localPath = path.join(STOCK_DIR, `${outputId}_stock_${i}.${ext}`);
          videoLogger.debug(`Downloading stock image ${i}: ${item.query}`);
          await downloadFile(item.url, localPath);
          downloadedStockMedia.push({ item, localPath });
          tempFiles.push(localPath);
          videoLogger.debug(`Downloaded: ${localPath}`);
        }
      } catch (e) {
        videoLogger.error(`Failed to process stock media ${i}:`, e);
      }
    }
    
    videoLogger.info(`Stock media downloaded: ${downloadedStockMedia.length}`);
  }
  
  videoLogger.info(`Total media ready: Stock=${downloadedStockMedia.length}, AI=${downloadedAiMedia.length}`);

  // STEP 1: Build base video from keep segments (or cuts)
  // This handles silence removal by cutting out specified segments
  // Audio and video remain continuous in kept portions
  
  let baseVideoPath: string;
  let outputTimeMapping: { sourceStart: number; sourceEnd: number; outputStart: number }[] = [];
  
  // Determine what to keep
  let segmentsToKeep: { start: number; end: number }[] = [];
  
  if (keepSegments.length > 0) {
    // Use explicit keep segments
    segmentsToKeep = keepSegments.map(s => ({
      start: s.start || 0,
      end: s.end || metadata.duration
    }));
  } else if (cutSegments.length > 0 && options.removeSilence) {
    // Derive keeps from cuts
    const cuts = cutSegments.map(c => ({
      start: c.start || 0,
      end: c.end || 0
    })).filter(c => c.end > c.start);
    
    let currentTime = 0;
    for (const cut of cuts) {
      if (cut.start > currentTime) {
        segmentsToKeep.push({ start: currentTime, end: cut.start });
      }
      currentTime = cut.end;
    }
    if (currentTime < metadata.duration) {
      segmentsToKeep.push({ start: currentTime, end: metadata.duration });
    }
  } else {
    // Keep entire video
    segmentsToKeep = [{ start: 0, end: metadata.duration }];
  }

  videoLogger.debug(`Segments to keep: ${segmentsToKeep.length}`);
  segmentsToKeep.forEach((s, i) => videoLogger.debug(`  [${i}] ${s.start.toFixed(2)}s - ${s.end.toFixed(2)}s`));

  // SAFETY CHECK: Prevent discarding too much of the video
  // If keep segments cover less than 20% of original duration, something is wrong
  const totalKeepDuration = segmentsToKeep.reduce((sum, s) => sum + (s.end - s.start), 0);
  const keepPercentage = (totalKeepDuration / metadata.duration) * 100;
  
  if (keepPercentage < 20) {
    videoLogger.warn(`SAFETY: Keep segments only cover ${keepPercentage.toFixed(1)}% of video - keeping entire video instead`);
    segmentsToKeep = [{ start: 0, end: metadata.duration }];
  }

  // Create base video from kept segments
  if (segmentsToKeep.length === 1 && segmentsToKeep[0].start === 0 && 
      Math.abs(segmentsToKeep[0].end - metadata.duration) < 0.1) {
    // Keep entire video as-is
    baseVideoPath = videoPath;
    outputTimeMapping = [{ sourceStart: 0, sourceEnd: metadata.duration, outputStart: 0 }];
    videoLogger.info("Using original video as base (no cuts)");
  } else if (segmentsToKeep.length === 1) {
    // Single segment, just trim
    baseVideoPath = path.join(OUTPUT_DIR, `base_${outputId}.mp4`);
    const seg = segmentsToKeep[0];
    
    const trimCmd = ffmpeg(videoPath)
      .setStartTime(seg.start)
      .setDuration(seg.end - seg.start)
      .outputOptions([
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "96k",
        "-max_muxing_queue_size", "1024",
        "-threads", "2",
      ])
      .output(baseVideoPath);
    
    await runFfmpegWithTimeout(trimCmd, FFMPEG_LONG_TIMEOUT_MS, [baseVideoPath]);
    
    tempFiles.push(baseVideoPath);
    outputTimeMapping = [{ sourceStart: seg.start, sourceEnd: seg.end, outputStart: 0 }];
    videoLogger.info(`Created trimmed base video: ${seg.start}s - ${seg.end}s`);
  } else {
    // Multiple segments - concatenate
    const segmentPaths: string[] = [];
    let outputTime = 0;
    
    for (let i = 0; i < segmentsToKeep.length; i++) {
      const seg = segmentsToKeep[i];
      const segPath = path.join(OUTPUT_DIR, `seg_${outputId}_${i}.mp4`);
      
      await createVideoSegment(videoPath, segPath, seg.start, seg.end - seg.start);
      segmentPaths.push(segPath);
      tempFiles.push(segPath);
      
      outputTimeMapping.push({
        sourceStart: seg.start,
        sourceEnd: seg.end,
        outputStart: outputTime
      });
      outputTime += seg.end - seg.start;
    }
    
    baseVideoPath = path.join(OUTPUT_DIR, `base_${outputId}.mp4`);
    
    if (options.addTransitions && segmentPaths.length > 1) {
      videoLogger.info(`Applying crossfade transitions between ${segmentPaths.length} segments...`);
      await concatSegmentsWithTransitions(segmentPaths, baseVideoPath, 0.5, tempFiles);
    } else {
      await concatSegmentsSimple(segmentPaths, baseVideoPath);
    }
    
    tempFiles.push(baseVideoPath);
    videoLogger.info(`Created concatenated base video from ${segmentsToKeep.length} segments${options.addTransitions ? ' with transitions' : ''}`);
  }

  // Get base video duration
  const baseMetadata = await getVideoMetadata(baseVideoPath);
  videoLogger.info(`Base video duration: ${baseMetadata.duration.toFixed(2)}s`);

  // STEP 2: Prepare B-roll overlays
  // Map insert_stock times from source to output timeline
  // Then distribute stock media evenly if no explicit timing
  
  const brollOverlays: BrollOverlay[] = [];
  let stockIdx = 0;
  let aiIdx = 0;
  
  // Track stats for result reporting
  let aiImagesApplied = 0;
  let aiImagesSkipped = 0;
  let stockMediaApplied = 0;
  
  // Keep media queues separate - no cross-type substitution for integrity
  const allDownloadedMedia = [...downloadedStockMedia, ...downloadedAiMedia];
  
  // Process overlays if B-roll is enabled OR if there are AI-generated images
  const shouldProcessOverlays = (options.addBroll || downloadedAiMedia.length > 0) && allDownloadedMedia.length > 0;
  
  if (shouldProcessOverlays) {
    // FIRST: Process AI-generated images with their embedded timing (deterministic)
    // AI images have startTime/endTime from semantic analysis - use directly
    
    // Configuration for improved timing validation
    const TIMING_TOLERANCE_MS = 500; // Allow 0.5s tolerance for edge cases
    const DEFAULT_AI_IMAGE_DURATION = 2.5; // Default duration if not specified
    const MAX_PLACEMENT_DISTANCE = 2.0; // Max distance to nearest segment (seconds)
    
    for (const aiMedia of downloadedAiMedia) {
      const sourceTime = aiMedia.item.startTime;
      const itemDuration = aiMedia.item.duration;
      const itemQuery = aiMedia.item.query || "unknown";
      
      // Relaxed validation: Allow missing startTime
      if (typeof sourceTime !== "number" || sourceTime < 0) {
        videoLogger.warn(`[AI Image SKIP] Missing/invalid startTime (${sourceTime}): ${itemQuery}`);
        aiImagesSkipped++;
        continue;
      }
      
      // Use provided duration or default if invalid
      let finalDuration = DEFAULT_AI_IMAGE_DURATION;
      if (typeof itemDuration === "number" && itemDuration > 0) {
        finalDuration = Math.min(itemDuration, 5);
      } else if (itemDuration !== undefined && itemDuration !== null) {
        videoLogger.debug(`[AI Image] Using default duration ${finalDuration}s (provided value was invalid: ${itemDuration}): ${itemQuery.substring(0, 50)}`);
      }
      
      // Find output time for this source time - with multi-stage fallback strategy
      let outputTime: number | null = null;
      let mappingStrategy = "unmapped";
      
      // STAGE 1: Try exact match
      for (const mapping of outputTimeMapping) {
        if (sourceTime >= mapping.sourceStart && sourceTime < mapping.sourceEnd) {
          outputTime = mapping.outputStart + (sourceTime - mapping.sourceStart);
          mappingStrategy = "exact";
          break;
        }
      }
      
      // STAGE 2: If not found, try with tolerance - image might be at cut boundary
      if (outputTime === null) {
        const toleranceSeconds = TIMING_TOLERANCE_MS / 1000;
        for (const mapping of outputTimeMapping) {
          // Check if source time is within tolerance of this segment
          if (sourceTime >= mapping.sourceStart - toleranceSeconds && 
              sourceTime <= mapping.sourceEnd + toleranceSeconds) {
            // Clamp source time to segment bounds
            const clampedSourceTime = Math.max(
              mapping.sourceStart,
              Math.min(sourceTime, mapping.sourceEnd - 0.1) // Leave 0.1s buffer
            );
            outputTime = mapping.outputStart + (clampedSourceTime - mapping.sourceStart);
            mappingStrategy = `tolerance (clamped ${sourceTime.toFixed(3)}→${clampedSourceTime.toFixed(3)})`;
            break;
          }
        }
      }
      
      // STAGE 3: If still not found, place at nearest segment boundary
      if (outputTime === null && outputTimeMapping.length > 0) {
        // Find nearest segment
        let nearestMapping = outputTimeMapping[0];
        let nearestDistance = Math.abs(sourceTime - outputTimeMapping[0].sourceStart);
        
        for (const mapping of outputTimeMapping) {
          const distToStart = Math.abs(sourceTime - mapping.sourceStart);
          const distToEnd = Math.abs(sourceTime - mapping.sourceEnd);
          const minDist = Math.min(distToStart, distToEnd);
          
          if (minDist < nearestDistance) {
            nearestDistance = minDist;
            nearestMapping = mapping;
          }
        }
        
        // Only place at nearest if within reasonable distance
        if (nearestDistance <= MAX_PLACEMENT_DISTANCE) {
          // Place at start of nearest segment
          outputTime = nearestMapping.outputStart;
          mappingStrategy = `nearest (${nearestDistance.toFixed(2)}s away→segment start)`;
        }
      }
      
      if (outputTime !== null && outputTime >= 0) {
        // Check if overlay extends beyond video - clamp duration instead of skipping
        let finalOutputTime = outputTime;
        let finalOutputDuration = finalDuration;
        
        if (outputTime + finalDuration > baseMetadata.duration) {
          const overflow = (outputTime + finalDuration) - baseMetadata.duration;
          const prevDuration = finalOutputDuration;
          finalOutputDuration = Math.max(0.5, finalDuration - overflow); // Keep at least 0.5s
          videoLogger.debug(`[AI Image] Clamped duration from ${prevDuration.toFixed(2)}s to ${finalOutputDuration.toFixed(2)}s to fit before video end (${baseMetadata.duration.toFixed(2)}s): ${itemQuery.substring(0, 50)}`);
        }
        
        // Safety check: ensure output time is within bounds
        if (finalOutputTime >= 0 && finalOutputTime < baseMetadata.duration && finalOutputDuration > 0) {
          brollOverlays.push({
            localPath: aiMedia.localPath,
            type: aiMedia.item.type as "video" | "image" | "ai_generated",
            startTime: finalOutputTime,
            duration: finalOutputDuration,
          });
          
          aiImagesApplied++;
          videoLogger.info(`[AI Image OK] Applied at output=${finalOutputTime.toFixed(2)}s (src=${sourceTime.toFixed(2)}s) for ${finalOutputDuration.toFixed(2)}s via ${mappingStrategy}: ${itemQuery.substring(0, 50)}`);
        } else {
          aiImagesSkipped++;
          videoLogger.warn(`[AI Image SKIP] Final validation failed: outputTime=${finalOutputTime.toFixed(2)}s, duration=${finalOutputDuration.toFixed(2)}s (max=${baseMetadata.duration.toFixed(2)}s): ${itemQuery.substring(0, 50)}`);
        }
      } else {
        aiImagesSkipped++;
        const mappingDetails = outputTimeMapping.map(m => 
          `[${m.sourceStart.toFixed(2)}-${m.sourceEnd.toFixed(2)}s]`
        ).join(", ");
        videoLogger.warn(`[AI Image SKIP] Could not map to output timeline (source=${sourceTime.toFixed(2)}s, nearest segment >=${MAX_PLACEMENT_DISTANCE}s away). Available segments: ${mappingDetails || "none"}: ${itemQuery.substring(0, 50)}`);
      }
    }
    
    // Log AI image placement summary with metrics
    const totalAiImages = downloadedAiMedia.length;
    const placementRate = totalAiImages > 0 ? ((aiImagesApplied / totalAiImages) * 100).toFixed(1) : "0";
    videoLogger.info(`AI Image Summary: ${aiImagesApplied}/${totalAiImages} applied (${placementRate}% placement rate), ${aiImagesSkipped} skipped`);
    if (aiImagesApplied === totalAiImages && totalAiImages > 0) {
      videoLogger.info(`SUCCESS: All ${aiImagesApplied} AI images were successfully placed!`);
    } else if (aiImagesSkipped > 0) {
      videoLogger.warn(`Note: ${aiImagesSkipped} AI image(s) could not be placed due to timing constraints`);
    }
    
    // SECOND: Process stock media based on insert_stock actions from edit plan
    for (const action of insertStockActions) {
      if (stockIdx >= downloadedStockMedia.length) break;
      
      const sourceTime = action.start || 0;
      const mediaItem = downloadedStockMedia[stockIdx];
      
      // Find output time for this source time
      let outputTime: number | null = null;
      for (const mapping of outputTimeMapping) {
        if (sourceTime >= mapping.sourceStart && sourceTime < mapping.sourceEnd) {
          outputTime = mapping.outputStart + (sourceTime - mapping.sourceStart);
          break;
        }
      }
      
      if (outputTime !== null) {
        // Check if this time overlaps with any AI image (using actual durations)
        const stockDuration = action.duration || 4;
        const overlapsAi = brollOverlays.some(o => 
          intervalsOverlap(outputTime, outputTime + stockDuration, o.startTime, o.startTime + o.duration)
        );
        
        if (!overlapsAi) {
          const duration = Math.min(
            action.duration || (action.end && action.start ? action.end - action.start : 4),
            mediaItem.item.duration || 5,
            5
          );
          
          brollOverlays.push({
            localPath: mediaItem.localPath,
            type: mediaItem.item.type as "video" | "image" | "ai_generated",
            startTime: outputTime,
            duration,
            text: action.text,
          });
          stockIdx++;
          stockMediaApplied++;
        } else {
          videoLogger.debug(`Skipping stock at ${outputTime.toFixed(2)}s - overlaps with AI image`);
        }
      }
    }
    
    // Distribute remaining stock media evenly across the video
    const remainingStock = downloadedStockMedia.slice(stockIdx);
    if (remainingStock.length > 0) {
      const interval = baseMetadata.duration / (remainingStock.length + 1);
      
      for (let i = 0; i < remainingStock.length; i++) {
        const startTime = interval * (i + 1);
        const duration = Math.min(remainingStock[i].item.duration || 5, 3);
        
        // Avoid overlapping with existing overlays
        const overlapsExisting = brollOverlays.some(o => 
          intervalsOverlap(startTime, startTime + duration, o.startTime, o.startTime + o.duration)
        );
        
        if (!overlapsExisting) {
          brollOverlays.push({
            localPath: remainingStock[i].localPath,
            type: remainingStock[i].item.type as "video" | "image" | "ai_generated",
            startTime,
            duration,
          });
        }
      }
    }
    
    // Sort overlays by start time
    brollOverlays.sort((a, b) => a.startTime - b.startTime);
    
    videoLogger.debug(`Prepared ${brollOverlays.length} B-roll overlays:`);
    brollOverlays.forEach((o, i) => videoLogger.debug(`  [${i}] ${o.type} at ${o.startTime.toFixed(2)}s for ${o.duration.toFixed(2)}s`));
  }

  // STEP 3: Apply B-roll overlays (visual only, audio continues)
  let overlayedPath: string;
  
  if (brollOverlays.length > 0) {
    overlayedPath = path.join(OUTPUT_DIR, `overlayed_${outputId}.mp4`);
    
    try {
      const quality = options.renderQuality || "balanced";
      await applyAllBrollOverlays(
        baseVideoPath,
        brollOverlays,
        overlayedPath,
        metadata.width,
        metadata.height,
        tempFiles,
        quality
      );
      tempFiles.push(overlayedPath);
      videoLogger.info(`Applied ${brollOverlays.length} B-roll overlays successfully (quality: ${quality})`);
    } catch (err) {
      videoLogger.error("Failed to apply overlays, using base video:", err);
      overlayedPath = baseVideoPath;
    }
  } else {
    overlayedPath = baseVideoPath;
  }

  // STEP 4: Build and apply captions with word-level timing for karaoke effect
  const adjustedCaptions: CaptionWithWords[] = [];
  
  if (options.addCaptions) {
    // Include word-level timing from transcript segments
    const allCaptions: CaptionWithWords[] = [
      ...transcript.map(t => ({
        start: t.start,
        end: t.end,
        text: t.text,
        words: t.words,
      })),
      ...captionActions.map(a => ({
        start: a.start || 0,
        end: a.end || (a.start || 0) + 3,
        text: a.text || "",
        words: undefined,
      }))
    ];
    
    for (const cap of allCaptions) {
      // Map source time to output time
      for (const mapping of outputTimeMapping) {
        if (cap.end <= mapping.sourceStart || cap.start >= mapping.sourceEnd) continue;
        
        const overlapStart = Math.max(cap.start, mapping.sourceStart);
        const overlapEnd = Math.min(cap.end, mapping.sourceEnd);
        
        const adjustedStart = mapping.outputStart + (overlapStart - mapping.sourceStart);
        const adjustedEnd = mapping.outputStart + (overlapEnd - mapping.sourceStart);
        
        // Adjust word timings as well - use overlap window for correct mapping
        let adjustedWords: WordTiming[] | undefined;
        if (cap.words && cap.words.length > 0) {
          adjustedWords = cap.words
            // Only include words that fall within the overlap window
            .filter(w => w.start >= overlapStart && w.end <= overlapEnd)
            .map(w => ({
              word: w.word,
              // Map from source time (relative to mapping.sourceStart) to output time
              start: mapping.outputStart + (w.start - mapping.sourceStart),
              end: mapping.outputStart + (w.end - mapping.sourceStart),
            }))
            // Ensure adjusted times are within the adjusted caption bounds
            .filter(w => w.start >= adjustedStart && w.end <= adjustedEnd);
        }
        
        adjustedCaptions.push({
          start: adjustedStart,
          end: adjustedEnd,
          text: cap.text,
          words: adjustedWords,
        });
      }
    }
    
    videoLogger.info(`Mapped ${adjustedCaptions.length} captions to output timeline`);
  }

  // Apply captions if any - use ASS format for karaoke-style highlighting
  let preFinalVideoPath: string;
  
  if (adjustedCaptions.length > 0) {
    videoLogger.info(`Burning ${adjustedCaptions.length} karaoke-style captions into final video`);
    
    // Get video dimensions for proper ASS rendering
    const videoMeta = await getVideoMetadata(overlayedPath);
    
    // Generate ASS file with karaoke timing
    const assPath = path.join(OUTPUT_DIR, `${outputId}.ass`);
    const assContent = generateAssContent(adjustedCaptions, videoMeta.width, videoMeta.height);
    await fs.writeFile(assPath, assContent);
    tempFiles.push(assPath);
    
    // Write to temp path first, then embed chapters
    preFinalVideoPath = path.join(OUTPUT_DIR, `prefinal_${outputId}.mp4`);
    await burnSubtitles(overlayedPath, preFinalVideoPath, assPath);
    tempFiles.push(preFinalVideoPath);
  } else {
    preFinalVideoPath = overlayedPath;
  }

  // STEP 5: Generate and embed chapter metadata
  const finalVideoMetadata = await getVideoMetadata(preFinalVideoPath);
  const chapters = generateChaptersFromEditPlan({
    editPlan,
    semanticAnalysis,
    videoDuration: finalVideoMetadata.duration,
    outputTimeMapping,
  });
  
  if (chapters.length > 0) {
    videoLogger.info(`[Chapters] Embedding ${chapters.length} chapters into final video`);
    await embedChapterMetadata(preFinalVideoPath, outputPath, chapters, tempFiles);
  } else {
    if (preFinalVideoPath !== outputPath) {
      await fs.copyFile(preFinalVideoPath, outputPath);
    }
  }

  // Cleanup temp files
  for (const tempPath of tempFiles) {
    if (tempPath !== outputPath) {
      await fs.unlink(tempPath).catch(() => {});
    }
  }

  videoLogger.info("=== APPLY EDITS COMPLETE (OVERLAY MODE) ===");
  videoLogger.info(`Final Stats: aiImagesApplied=${aiImagesApplied}, aiImagesSkipped=${aiImagesSkipped}, stockMediaApplied=${stockMediaApplied}, brollOverlays=${brollOverlays.length}`);
  
  return {
    outputPath,
    aiImagesApplied,
    aiImagesSkipped,
    stockMediaApplied,
    brollOverlaysTotal: brollOverlays.length,
  };
}

export async function cleanupTempFiles(paths: string[]): Promise<void> {
  for (const filePath of paths) {
    try {
      const stat = await fs.stat(filePath);
      if (stat.isDirectory()) {
        await fs.rm(filePath, { recursive: true });
      } else {
        await fs.unlink(filePath);
      }
    } catch (e) {
    }
  }
}

export { UPLOADS_DIR, FRAMES_DIR, OUTPUT_DIR, AUDIO_DIR, STOCK_DIR, CHAPTERS_DIR, ensureDirs };
