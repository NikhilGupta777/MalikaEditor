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
  
  // Minimum chapter duration: scale based on video length
  // Short videos (<60s): 5s minimum, Long videos (>300s): 15s minimum
  const minChapterDuration = Math.max(5, Math.min(15, videoDuration / 20));
  const maxChapters = Math.max(3, Math.floor(videoDuration / minChapterDuration));
  
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
  
  // Check if timestamp is too close to existing chapters
  const isTooClose = (time: number): boolean => {
    return chapters.some(ch => Math.abs(ch.startTime - time) < minChapterDuration);
  };
  
  const addChapter = (title: string, sourceTime: number, type: ChapterInfo["type"], priority: number = 0) => {
    const outputTime = mapSourceToOutputTime(sourceTime);
    if (outputTime === null || outputTime < 0 || outputTime >= videoDuration - 2) {
      return;
    }
    
    const roundedTime = Math.round(outputTime * 10) / 10;
    
    // Skip if too close to existing chapter
    if (isTooClose(roundedTime)) {
      return;
    }
    
    chapters.push({
      title: title.slice(0, 80),
      startTime: roundedTime,
      endTime: videoDuration,
      type,
    });
  };
  
  // Priority 1: Structure-based chapters (intro, main, outro)
  if (semanticAnalysis?.structureAnalysis) {
    const structure = semanticAnalysis.structureAnalysis;
    
    if (structure.introEnd !== undefined && structure.introEnd > 0) {
      addChapter("Introduction", 0, "intro", 3);
    }
    
    if (structure.outroStart !== undefined && structure.outroStart > minChapterDuration) {
      addChapter("Conclusion", structure.outroStart, "outro", 3);
    }
  }
  
  // Priority 2: High importance key moments only (limit to avoid too many)
  if (semanticAnalysis?.keyMoments && semanticAnalysis.keyMoments.length > 0) {
    const highPriority = semanticAnalysis.keyMoments
      .filter(m => m.importance === "high")
      .slice(0, Math.max(2, maxChapters - 2));
    
    for (const moment of highPriority) {
      const title = moment.description || "Key Point";
      addChapter(title, moment.timestamp, "keypoint", 2);
    }
  }
  
  // Priority 3: Topic flow (only if we have room and topics are distinct)
  if (chapters.length < maxChapters && semanticAnalysis?.topicFlow && semanticAnalysis.topicFlow.length > 0) {
    const remainingSlots = maxChapters - chapters.length;
    const topics = semanticAnalysis.topicFlow
      .filter(t => t.name && t.start >= minChapterDuration)
      .slice(0, remainingSlots);
    
    for (const topic of topics) {
      addChapter(topic.name, topic.start, "section", 1);
    }
  }
  
  chapters.sort((a, b) => a.startTime - b.startTime);
  
  // Calculate end times
  for (let i = 0; i < chapters.length - 1; i++) {
    chapters[i].endTime = chapters[i + 1].startTime;
  }
  
  if (chapters.length > 0) {
    chapters[chapters.length - 1].endTime = videoDuration;
  }
  
  // Default chapter if none generated
  if (chapters.length === 0 && videoDuration > 10) {
    chapters.push({
      title: "Video",
      startTime: 0,
      endTime: videoDuration,
      type: "section",
    });
  }
  
  // Final filter: remove any remaining short chapters
  const validChapters = chapters.filter(ch => {
    const duration = ch.endTime - ch.startTime;
    return duration >= minChapterDuration * 0.5; // Allow slightly shorter than min
  });
  
  // Recalculate end times after filtering
  for (let i = 0; i < validChapters.length - 1; i++) {
    validChapters[i].endTime = validChapters[i + 1].startTime;
  }
  if (validChapters.length > 0) {
    validChapters[validChapters.length - 1].endTime = videoDuration;
  }
  
  videoLogger.info(`[Chapters] Generated ${validChapters.length} chapters for ${videoDuration.toFixed(1)}s video (min duration: ${minChapterDuration.toFixed(1)}s)`);
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
          } catch {
            // Process may have already exited - ignore
          }
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
      fs.unlink(p).catch(() => {
        // File may already be deleted - ignore
      });
    } catch {
      // Sync error accessing path - ignore
    }
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

  // Ensure duration is always a number and not NaN
  const safeDuration = typeof duration === 'number' && !isNaN(duration) ? duration : 0;

  return {
    duration: safeDuration,
    width: videoStream?.width || 1920,
    height: videoStream?.height || 1080,
    fps: fps || 30,
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
          } catch {
            // Process may have already exited - ignore
          }
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

  // CRITICAL FIX: Process words per caption to respect caption boundaries
  // This prevents phrases from crossing caption/segment boundaries after edits
  
  // First, collect words per caption with proper clamping
  interface CaptionWords {
    captionStart: number;
    captionEnd: number;
    words: WordTiming[];
  }
  
  const captionWordGroups: CaptionWords[] = [];
  
  for (const cap of captions) {
    let captionWords: WordTiming[] = [];
    
    if (cap.words && cap.words.length > 0) {
      // Clamp word timings to caption bounds
      captionWords = cap.words
        .map(w => ({
          word: w.word,
          start: Math.max(w.start, cap.start),
          end: Math.min(w.end, cap.end),
        }))
        .filter(w => w.end > w.start); // Remove invalid after clamping
    } else {
      // Synthesize word-level timing from text if not available
      const words = cap.text.split(/\s+/).filter(w => w.trim());
      if (words.length > 0) {
        const segDuration = cap.end - cap.start;
        const wordDuration = segDuration / words.length;
        
        for (let i = 0; i < words.length; i++) {
          captionWords.push({
            word: words[i],
            start: cap.start + (i * wordDuration),
            end: cap.start + ((i + 1) * wordDuration),
          });
        }
      }
    }
    
    if (captionWords.length > 0) {
      // Sort by start time within caption
      captionWords.sort((a, b) => a.start - b.start);
      captionWordGroups.push({
        captionStart: cap.start,
        captionEnd: cap.end,
        words: captionWords,
      });
    }
  }
  
  if (captionWordGroups.length === 0) {
    return header;
  }
  
  // Sort caption groups by start time
  captionWordGroups.sort((a, b) => a.captionStart - b.captionStart);
  
  // Group words into phrases of 2-3 words WITHIN each caption
  // This ensures phrases never cross caption boundaries
  const WORDS_PER_PHRASE = 3;
  const GAP_THRESHOLD = 0.5; // seconds
  
  const phrases: WordTiming[][] = [];
  
  for (const group of captionWordGroups) {
    let currentPhrase: WordTiming[] = [];
    
    for (let i = 0; i < group.words.length; i++) {
      const word = group.words[i];
      const prevWord = i > 0 ? group.words[i - 1] : null;
      
      // Check if we should start a new phrase
      const gapToPrevious = prevWord ? word.start - prevWord.end : 0;
      const shouldBreak = gapToPrevious > GAP_THRESHOLD || currentPhrase.length >= WORDS_PER_PHRASE;
      
      if (shouldBreak && currentPhrase.length > 0) {
        phrases.push(currentPhrase);
        currentPhrase = [];
      }
      
      currentPhrase.push(word);
    }
    
    // End of caption group - push remaining phrase
    if (currentPhrase.length > 0) {
      phrases.push(currentPhrase);
    }
  }
  
  if (phrases.length === 0) {
    return header;
  }
  
  // Sort phrases by start time (should already be sorted due to per-caption processing)
  phrases.sort((a, b) => (a[0]?.start || 0) - (b[0]?.start || 0));
  
  // Remove any phrases that would create overlap
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

