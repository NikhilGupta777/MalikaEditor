import ffmpeg from "fluent-ffmpeg";
import { promises as fs } from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import axios from "axios";
import type { VideoAnalysis, FrameAnalysis, EditPlan, EditAction, TranscriptSegment } from "@shared/schema";

const UPLOADS_DIR = "/tmp/uploads";
const FRAMES_DIR = "/tmp/frames";
const OUTPUT_DIR = "/tmp/output";
const AUDIO_DIR = "/tmp/audio";
const STOCK_DIR = "/tmp/stock";

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
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(err);
        return;
      }

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

      resolve({
        duration,
        width: videoStream?.width || 1920,
        height: videoStream?.height || 1080,
        fps,
      });
    });
  });
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

    await new Promise<void>((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(timestamp)
        .frames(1)
        .output(framePath)
        .outputOptions(["-q:v 2"])
        .on("end", () => resolve())
        .on("error", reject)
        .run();
    });

    framePaths.push(framePath);
  }

  return framePaths;
}

export async function extractAudio(videoPath: string): Promise<string> {
  await ensureDirs();

  const audioId = uuidv4();
  const audioPath = path.join(AUDIO_DIR, `${audioId}.mp3`);

  await new Promise<void>((resolve, reject) => {
    ffmpeg(videoPath)
      .noVideo()
      .audioCodec("libmp3lame")
      .audioBitrate("64k")
      .audioChannels(1)
      .audioFrequency(16000)
      .output(audioPath)
      .on("end", () => resolve())
      .on("error", reject)
      .run();
  });

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

    ffmpeg(videoPath)
      .audioFilters([
        `silencedetect=noise=${silenceThreshold}dB:d=${silenceDuration}`,
      ])
      .format("null")
      .output("-")
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
      .on("end", () => resolve(silentSegments))
      .on("error", reject)
      .run();
  });
}

async function downloadFile(url: string, outputPath: string): Promise<void> {
  const response = await axios({
    method: "GET",
    url,
    responseType: "arraybuffer",
    timeout: 30000,
  });
  
  await fs.writeFile(outputPath, Buffer.from(response.data));
}

function escapeText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

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
}

