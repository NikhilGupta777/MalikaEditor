import ffmpeg from "fluent-ffmpeg";
import { promises as fs, createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import axios from "axios";
import type { VideoAnalysis, FrameAnalysis, EditPlan, EditAction, TranscriptSegment, StockMediaItem } from "@shared/schema";
import { createLogger } from "../utils/logger";

const videoLogger = createLogger("video-processor");

const UPLOADS_DIR = "/tmp/uploads";
const FRAMES_DIR = "/tmp/frames";
const OUTPUT_DIR = "/tmp/output";
const AUDIO_DIR = "/tmp/audio";
const STOCK_DIR = "/tmp/stock";

const FFPROBE_TIMEOUT_MS = 30000;
const FFMPEG_SHORT_TIMEOUT_MS = 2 * 60 * 1000;
const FFMPEG_LONG_TIMEOUT_MS = 10 * 60 * 1000;

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
const ALL_TEMP_DIRS = [UPLOADS_DIR, FRAMES_DIR, OUTPUT_DIR, AUDIO_DIR, STOCK_DIR];

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

// Generate ASS (Advanced SubStation Alpha) subtitle file for karaoke-style captions
// This provides word-by-word highlighting with professional styling
function generateAssContent(
  captions: CaptionWithWords[],
  videoWidth: number,
  videoHeight: number
): string {
  // Position captions near the bottom of the video
  // MarginV controls vertical positioning from bottom
  // 15% from bottom = 85% from top (near the very bottom, above player controls)
  const marginBottom = Math.round(videoHeight * 0.15);
  
  // Font size scales with video height for readability
  const fontSize = Math.max(Math.round(videoHeight / 18), 28);
  
  // ASS karaoke colors:
  // - SecondaryColour (&H00FFFFFF white): Color BEFORE the word is spoken (unhighlighted)
  // - PrimaryColour (&H0000D4FF cyan/yellow): Color AS the word is being spoken (highlighted)
  // The \k tags progressively fill from Secondary to Primary color
  const highlightColor = "&H0000D4FF";  // Cyan/Yellow highlight (BGR format)
  const baseColor = "&H00FFFFFF";       // White base color
  const outlineColor = "&H00000000";    // Black outline
  const backColor = "&H80000000";       // Semi-transparent black background
  
  // ASS file header with styles
  const header = `[Script Info]
Title: Karaoke Captions
ScriptType: v4.00+
PlayResX: ${videoWidth}
PlayResY: ${videoHeight}
WrapStyle: 0
Timer: 100.0000

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,${fontSize},${highlightColor},${baseColor},${outlineColor},${backColor},1,0,0,0,100,100,0,0,1,3,1,2,20,20,${marginBottom},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const formatAssTime = (seconds: number): string => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const cs = Math.floor((seconds % 1) * 100); // Centiseconds for ASS
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  };

  // Build dialogue lines with karaoke effect
  const dialogueLines: string[] = [];
  
  for (const cap of captions) {
    if (cap.words && cap.words.length > 0) {
      // Karaoke-style: show words progressively with highlighting
      // Group words into chunks of ~4 words for readability
      const wordsPerChunk = 4;
      const chunks: WordTiming[][] = [];
      
      for (let i = 0; i < cap.words.length; i += wordsPerChunk) {
        chunks.push(cap.words.slice(i, i + wordsPerChunk));
      }
      
      // For each chunk, show with progressive word highlighting
      for (const chunk of chunks) {
        if (chunk.length === 0) continue;
        
        const chunkStart = chunk[0].start;
        const chunkEnd = chunk[chunk.length - 1].end;
        
        // Create karaoke text with {\k} timing codes
        // \k (or \kf for smooth fill) fills word from SecondaryColour to PrimaryColour
        // The number is duration in centiseconds
        let karaokeText = '';
        
        for (let i = 0; i < chunk.length; i++) {
          const word = chunk[i];
          const wordDuration = Math.max(Math.round((word.end - word.start) * 100), 10); // Min 10cs
          const escapedWord = escapeAssText(word.word);
          
          // \kf creates a smooth fill effect (character by character highlight)
          karaokeText += `{\\kf${wordDuration}}${escapedWord} `;
        }
        
        dialogueLines.push(
          `Dialogue: 0,${formatAssTime(chunkStart)},${formatAssTime(chunkEnd)},Default,,0,0,0,,${karaokeText.trim()}`
        );
      }
    } else {
      // Fallback: simple subtitle without word-level timing
      const escapedText = escapeAssText(cap.text);
      dialogueLines.push(
        `Dialogue: 0,${formatAssTime(cap.start)},${formatAssTime(cap.end)},Default,,0,0,0,,${escapedText}`
      );
    }
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
    complexFilterArray.push(
      `[0:a]apad=pad_dur=${transitionDuration}[a0];[1:a]adelay=0|0[a1];[a0][a1]amix=inputs=2:duration=longest[a]`
    );
    outputOptions.push("-map", "[a]", "-c:a", "aac", "-b:a", "96k");
  } else if (hasAudio1) {
    complexFilterArray.push(`[0:a]apad=pad_dur=${transitionDuration}[a]`);
    outputOptions.push("-map", "[a]", "-c:a", "aac", "-b:a", "96k");
  } else if (hasAudio2) {
    complexFilterArray.push(`[1:a]adelay=${Math.floor(offset * 1000)}|${Math.floor(offset * 1000)}[a]`);
    outputOptions.push("-map", "[a]", "-c:a", "aac", "-b:a", "96k");
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

// Apply all overlays one at a time with fade effects
async function applyAllBrollOverlays(
  baseVideoPath: string,
  overlays: BrollOverlay[],
  outputPath: string,
  width: number,
  height: number,
  tempFiles: string[]
): Promise<void> {
  if (overlays.length === 0) {
    await fs.copyFile(baseVideoPath, outputPath);
    return;
  }

  const outputId = uuidv4();
  const fadeDuration = 0.3;
  
  // Prepare all overlay video files (scaled to match base video)
  const preparedOverlays: { path: string; startTime: number; duration: number }[] = [];
  
  for (let i = 0; i < overlays.length; i++) {
    const overlay = overlays[i];
    const overlayVideoPath = path.join(OUTPUT_DIR, `overlay_${outputId}_${i}.mp4`);
    
    try {
      await prepareOverlayMedia(
        { item: { type: overlay.type, url: "", query: "", duration: overlay.duration }, localPath: overlay.localPath },
        overlay.duration,
        width,
        height,
        overlayVideoPath
      );
      
      preparedOverlays.push({
        path: overlayVideoPath,
        startTime: overlay.startTime,
        duration: overlay.duration,
      });
      tempFiles.push(overlayVideoPath);
      videoLogger.debug(`Prepared overlay ${i}: at ${overlay.startTime}s for ${overlay.duration}s`);
    } catch (err) {
      videoLogger.error(`Failed to prepare overlay ${i}:`, err);
    }
  }

  if (preparedOverlays.length === 0) {
    await fs.copyFile(baseVideoPath, outputPath);
    return;
  }

  // Apply overlays one at a time for reliability
  // Each overlay: shift timing with setpts, apply fade, then composite
  let currentPath = baseVideoPath;
  
  for (let i = 0; i < preparedOverlays.length; i++) {
    const overlay = preparedOverlays[i];
    const intermediatePath = path.join(OUTPUT_DIR, `overlayed_${outputId}_${i}.mp4`);
    
    const overlayStart = overlay.startTime;
    
    // Complex filter using single timing strategy (setpts only):
    // 1. Convert overlay to support alpha channel for fade effects
    // 2. Apply fade in/out effects (fades the entire overlay including any padding)
    // 3. Shift overlay timing using setpts to start at overlayStart in base timeline
    // 4. Overlay composites at full frame - B-roll style visual while audio continues
    // Note: eof_action=pass means base video shows through when overlay has no frames
    const filterComplex = [
      `[1:v]format=yuva420p,fade=t=in:st=0:d=${fadeDuration}:alpha=1,fade=t=out:st=${Math.max(0, overlay.duration - fadeDuration)}:d=${fadeDuration}:alpha=1,setpts=PTS-STARTPTS+${overlayStart}/TB[ov]`,
      `[0:v][ov]overlay=0:0:eof_action=pass[outv]`
    ].join(";");
    
    const overlayCmd = ffmpeg()
      .input(currentPath)
      .input(overlay.path)
      .complexFilter(filterComplex)
      .outputOptions([
        "-map", "[outv]",
        "-map", "0:a?",
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "23",
        "-c:a", "copy",
        "-threads", "2",
        "-max_muxing_queue_size", "2048",
      ])
      .output(intermediatePath);
    
    await runFfmpegWithTimeout(overlayCmd, FFMPEG_LONG_TIMEOUT_MS, [intermediatePath]);
    
    tempFiles.push(intermediatePath);
    currentPath = intermediatePath;
    videoLogger.debug(`Applied overlay ${i} at ${overlayStart}s with fade`);
  }
  
  await fs.copyFile(currentPath, outputPath);
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
  outputFileName?: string
): Promise<EditResult> {
  await ensureDirs();
  
  videoLogger.info("=== APPLY EDITS START (OVERLAY MODE) ===");
  videoLogger.debug("Options:", JSON.stringify(options));
  videoLogger.debug("Transcript segments:", transcript.length);
  videoLogger.debug("Stock media items:", stockMedia.length);
  videoLogger.debug("Edit plan actions:", editPlan.actions?.length || 0);

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
      tempFiles
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
  tempFiles: string[]
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
    await concatSegmentsSimple(segmentPaths, baseVideoPath);
    tempFiles.push(baseVideoPath);
    videoLogger.info(`Created concatenated base video from ${segmentsToKeep.length} segments`);
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
    
    for (const aiMedia of downloadedAiMedia) {
      const sourceTime = aiMedia.item.startTime;
      const itemDuration = aiMedia.item.duration;
      const itemQuery = aiMedia.item.query || "unknown";
      
      // STRICT VALIDATION: Require both startTime and duration
      if (typeof sourceTime !== "number" || sourceTime < 0) {
        videoLogger.warn(`[AI Image SKIP] Missing/invalid startTime (${sourceTime}): ${itemQuery}`);
        aiImagesSkipped++;
        continue;
      }
      
      if (typeof itemDuration !== "number" || itemDuration <= 0) {
        videoLogger.warn(`[AI Image SKIP] Missing/invalid duration (${itemDuration}): ${itemQuery}`);
        aiImagesSkipped++;
        continue;
      }
      
      // Find output time for this source time
      let outputTime: number | null = null;
      for (const mapping of outputTimeMapping) {
        if (sourceTime >= mapping.sourceStart && sourceTime < mapping.sourceEnd) {
          outputTime = mapping.outputStart + (sourceTime - mapping.sourceStart);
          break;
        }
      }
      
      if (outputTime !== null && outputTime >= 0) {
        const duration = Math.min(itemDuration, 5);
        
        // Ensure overlay doesn't extend beyond video
        if (outputTime + duration > baseMetadata.duration) {
          videoLogger.warn(`[AI Image SKIP] Would extend beyond video (${outputTime}+${duration} > ${baseMetadata.duration}s): ${itemQuery}`);
          aiImagesSkipped++;
          continue;
        }
        
        brollOverlays.push({
          localPath: aiMedia.localPath,
          type: aiMedia.item.type,
          startTime: outputTime,
          duration,
        });
        
        aiImagesApplied++;
        videoLogger.debug(`[AI Image OK] Applied at ${outputTime.toFixed(2)}s for ${duration.toFixed(2)}s: ${itemQuery.substring(0, 50)}`);
      } else {
        aiImagesSkipped++;
        videoLogger.warn(`[AI Image SKIP] Timing outside video bounds (source=${sourceTime}s): ${itemQuery}`);
      }
    }
    
    // Log AI image placement summary
    videoLogger.info(`AI Image Summary: ${aiImagesApplied} applied, ${aiImagesSkipped} skipped (total: ${downloadedAiMedia.length})`);
    if (aiImagesSkipped > 0) {
      videoLogger.warn(`Warning: ${aiImagesSkipped} AI image(s) were not applied due to timing issues`);
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
          (outputTime >= o.startTime && outputTime < o.startTime + o.duration) ||
          (outputTime + stockDuration > o.startTime && outputTime + stockDuration <= o.startTime + o.duration)
        );
        
        if (!overlapsAi) {
          const duration = Math.min(
            action.duration || (action.end && action.start ? action.end - action.start : 4),
            mediaItem.item.duration || 5,
            5
          );
          
          brollOverlays.push({
            localPath: mediaItem.localPath,
            type: mediaItem.item.type,
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
          (startTime >= o.startTime && startTime < o.startTime + o.duration) ||
          (startTime + duration > o.startTime && startTime + duration <= o.startTime + o.duration)
        );
        
        if (!overlapsExisting) {
          brollOverlays.push({
            localPath: remainingStock[i].localPath,
            type: remainingStock[i].item.type,
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
      await applyAllBrollOverlays(
        baseVideoPath,
        brollOverlays,
        overlayedPath,
        metadata.width,
        metadata.height,
        tempFiles
      );
      tempFiles.push(overlayedPath);
      videoLogger.info(`Applied ${brollOverlays.length} B-roll overlays successfully`);
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
  if (adjustedCaptions.length > 0) {
    videoLogger.info(`Burning ${adjustedCaptions.length} karaoke-style captions into final video`);
    
    // Get video dimensions for proper ASS rendering
    const videoMeta = await getVideoMetadata(overlayedPath);
    
    // Generate ASS file with karaoke timing
    const assPath = path.join(OUTPUT_DIR, `${outputId}.ass`);
    const assContent = generateAssContent(adjustedCaptions, videoMeta.width, videoMeta.height);
    await fs.writeFile(assPath, assContent);
    tempFiles.push(assPath);
    
    await burnSubtitles(overlayedPath, outputPath, assPath);
  } else {
    // Just copy the result
    if (overlayedPath !== outputPath) {
      await fs.copyFile(overlayedPath, outputPath);
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

export { UPLOADS_DIR, FRAMES_DIR, OUTPUT_DIR, AUDIO_DIR, STOCK_DIR, ensureDirs };