// Animation preset types for image B-roll
export type AnimationPreset = "zoom_in" | "zoom_out" | "pan_left" | "pan_right" | "fade_only";

async function createImageBroll(
  imagePath: string,
  outputPath: string,
  duration: number,
  width: number,
  height: number,
  textOverlay?: string,
  animationPreset: AnimationPreset = "zoom_in"
): Promise<void> {
  // Use the animation preset system for consistent zoompan effects
  const fps = 30;
  const totalFrames = Math.ceil(duration * fps);
  
  // Build zoompan filter based on preset using sine easing for smooth motion
  let zoompanFilter: string;
  switch (animationPreset) {
    case "zoom_in":
      zoompanFilter = `zoompan=z='1+0.1*sin(on/${totalFrames}*PI/2)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${width}x${height}:fps=${fps}`;
      break;
    case "zoom_out":
      zoompanFilter = `zoompan=z='1.15-0.1*sin(on/${totalFrames}*PI/2)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${width}x${height}:fps=${fps}`;
      break;
    case "pan_left":
      zoompanFilter = `zoompan=z='1.1':x='(iw-ow)*(1-sin(on/${totalFrames}*PI/2))':y='(ih-oh)/2':d=${totalFrames}:s=${width}x${height}:fps=${fps}`;
      break;
    case "pan_right":
      zoompanFilter = `zoompan=z='1.1':x='(iw-ow)*sin(on/${totalFrames}*PI/2)':y='(ih-oh)/2':d=${totalFrames}:s=${width}x${height}:fps=${fps}`;
      break;
    case "fade_only":
    default:
      zoompanFilter = `zoompan=z='1.05':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${width}x${height}:fps=${fps}`;
      break;
  }
  
  const filters: string[] = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    zoompanFilter
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

interface TransitionResult {
  effectiveDurations: number[]; // Actual transition duration applied at each boundary
  totalReduction: number; // Sum of all effective durations (total time reduced)
}

async function concatSegmentsWithTransitions(
  segmentPaths: string[],
  outputPath: string,
  transitionDuration: number = 0.5,
  tempFiles: string[]
): Promise<TransitionResult> {
  const effectiveDurations: number[] = [];
  
  if (segmentPaths.length === 0) {
    throw new Error("No segments to concatenate");
  }
  
  if (segmentPaths.length === 1) {
    await fs.copyFile(segmentPaths[0], outputPath);
    return { effectiveDurations: [], totalReduction: 0 };
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
      const actualDuration = await concatTwoWithTransition(
        currentPath,
        nextSegment,
        intermediatePath,
        "fade",
        transitionDuration
      );
      
      effectiveDurations.push(actualDuration);
      videoLogger.debug(`Applied crossfade transition between segment ${i-1} and ${i} (effective: ${actualDuration.toFixed(2)}s)`);
      
      if (!isLastPair) {
        tempFiles.push(intermediatePath);
        currentPath = intermediatePath;
      }
    } catch (err) {
      videoLogger.error(`Failed to apply transition between segments ${i-1} and ${i}:`, err);
      throw err;
    }
  }
  
  const totalReduction = effectiveDurations.reduce((sum, d) => sum + d, 0);
  videoLogger.info(`Successfully concatenated ${segmentPaths.length} segments with transitions (total reduction: ${totalReduction.toFixed(2)}s)`);
  
  return { effectiveDurations, totalReduction };
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
  
  const [seg1Duration, seg2Duration] = await Promise.all([
    getFileDuration(segment1Path),
    getFileDuration(segment2Path)
  ]);
  
  // Safety: Dynamically reduce transition duration if segments are too short
  // Both segments need to be at least as long as the transition for xfade to work
  const minDuration = Math.min(seg1Duration, seg2Duration);
  let effectiveTransitionDuration = transitionDuration;
  
  // CRITICAL: If minimum segment is below safe threshold, skip xfade entirely
  const MIN_SAFE_DURATION = 0.3; // Minimum segment duration for any transition
  if (minDuration < MIN_SAFE_DURATION) {
    videoLogger.warn(`[Crossfade] Segment too short (${minDuration.toFixed(2)}s < ${MIN_SAFE_DURATION}s) - falling back to simple concat (no transition)`);
    // Simple concatenation fallback
    const concatListPath = path.join(OUTPUT_DIR, `concat_fallback_${Date.now()}.txt`);
    const concatContent = `file '${segment1Path}'\nfile '${segment2Path}'`;
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
          "-b:a", "128k",
          "-threads", "2",
        ])
        .output(outputPath);
      
      await runFfmpegWithTimeout(cmd, FFMPEG_LONG_TIMEOUT_MS, [outputPath]);
      return 0; // No transition applied - caller should treat as simple concat
    } finally {
      // Always clean up the temp concat list file
      await fs.unlink(concatListPath).catch(() => {});
    }
  }
  
  if (minDuration < transitionDuration) {
    // Reduce transition to fit within the shortest segment (with safety margin)
    effectiveTransitionDuration = Math.max(0.1, minDuration * 0.5);
    videoLogger.warn(`[Crossfade] Reducing transition from ${transitionDuration}s to ${effectiveTransitionDuration.toFixed(2)}s (shortest segment: ${minDuration.toFixed(2)}s)`);
  }
  
  // Offset is where the transition STARTS in the first video
  // It should be near the END of seg1, not limited by seg2's duration
  // The xfade filter overlays seg2 on top of seg1 starting at offset
  const offset = Math.max(0, seg1Duration - effectiveTransitionDuration);
  
  videoLogger.debug(`[Crossfade] seg1=${seg1Duration.toFixed(2)}s, seg2=${seg2Duration.toFixed(2)}s, transition=${effectiveTransitionDuration.toFixed(2)}s, offset=${offset.toFixed(2)}s`);
  
  const [hasAudio1, hasAudio2] = await Promise.all([
    hasAudioStream(segment1Path),
    hasAudioStream(segment2Path)
  ]);

  const complexFilterArray: string[] = [
    `[0:v][1:v]xfade=transition=${transition}:duration=${effectiveTransitionDuration}:offset=${offset}[v]`
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
    complexFilterArray.push(
      `[0:a][1:a]acrossfade=d=${effectiveTransitionDuration}:c1=tri:c2=tri[a]`
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
  
  return effectiveTransitionDuration;
}

// Overlay info for B-roll on main video
interface BrollOverlay {
  localPath: string;
  type: "image" | "video" | "ai_generated";
  startTime: number; // When to show overlay (in output timeline)
  duration: number;
  text?: string;
  animationPreset?: AnimationPreset; // Animation style for images, defaults to zoom_in
}

// Generate zoompan filter expression based on animation preset
// Uses sine easing for smoother motion and 30fps for better quality
function getZoompanFilter(
  preset: AnimationPreset,
  duration: number,
  width: number,
  height: number
): string {
  const fps = 30;
  const totalFrames = Math.ceil(duration * fps);
  
  // Sine easing function: sin(on/d * PI/2) gives smooth 0->1 curve
  // For reverse: 1 - sin(on/d * PI/2) gives smooth 1->0 curve
  
  switch (preset) {
    case "zoom_in":
      // Start at 1.0, smoothly zoom to 1.1 using sine easing
      // z = 1 + 0.1 * sin(on/d * PI/2)
      return `zoompan=z='1+0.1*sin(on/${totalFrames}*PI/2)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${width}x${height}:fps=${fps}`;
    
    case "zoom_out":
      // Start at 1.15, smoothly zoom out to 1.05 using sine easing
      // z = 1.15 - 0.1 * sin(on/d * PI/2)
      return `zoompan=z='1.15-0.1*sin(on/${totalFrames}*PI/2)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${width}x${height}:fps=${fps}`;
    
    case "pan_left":
      // Pan from right to left with slight zoom for depth
      // x starts at (iw-ow) and moves to 0 with sine easing
      return `zoompan=z='1.1':x='(iw-ow)*(1-sin(on/${totalFrames}*PI/2))':y='(ih-oh)/2':d=${totalFrames}:s=${width}x${height}:fps=${fps}`;
    
    case "pan_right":
      // Pan from left to right with slight zoom for depth
      // x starts at 0 and moves to (iw-ow) with sine easing
      return `zoompan=z='1.1':x='(iw-ow)*sin(on/${totalFrames}*PI/2)':y='(ih-oh)/2':d=${totalFrames}:s=${width}x${height}:fps=${fps}`;
    
    case "fade_only":
    default:
      // No movement, just hold at center with slight zoom for framing
      return `zoompan=z='1.05':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${width}x${height}:fps=${fps}`;
  }
}

// Prepare stock media as overlay video (full-frame for traditional B-roll)
// The overlay fades in/out to smoothly blend with the base video
// Audio continues uninterrupted during the overlay
async function prepareOverlayMedia(
  stock: DownloadedStock,
  duration: number,
  width: number,
  height: number,
  outputPath: string,
  animationPreset: AnimationPreset = "zoom_in"
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
    // Get the zoompan filter for the selected animation preset
    const zoompanFilter = getZoompanFilter(animationPreset, duration, width, height);
    
    const cmd = ffmpeg()
      .input(stock.localPath)
      .inputOptions(["-loop", "1"])
      .outputOptions([
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "23",
        "-an",
        "-t", String(duration),
        "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,${zoompanFilter}`,
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
  const fadeDuration = 0.5; // Longer fade for smoother transitions
  const { preset, crf } = ENCODING_PRESETS[quality];
  
  videoLogger.info(`Applying ${overlays.length} overlays in single pass (quality: ${quality})`);
  
  // Step 1: Prepare all overlay video files (sequential to reduce CPU/memory pressure)
  const preparedOverlays: { path: string; startTime: number; duration: number }[] = [];
  
  for (let i = 0; i < overlays.length; i++) {
    const overlay = overlays[i];
    const overlayVideoPath = path.join(OUTPUT_DIR, `overlay_${outputId}_${i}.mp4`);
    
    try {
      // Use animation preset from overlay, defaulting to zoom_in for images
      const animPreset = overlay.animationPreset || "zoom_in";
      
      await prepareOverlayMedia(
        { item: { type: overlay.type, url: "", query: "", duration: overlay.duration }, localPath: overlay.localPath },
        overlay.duration,
        width,
        height,
        overlayVideoPath,
        animPreset
      );
      
      tempFiles.push(overlayVideoPath);
      videoLogger.debug(`Prepared overlay ${i}: at ${overlay.startTime}s for ${overlay.duration}s (animation: ${animPreset})`);
      
      preparedOverlays.push({
        path: overlayVideoPath,
        startTime: overlay.startTime,
        duration: overlay.duration,
      });

      // Small sleep to let system breathe and prevent SIGKILL
      await new Promise(resolve => setTimeout(resolve, 300));
    } catch (err) {
      videoLogger.error(`Failed to prepare overlay ${i}:`, err);
    }
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
        videoLogger.debug(`Processing AI-generated image ${i}: ${item.query}`);
        
        let localPath: string;
        
        // Check if URL is a base64 data URL and convert to local file
        if (item.url.startsWith('data:')) {
          // Extract base64 data and save to file
          const matches = item.url.match(/^data:([^;]+);base64,(.+)$/);
          if (!matches) {
            videoLogger.error(`Invalid data URL format for AI image ${i}`);
            continue;
          }
          
          const mimeType = matches[1];
          const base64Data = matches[2];
          
          // Guard against very large base64 strings that could spike memory
          const MAX_BASE64_SIZE = 50 * 1024 * 1024; // 50MB limit
          if (base64Data.length > MAX_BASE64_SIZE) {
            videoLogger.error(`AI image ${i} base64 data too large (${Math.round(base64Data.length / 1024 / 1024)}MB > 50MB), skipping`);
            continue;
          }
          
          // Validate MIME type with strict equality (only allow supported formats)
          const SUPPORTED_MIME_TYPES: Record<string, string> = {
            'image/png': 'png',
            'image/jpeg': 'jpg',
            'image/jpg': 'jpg',
            'image/webp': 'webp',
            'image/gif': 'gif',
          };
          
          // STRICT match - require exact MIME type match
          const extension = SUPPORTED_MIME_TYPES[mimeType];
          
          if (!extension) {
            videoLogger.error(`AI image ${i} has unsupported MIME type "${mimeType}", skipping (supported: ${Object.keys(SUPPORTED_MIME_TYPES).join(', ')})`);
            continue;
          }
          
          localPath = path.join(STOCK_DIR, `${outputId}_ai_${i}.${extension}`);
          
          // Decode base64 and write to file
          const buffer = Buffer.from(base64Data, 'base64');
          await fs.writeFile(localPath, buffer);
          tempFiles.push(localPath);
          videoLogger.debug(`Saved AI image from base64 to: ${localPath} (${Math.round(buffer.length / 1024)}KB, format: ${extension})`);
        } else {
          // Treat as local file path
          localPath = item.url;
          
          // Verify file exists
          try {
            await fs.access(localPath);
            videoLogger.debug(`AI image file exists: ${localPath}`);
          } catch {
            videoLogger.error(`AI image file not found: ${localPath}`);
            continue;
          }
        }
        
        downloadedAiMedia.push({ 
          item: { ...item, type: "image" as const }, // Treat as image for overlay
          localPath 
        });
        videoLogger.debug(`AI image ready: ${localPath}`);
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
  
  // CRITICAL: If removeSilence is false (user didn't approve cuts), keep the ENTIRE video
  // This takes priority over any keep/cut segments in the edit plan
  if (!options.removeSilence) {
    // Keep entire video - user did not approve any cuts
    segmentsToKeep = [{ start: 0, end: metadata.duration }];
    videoLogger.info(`[Segments] KEEPING ENTIRE VIDEO: removeSilence is disabled (no cuts approved by user)`);
    if (keepSegments.length > 0) {
      videoLogger.debug(`[Segments] Ignoring ${keepSegments.length} keep segments - entire video will be preserved`);
    }
    if (cutSegments.length > 0) {
      videoLogger.debug(`[Segments] Ignoring ${cutSegments.length} cut segments - entire video will be preserved`);
    }
  } else if (keepSegments.length > 0) {
    // Use explicit keep segments (only when removeSilence is true)
    segmentsToKeep = keepSegments.map(s => ({
      start: s.start || 0,
      end: s.end || metadata.duration
    }));
    videoLogger.info(`[Segments] Using ${keepSegments.length} explicit KEEP segments from edit plan`);
  } else if (cutSegments.length > 0) {
    // Derive keeps from cuts
    const cuts = cutSegments.map(c => ({
      start: c.start || 0,
      end: c.end || 0
    })).filter(c => c.end > c.start);
    
    videoLogger.info(`[Segments] Deriving keeps from ${cuts.length} CUT segments`);
    cuts.forEach((c, i) => videoLogger.debug(`  [CUT ${i}] ${c.start.toFixed(2)}s - ${c.end.toFixed(2)}s`));
    
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
    // Keep entire video - no cut/keep segments defined
    segmentsToKeep = [{ start: 0, end: metadata.duration }];
    videoLogger.info(`[Segments] KEEPING ENTIRE VIDEO: No cut/keep segments defined`);
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

  // CROSSFADE SAFETY: Filter out or merge segments that are too short for transitions
  // Segments need to be at least 2x the transition duration to allow crossfades on both ends
  const transitionDuration = 0.5;
  const minSegmentDuration = transitionDuration * 2; // 1 second minimum
  
  if (options.addTransitions && segmentsToKeep.length > 1) {
    const originalCount = segmentsToKeep.length;
    
    // Create a deep copy to avoid mutation issues
    let workingSegments = segmentsToKeep.map(s => ({ start: s.start, end: s.end }));
    
    // Multi-pass merge: keep merging until all segments meet minimum duration
    let changed = true;
    let passCount = 0;
    const maxPasses = 10;
    
    while (changed && passCount < maxPasses) {
      changed = false;
      passCount++;
      const newSegments: { start: number; end: number }[] = [];
      
      for (let i = 0; i < workingSegments.length; i++) {
        const seg = workingSegments[i];
        const duration = seg.end - seg.start;
        
        if (duration >= minSegmentDuration) {
          // Segment is long enough, check if it can absorb into last valid segment
          if (newSegments.length > 0) {
            const lastSeg = newSegments[newSegments.length - 1];
            // Ensure no overlap: if current segment starts before last ends, merge
            if (seg.start < lastSeg.end) {
              lastSeg.end = Math.max(lastSeg.end, seg.end);
              changed = true;
              videoLogger.debug(`[Crossfade Safety] Pass ${passCount}: Fixed overlapping segment ${i}`);
              continue;
            }
          }
          newSegments.push({ start: seg.start, end: seg.end });
        } else if (newSegments.length > 0) {
          // Merge short segment into previous segment by extending its end
          const prevSeg = newSegments[newSegments.length - 1];
          prevSeg.end = Math.max(prevSeg.end, seg.end);
          changed = true;
          videoLogger.debug(`[Crossfade Safety] Pass ${passCount}: Merged short segment ${i} (${duration.toFixed(2)}s) into previous`);
        } else {
          // First segment is too short - accumulate start time for next segment
          // Just add it and let the next pass merge it
          newSegments.push({ start: seg.start, end: seg.end });
          videoLogger.debug(`[Crossfade Safety] Pass ${passCount}: Keeping short first segment ${i} (${duration.toFixed(2)}s) for now`);
        }
      }
      
      workingSegments = newSegments;
    }
    
    // Final validation: ensure all segments are valid
    const validatedSegments = workingSegments.filter(seg => {
      const duration = seg.end - seg.start;
      if (duration < 0.1) {
        videoLogger.warn(`[Crossfade Safety] Removing invalid segment (${duration.toFixed(2)}s)`);
        return false;
      }
      return true;
    });
    
    // Sort by start time and remove any remaining overlaps
    validatedSegments.sort((a, b) => a.start - b.start);
    
    // STRICT CHECK: If any segment is still below minimum after merging, disable transitions for this render
    const shortSegmentsRemaining = validatedSegments.filter(s => (s.end - s.start) < minSegmentDuration);
    if (shortSegmentsRemaining.length > 0) {
      videoLogger.warn(`[Crossfade Safety] ${shortSegmentsRemaining.length} segment(s) still below ${minSegmentDuration}s after merge - DISABLING transitions for this render`);
      shortSegmentsRemaining.forEach((s, i) => 
        videoLogger.debug(`  Short segment: ${s.start.toFixed(2)}s - ${s.end.toFixed(2)}s (${(s.end - s.start).toFixed(2)}s)`)
      );
      options.addTransitions = false;
    }
    
    // ALWAYS update segmentsToKeep to the validated list
    if (validatedSegments.length !== originalCount) {
      videoLogger.info(`[Crossfade Safety] Adjusted segments: ${originalCount} -> ${validatedSegments.length} (min duration: ${minSegmentDuration}s, passes: ${passCount})`);
    }
    segmentsToKeep = validatedSegments;
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
    const transitionDurationTarget = 0.5; // Target transition duration
    const useTransitions = options.addTransitions && segmentsToKeep.length > 1;
    
    // First, create all segment files
    for (let i = 0; i < segmentsToKeep.length; i++) {
      const seg = segmentsToKeep[i];
      const segPath = path.join(OUTPUT_DIR, `seg_${outputId}_${i}.mp4`);
      
      await createVideoSegment(videoPath, segPath, seg.start, seg.end - seg.start);
      segmentPaths.push(segPath);
      tempFiles.push(segPath);
    }
    
    baseVideoPath = path.join(OUTPUT_DIR, `base_${outputId}.mp4`);
    
    // Track actual transition durations for precise mapping
    let transitionResult: TransitionResult = { effectiveDurations: [], totalReduction: 0 };
    
    if (useTransitions) {
      videoLogger.info(`Applying crossfade transitions between ${segmentPaths.length} segments...`);
      transitionResult = await concatSegmentsWithTransitions(segmentPaths, baseVideoPath, transitionDurationTarget, tempFiles);
    } else {
      await concatSegmentsSimple(segmentPaths, baseVideoPath);
    }
    
    tempFiles.push(baseVideoPath);
    videoLogger.info(`Created concatenated base video from ${segmentsToKeep.length} segments${useTransitions ? ' with transitions' : ''}`);
    
    // Calculate output mapping using ACTUAL transition durations (not averaged)
    // This ensures precise B-roll/AI image placement
    let outputTime = 0;
    for (let i = 0; i < segmentsToKeep.length; i++) {
      const seg = segmentsToKeep[i];
      outputTimeMapping.push({
        sourceStart: seg.start,
        sourceEnd: seg.end,
        outputStart: outputTime
      });
      
      const segDuration = seg.end - seg.start;
      // Use actual transition duration for this specific boundary
      if (useTransitions && i < segmentsToKeep.length - 1 && transitionResult.effectiveDurations[i] !== undefined) {
        outputTime += segDuration - transitionResult.effectiveDurations[i];
      } else {
        outputTime += segDuration;
      }
    }
    
    const rawTotalDuration = segmentsToKeep.reduce((sum, s) => sum + (s.end - s.start), 0);
    videoLogger.debug(`Output time mapping: raw=${rawTotalDuration.toFixed(2)}s, reduction=${transitionResult.totalReduction.toFixed(2)}s (${transitionResult.effectiveDurations.length} transitions: [${transitionResult.effectiveDurations.map(d => d.toFixed(2)).join(', ')}]s)`);
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
    
    // SECOND: Process stock media with AI-selected timing (startTime/endTime set by mediaSelector)
    // This enables multi-clip support - AI selector can assign multiple clips to dense segments
    const stockWithTiming = downloadedStockMedia.filter(m => typeof m.item.startTime === "number");
    const stockWithoutTiming = downloadedStockMedia.filter(m => typeof m.item.startTime !== "number");
    
    videoLogger.info(`Stock media: ${stockWithTiming.length} with AI timing, ${stockWithoutTiming.length} without timing`);
    
    // Process stock with AI-assigned timing first
    for (const mediaItem of stockWithTiming) {
      const sourceTime = mediaItem.item.startTime!;
      const sourceEndTime = mediaItem.item.endTime || sourceTime + 4;
      const itemQuery = mediaItem.item.query || "unknown";
      
      // Find output time for this source time
      let outputTime: number | null = null;
      let mappingStrategy = "unmapped";
      
      for (const mapping of outputTimeMapping) {
        if (sourceTime >= mapping.sourceStart && sourceTime < mapping.sourceEnd) {
          outputTime = mapping.outputStart + (sourceTime - mapping.sourceStart);
          mappingStrategy = "exact";
          break;
        }
      }
      
      // Try tolerance mapping if exact match failed
      if (outputTime === null) {
        const toleranceSeconds = 0.5;
        for (const mapping of outputTimeMapping) {
          if (sourceTime >= mapping.sourceStart - toleranceSeconds && 
              sourceTime <= mapping.sourceEnd + toleranceSeconds) {
            const clampedSourceTime = Math.max(mapping.sourceStart, Math.min(sourceTime, mapping.sourceEnd - 0.1));
            outputTime = mapping.outputStart + (clampedSourceTime - mapping.sourceStart);
            mappingStrategy = "tolerance";
            break;
          }
        }
      }
      
      if (outputTime !== null && outputTime >= 0 && outputTime < baseMetadata.duration) {
        // Calculate duration from AI selector timing or media duration
        let duration = Math.min(
          sourceEndTime - sourceTime,
          mediaItem.item.duration || 5,
          5
        );
        
        // Clamp duration if extends beyond video end
        if (outputTime + duration > baseMetadata.duration) {
          const overflow = (outputTime + duration) - baseMetadata.duration;
          duration = Math.max(0.5, duration - overflow);
        }
        
        // Check overlap with existing overlays (AI images and previous stock)
        const overlapsExisting = brollOverlays.some(o => 
          intervalsOverlap(outputTime!, outputTime! + duration, o.startTime, o.startTime + o.duration)
        );
        
        if (!overlapsExisting && duration > 0.5) {
          brollOverlays.push({
            localPath: mediaItem.localPath,
            type: mediaItem.item.type as "video" | "image" | "ai_generated",
            startTime: outputTime,
            duration,
          });
          stockMediaApplied++;
          videoLogger.info(`[Stock OK] ${mediaItem.item.type} at output=${outputTime.toFixed(2)}s (src=${sourceTime.toFixed(2)}s) for ${duration.toFixed(2)}s via ${mappingStrategy}: ${itemQuery.substring(0, 50)}`);
        } else if (overlapsExisting) {
          videoLogger.debug(`[Stock SKIP] Overlaps existing overlay at ${outputTime.toFixed(2)}s: ${itemQuery.substring(0, 50)}`);
        }
      } else {
        videoLogger.debug(`[Stock SKIP] Could not map to output timeline (src=${sourceTime.toFixed(2)}s): ${itemQuery.substring(0, 50)}`);
      }
    }
    
    // THIRD: Process stock media based on insert_stock actions from edit plan (for stock without AI timing)
    let stockWithoutTimingIdx = 0;
    for (const action of insertStockActions) {
      if (stockWithoutTimingIdx >= stockWithoutTiming.length) break;
      
      const sourceTime = action.start || 0;
      const mediaItem = stockWithoutTiming[stockWithoutTimingIdx];
      
      // Find output time for this source time
      let outputTime: number | null = null;
      for (const mapping of outputTimeMapping) {
        if (sourceTime >= mapping.sourceStart && sourceTime < mapping.sourceEnd) {
          outputTime = mapping.outputStart + (sourceTime - mapping.sourceStart);
          break;
        }
      }
      
      if (outputTime !== null && outputTime >= 0 && outputTime < baseMetadata.duration) {
        // Calculate initial duration
        let duration = Math.min(
          action.duration || (action.end && action.start ? action.end - action.start : 4),
          mediaItem.item.duration || 5,
          5
        );
        
        // Clamp duration if extends beyond video end (same safety as AI images)
        if (outputTime + duration > baseMetadata.duration) {
          const overflow = (outputTime + duration) - baseMetadata.duration;
          duration = Math.max(0.5, duration - overflow);
          videoLogger.debug(`[Stock] Clamped duration to ${duration.toFixed(2)}s to fit before video end`);
        }
        
        // Check if this time overlaps with any existing overlay (using actual durations)
        const overlapsExisting = brollOverlays.some(o => 
          intervalsOverlap(outputTime!, outputTime! + duration, o.startTime, o.startTime + o.duration)
        );
        
        if (!overlapsExisting && duration > 0) {
          brollOverlays.push({
            localPath: mediaItem.localPath,
            type: mediaItem.item.type as "video" | "image" | "ai_generated",
            startTime: outputTime,
            duration,
            text: action.text,
          });
          stockWithoutTimingIdx++;
          stockMediaApplied++;
        } else if (overlapsExisting) {
          videoLogger.debug(`Skipping stock at ${outputTime.toFixed(2)}s - overlaps with existing overlay`);
        }
      }
    }
    
    // FOURTH: Distribute remaining stock media evenly across the video
    const remainingStock = stockWithoutTiming.slice(stockWithoutTimingIdx);
    if (remainingStock.length > 0) {
      const interval = baseMetadata.duration / (remainingStock.length + 1);
      
      for (let i = 0; i < remainingStock.length; i++) {
        const startTime = interval * (i + 1);
        let duration = Math.min(remainingStock[i].item.duration || 5, 3);
        
        // Clamp duration if extends beyond video end
        if (startTime + duration > baseMetadata.duration) {
          const overflow = (startTime + duration) - baseMetadata.duration;
          duration = Math.max(0.5, duration - overflow);
        }
        
        // Skip if start time is beyond video or duration too short
        if (startTime >= baseMetadata.duration || duration < 0.5) {
          continue;
        }
        
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
        
        // Adjust word timings as well - use partial overlap logic
        // Include words that have ANY overlap with the segment, not just fully contained
        let adjustedWords: WordTiming[] | undefined;
        if (cap.words && cap.words.length > 0) {
          adjustedWords = cap.words
            // Include words with ANY overlap (partial overlap allowed)
            // Use word midpoint to determine inclusion - more robust for boundary cases
            .filter(w => {
              const wordMidpoint = (w.start + w.end) / 2;
              // Include word if its midpoint is in the segment OR it has significant overlap (>30%)
              const wordDuration = w.end - w.start;
              const overlapAmount = Math.min(w.end, overlapEnd) - Math.max(w.start, overlapStart);
              const overlapRatio = wordDuration > 0 ? overlapAmount / wordDuration : 0;
              
              return (wordMidpoint >= overlapStart && wordMidpoint <= overlapEnd) || overlapRatio >= 0.3;
            })
            .map(w => {
              // Clamp word timing to segment boundaries
              const clampedStart = Math.max(w.start, overlapStart);
              const clampedEnd = Math.min(w.end, overlapEnd);
              
              // Ensure minimum duration for display - expand if needed
              const MIN_WORD_DURATION = 0.08; // 80ms minimum for readability
              let adjustedWordStart = mapping.outputStart + (clampedStart - mapping.sourceStart);
              let adjustedWordEnd = mapping.outputStart + (clampedEnd - mapping.sourceStart);
              
              // Expand short words to minimum duration
              if (adjustedWordEnd - adjustedWordStart < MIN_WORD_DURATION) {
                const midpoint = (adjustedWordStart + adjustedWordEnd) / 2;
                adjustedWordStart = midpoint - MIN_WORD_DURATION / 2;
                adjustedWordEnd = midpoint + MIN_WORD_DURATION / 2;
              }
              
              return {
                word: w.word,
                start: Math.max(0, adjustedWordStart),
                end: adjustedWordEnd,
              };
            })
            // Remove only truly invalid words
            .filter(w => w.end > w.start);
        }
        
        // Rebuild text from adjusted words if words were modified
        const adjustedText = adjustedWords && adjustedWords.length > 0
          ? adjustedWords.map(w => w.word).join(' ')
          : cap.text;
        
        adjustedCaptions.push({
          start: adjustedStart,
          end: adjustedEnd,
          text: adjustedText,
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
    } catch {
      // File may already be deleted or doesn't exist - ignore
    }
  }
}

export { UPLOADS_DIR, FRAMES_DIR, OUTPUT_DIR, AUDIO_DIR, STOCK_DIR, CHAPTERS_DIR, ensureDirs };
