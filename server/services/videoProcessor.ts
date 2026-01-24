import ffmpeg from "fluent-ffmpeg";
import { promises as fs } from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import type { VideoAnalysis, FrameAnalysis } from "@shared/schema";

const UPLOADS_DIR = "/tmp/uploads";
const FRAMES_DIR = "/tmp/frames";
const OUTPUT_DIR = "/tmp/output";
const AUDIO_DIR = "/tmp/audio";

async function ensureDirs() {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  await fs.mkdir(FRAMES_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.mkdir(AUDIO_DIR, { recursive: true });
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

      resolve({
        duration,
        width: videoStream?.width || 1920,
        height: videoStream?.height || 1080,
        fps: videoStream?.r_frame_rate
          ? eval(videoStream.r_frame_rate)
          : 30,
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

export async function applyEdits(
  videoPath: string,
  editPlan: any,
  outputFileName?: string
): Promise<string> {
  await ensureDirs();

  const outputId = outputFileName || uuidv4();
  const outputPath = path.join(OUTPUT_DIR, `${outputId}.mp4`);

  const keepSegments = editPlan.actions
    .filter((a: any) => a.type === "keep" && a.start !== undefined && a.end !== undefined)
    .sort((a: any, b: any) => a.start - b.start);

  if (keepSegments.length === 0) {
    await fs.copyFile(videoPath, outputPath);
    return outputPath;
  }

  const filterComplex: string[] = [];
  const concatInputs: string[] = [];

  for (let i = 0; i < keepSegments.length; i++) {
    const seg = keepSegments[i];
    filterComplex.push(
      `[0:v]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS[v${i}]`
    );
    filterComplex.push(
      `[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${i}]`
    );
    concatInputs.push(`[v${i}][a${i}]`);
  }

  filterComplex.push(
    `${concatInputs.join("")}concat=n=${keepSegments.length}:v=1:a=1[outv][outa]`
  );

  await new Promise<void>((resolve, reject) => {
    ffmpeg(videoPath)
      .complexFilter(filterComplex.join(";"))
      .outputOptions([
        "-map",
        "[outv]",
        "-map",
        "[outa]",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "23",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
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

export { UPLOADS_DIR, FRAMES_DIR, OUTPUT_DIR, AUDIO_DIR, ensureDirs };