export async function applyEdits(
  videoPath: string,
  editPlan: EditPlan,
  transcript: TranscriptSegment[],
  stockMedia: { type: string; url: string; localPath?: string }[],
  options: EditOptions,
  outputFileName?: string
): Promise<string> {
  await ensureDirs();

  const outputId = outputFileName || uuidv4();
  const outputPath = path.join(OUTPUT_DIR, `${outputId}.mp4`);
  const metadata = await getVideoMetadata(videoPath);

  const keepSegments = editPlan.actions
    .filter((a: EditAction) => a.type === "keep" && a.start !== undefined && a.end !== undefined)
    .sort((a, b) => (a.start || 0) - (b.start || 0));

  if (keepSegments.length === 0) {
    keepSegments.push({
      type: "keep",
      start: 0,
      end: metadata.duration,
      reason: "Keep entire video",
    });
  }

  const captionActions = editPlan.actions.filter((a: EditAction) => 
    a.type === "add_caption" && a.text
  );

  const allCaptions = options.addCaptions 
    ? [...transcript, ...captionActions.map(a => ({
        start: a.start || 0,
        end: a.end || (a.start || 0) + 3,
        text: a.text || ""
      }))]
    : [];

  let srtPath: string | undefined;
  if (allCaptions.length > 0) {
    srtPath = path.join(OUTPUT_DIR, `${outputId}.srt`);
    const srtContent = generateSrtContent(allCaptions);
    await fs.writeFile(srtPath, srtContent);
  }

  const downloadedStock: string[] = [];
  if (options.addBroll && stockMedia.length > 0) {
    for (let i = 0; i < Math.min(stockMedia.length, 3); i++) {
      const item = stockMedia[i];
      if (item.type === "image") {
        try {
          const ext = item.url.includes(".png") ? "png" : "jpg";
          const localPath = path.join(STOCK_DIR, `${outputId}_stock_${i}.${ext}`);
          await downloadFile(item.url, localPath);
          downloadedStock.push(localPath);
        } catch (e) {
          console.error("Failed to download stock image:", e);
        }
      }
    }
  }

  if (keepSegments.length === 1 && allCaptions.length === 0 && downloadedStock.length === 0) {
    const seg = keepSegments[0];
    await new Promise<void>((resolve, reject) => {
      ffmpeg(videoPath)
        .setStartTime(seg.start || 0)
        .setDuration((seg.end || metadata.duration) - (seg.start || 0))
        .outputOptions([
          "-c:v", "libx264",
          "-preset", "ultrafast",
          "-crf", "28",
          "-c:a", "aac",
          "-b:a", "96k",
          "-max_muxing_queue_size", "1024",
          "-threads", "1",
        ])
        .output(outputPath)
        .on("end", () => resolve())
        .on("error", (err) => {
          console.error("FFmpeg error:", err);
          reject(err);
        })
        .run();
    });
    return outputPath;
  }

  const tempSegmentPaths: string[] = [];
  
  for (let i = 0; i < keepSegments.length; i++) {
    const seg = keepSegments[i];
    const segStart = seg.start || 0;
    const segEnd = seg.end || metadata.duration;
    const segDuration = segEnd - segStart;
    
    const segmentPath = path.join(OUTPUT_DIR, `segment_${outputId}_${i}.ts`);
    tempSegmentPaths.push(segmentPath);

    const filterParts: string[] = [];

    if (srtPath && allCaptions.length > 0) {
      const escapedPath = srtPath.replace(/'/g, "\\'").replace(/:/g, "\\:");
      filterParts.push(`subtitles='${escapedPath}':force_style='FontSize=24,PrimaryColour=&Hffffff,OutlineColour=&H000000,BorderStyle=3,Outline=2,Shadow=1,Alignment=2,MarginV=30'`);
    }

    await new Promise<void>((resolve, reject) => {
      let cmd = ffmpeg(videoPath)
        .setStartTime(segStart)
        .setDuration(segDuration);

      const outputOptions = [
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "28",
        "-c:a", "aac",
        "-b:a", "96k",
        "-max_muxing_queue_size", "1024",
        "-threads", "1",
        "-f", "mpegts",
      ];

      if (filterParts.length > 0) {
        cmd = cmd.videoFilters(filterParts);
      }

      cmd
        .outputOptions(outputOptions)
        .output(segmentPath)
        .on("end", () => resolve())
        .on("error", (err) => {
          console.error(`FFmpeg segment ${i} error:`, err);
          reject(err);
        })
        .run();
    });
  }

  if (options.addBroll && downloadedStock.length > 0) {
    const brollInsertPoints = editPlan.actions
      .filter((a: EditAction) => a.type === "insert_stock" && a.start !== undefined)
      .slice(0, downloadedStock.length);

    for (let i = 0; i < Math.min(brollInsertPoints.length, downloadedStock.length); i++) {
      const insertAction = brollInsertPoints[i];
      const imagePath = downloadedStock[i];
      
      try {
        const brollPath = path.join(OUTPUT_DIR, `broll_${outputId}_${i}.ts`);
        
        await new Promise<void>((resolve, reject) => {
          ffmpeg(imagePath)
            .loop(1)
            .inputOptions(["-t", "3"])
            .outputOptions([
              "-c:v", "libx264",
              "-preset", "ultrafast",
              "-crf", "28",
              "-pix_fmt", "yuv420p",
              "-vf", `scale=${metadata.width}:${metadata.height}:force_original_aspect_ratio=decrease,pad=${metadata.width}:${metadata.height}:(ow-iw)/2:(oh-ih)/2`,
              "-t", "3",
              "-f", "mpegts",
              "-threads", "1",
            ])
            .noAudio()
            .output(brollPath)
            .on("end", () => resolve())
            .on("error", (err) => {
              console.error("B-roll creation error:", err);
              reject(err);
            })
            .run();
        });

        const silentBrollPath = path.join(OUTPUT_DIR, `broll_audio_${outputId}_${i}.ts`);
        await new Promise<void>((resolve, reject) => {
          ffmpeg(brollPath)
            .inputOptions([
              "-f", "lavfi",
              "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
            ])
            .outputOptions([
              "-c:v", "copy",
              "-c:a", "aac",
              "-shortest",
              "-f", "mpegts",
            ])
            .output(silentBrollPath)
            .on("end", () => resolve())
            .on("error", (err) => {
              console.error("Silent B-roll error:", err);
              reject(err);
            })
            .run();
        });

        tempSegmentPaths.push(silentBrollPath);
        await fs.unlink(brollPath).catch(() => {});
      } catch (e) {
        console.error("Failed to create B-roll segment:", e);
      }
    }
  }

  const concatListPath = path.join(OUTPUT_DIR, `concat_${outputId}.txt`);
  const concatContent = tempSegmentPaths.map(p => `file '${p}'`).join("\n");
  await fs.writeFile(concatListPath, concatContent);

  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(concatListPath)
      .inputOptions(["-f", "concat", "-safe", "0"])
      .outputOptions([
        "-c", "copy",
        "-max_muxing_queue_size", "1024",
      ])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err) => {
        console.error("FFmpeg concat error:", err);
        reject(err);
      })
      .run();
  });

  await fs.unlink(concatListPath).catch(() => {});
  for (const segPath of tempSegmentPaths) {
    await fs.unlink(segPath).catch(() => {});
  }
  if (srtPath) {
    await fs.unlink(srtPath).catch(() => {});
  }
  for (const stockPath of downloadedStock) {
    await fs.unlink(stockPath).catch(() => {});
  }

  return outputPath;
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
