import ffmpeg from "fluent-ffmpeg";
import { promises as fs } from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import axios from "axios";
import type { VideoAnalysis, FrameAnalysis, EditPlan, EditAction, TranscriptSegment, StockMediaItem } from "@shared/schema";

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
    timeout: 60000,
  });
  
  await fs.writeFile(outputPath, Buffer.from(response.data));
}

function escapeFFmpegText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "'\\''")
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

  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(imagePath)
      .inputOptions(["-loop", "1"])
      .input("anullsrc=channel_layout=stereo:sample_rate=44100")
      .inputOptions(["-f", "lavfi"])
      .outputOptions([
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "28",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-t", String(duration),
        "-vf", filters.join(","),
        "-shortest",
        "-threads", "2",
      ])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err) => reject(err))
      .run();
  });
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

  await new Promise<void>((resolve, reject) => {
    ffmpeg(videoPath)
      .setDuration(duration)
      .outputOptions([
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "28",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "96k",
        "-vf", filters.join(","),
        "-threads", "2",
      ])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err) => reject(err))
      .run();
  });
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

  await new Promise<void>((resolve, reject) => {
    let cmd = ffmpeg(sourcePath)
      .setStartTime(start)
      .setDuration(duration);

    const outputOptions = [
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "28",
      "-c:a", "aac",
      "-b:a", "96k",
      "-max_muxing_queue_size", "1024",
      "-threads", "2",
    ];

    if (filters.length > 0) {
      cmd = cmd.videoFilters(filters);
    }

    cmd
      .outputOptions(outputOptions)
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err) => reject(err))
      .run();
  });
}

async function getFileDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(metadata.format.duration || 0);
    });
  });
}

async function concatSegmentsSimple(
  segmentPaths: string[],
  outputPath: string
): Promise<void> {
  const concatListPath = path.join(OUTPUT_DIR, `concat_${uuidv4()}.txt`);
  const concatContent = segmentPaths.map(p => `file '${p}'`).join("\n");
  await fs.writeFile(concatListPath, concatContent);

  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(concatListPath)
        .inputOptions(["-f", "concat", "-safe", "0"])
        .outputOptions([
          "-c:v", "libx264",
          "-preset", "ultrafast",
          "-crf", "28",
          "-c:a", "aac",
          "-b:a", "96k",
          "-max_muxing_queue_size", "1024",
          "-threads", "2",
        ])
        .output(outputPath)
        .on("end", () => resolve())
        .on("error", (err) => reject(err))
        .run();
    });
  } finally {
    await fs.unlink(concatListPath).catch(() => {});
  }
}

async function burnSubtitles(
  inputPath: string,
  outputPath: string,
  srtPath: string
): Promise<void> {
  const escapedSrtPath = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''");
  
  await new Promise<void>((resolve, reject) => {
    ffmpeg(inputPath)
      .videoFilters([
        `subtitles='${escapedSrtPath}':force_style='FontSize=24,PrimaryColour=&Hffffff,OutlineColour=&H000000,BorderStyle=3,Outline=2,Shadow=1'`
      ])
      .outputOptions([
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "28",
        "-c:a", "copy",
        "-threads", "2",
      ])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err) => reject(err))
      .run();
  });
}

async function hasAudioStream(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        resolve(false);
        return;
      }
      const audioStream = metadata.streams.find((s) => s.codec_type === "audio");
      resolve(!!audioStream);
    });
  });
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
    "-preset", "ultrafast",
    "-crf", "28",
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

  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(segment1Path)
      .input(segment2Path)
      .complexFilter(complexFilterArray)
      .outputOptions(outputOptions)
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err) => reject(err))
      .run();
  });
  
  return transitionDuration;
}

export async function applyEdits(
  videoPath: string,
  editPlan: EditPlan,
  transcript: TranscriptSegment[],
  stockMedia: StockMediaItem[],
  options: EditOptions,
  outputFileName?: string
): Promise<string> {
  await ensureDirs();
  
  console.log("=== APPLY EDITS START ===");
  console.log("Options:", JSON.stringify(options));
  console.log("Transcript segments:", transcript.length);
  console.log("Stock media items:", stockMedia.length);
  console.log("Edit plan actions:", editPlan.actions?.length || 0);

  const outputId = outputFileName || uuidv4();
  const outputPath = path.join(OUTPUT_DIR, `${outputId}.mp4`);
  const metadata = await getVideoMetadata(videoPath);
  const tempFiles: string[] = [];

  // Extract different action types from edit plan
  const keepSegments = editPlan.actions
    .filter((a: EditAction) => a.type === "keep" && a.start !== undefined && a.end !== undefined)
    .sort((a, b) => (a.start || 0) - (b.start || 0));

  const insertStockActions = editPlan.actions
    .filter((a: EditAction) => a.type === "insert_stock" && a.start !== undefined)
    .sort((a, b) => (a.start || 0) - (b.start || 0));

  const textOverlayActions = editPlan.actions
    .filter((a: EditAction) => a.type === "add_text_overlay" && a.text && a.start !== undefined);

  const transitionActions = editPlan.actions
    .filter((a: EditAction) => a.type === "transition");
  
  const captionActions = editPlan.actions.filter((a: EditAction) => 
    a.type === "add_caption" && a.text
  );

  console.log(`Keep segments: ${keepSegments.length}`);
  console.log(`Insert stock actions: ${insertStockActions.length}`);
  console.log(`Text overlay actions: ${textOverlayActions.length}`);
  console.log(`Transition actions: ${transitionActions.length}`);
  console.log(`Caption actions: ${captionActions.length}`);

  // If no keep segments, keep entire video
  if (keepSegments.length === 0) {
    keepSegments.push({
      type: "keep",
      start: 0,
      end: metadata.duration,
      reason: "Keep entire video",
    });
  }

  // Download stock media for B-roll
  const downloadedStockMedia: DownloadedStock[] = [];
  
  if (options.addBroll && stockMedia.length > 0) {
    console.log(`Downloading ${Math.min(stockMedia.length, 6)} stock media items...`);
    
    for (let i = 0; i < Math.min(stockMedia.length, 6); i++) {
      const item = stockMedia[i];
      try {
        let localPath: string;
        
        if (item.type === "video") {
          localPath = path.join(STOCK_DIR, `${outputId}_stock_${i}.mp4`);
          console.log(`Downloading stock video ${i}: ${item.query}`);
        } else {
          const ext = item.url.includes(".png") ? "png" : "jpg";
          localPath = path.join(STOCK_DIR, `${outputId}_stock_${i}.${ext}`);
          console.log(`Downloading stock image ${i}: ${item.query}`);
        }
        
        await downloadFile(item.url, localPath);
        downloadedStockMedia.push({ item, localPath });
        tempFiles.push(localPath);
        console.log(`Downloaded: ${localPath}`);
      } catch (e) {
        console.error(`Failed to download stock media ${i}:`, e);
      }
    }
  }

  // Build timeline: track original source times AND output timeline times
  interface TimelineEntry {
    type: "video" | "broll";
    sourceStart?: number;
    sourceEnd?: number;
    outputStart?: number;
    outputDuration?: number;
    stockMedia?: DownloadedStock;
    brollDuration?: number;
    textOverlays?: { text: string; startOffset: number; endOffset: number }[];
    brollText?: string;
  }

  const timeline: TimelineEntry[] = [];
  const usedInsertActions = new Set<number>();
  let stockMediaIndex = 0;
  let outputTime = 0;

  // Process each keep segment and split at insert_stock points
  for (let segIdx = 0; segIdx < keepSegments.length; segIdx++) {
    const segment = keepSegments[segIdx];
    const segStart = segment.start || 0;
    const segEnd = segment.end || metadata.duration;

    // Find insert_stock actions that fall within this segment
    const insertsInSegment: { action: EditAction; index: number }[] = [];
    for (let i = 0; i < insertStockActions.length; i++) {
      if (usedInsertActions.has(i)) continue;
      const insertTime = insertStockActions[i].start || 0;
      if (insertTime >= segStart && insertTime < segEnd) {
        insertsInSegment.push({ action: insertStockActions[i], index: i });
      }
    }
    
    insertsInSegment.sort((a, b) => (a.action.start || 0) - (b.action.start || 0));

    let currentStart = segStart;
    
    for (const insert of insertsInSegment) {
      const insertTime = insert.action.start || 0;
      usedInsertActions.add(insert.index);
      
      // Add video segment before the insert point
      if (insertTime > currentStart) {
        const duration = insertTime - currentStart;
        const overlays = textOverlayActions
          .filter(a => {
            const oStart = a.start || 0;
            return oStart >= currentStart && oStart < insertTime;
          })
          .map(a => ({
            text: a.text || "",
            startOffset: (a.start || 0) - currentStart,
            endOffset: Math.min((a.end || (a.start || 0) + 3), insertTime) - currentStart,
          }));

        timeline.push({
          type: "video",
          sourceStart: currentStart,
          sourceEnd: insertTime,
          outputStart: outputTime,
          outputDuration: duration,
          textOverlays: overlays.length > 0 ? overlays : undefined,
        });
        outputTime += duration;
      }
      
      // Add B-roll at insert point
      if (stockMediaIndex < downloadedStockMedia.length) {
        const brollDuration = insert.action.end && insert.action.start 
          ? insert.action.end - insert.action.start 
          : 3;
        const actualDuration = Math.min(brollDuration, downloadedStockMedia[stockMediaIndex].item.duration || 5);
        
        timeline.push({
          type: "broll",
          stockMedia: downloadedStockMedia[stockMediaIndex],
          brollDuration: actualDuration,
          brollText: insert.action.text,
          outputStart: outputTime,
          outputDuration: actualDuration,
        });
        outputTime += actualDuration;
        stockMediaIndex++;
      }
      
      currentStart = insertTime;
    }
    
    // Add remaining video segment after last insert
    if (currentStart < segEnd) {
      const duration = segEnd - currentStart;
      const overlays = textOverlayActions
        .filter(a => {
          const oStart = a.start || 0;
          return oStart >= currentStart && oStart < segEnd;
        })
        .map(a => ({
          text: a.text || "",
          startOffset: (a.start || 0) - currentStart,
          endOffset: Math.min((a.end || (a.start || 0) + 3), segEnd) - currentStart,
        }));

      timeline.push({
        type: "video",
        sourceStart: currentStart,
        sourceEnd: segEnd,
        outputStart: outputTime,
        outputDuration: duration,
        textOverlays: overlays.length > 0 ? overlays : undefined,
      });
      outputTime += duration;
    }
  }

  // Distribute remaining stock media between video segments
  if (options.addBroll && stockMediaIndex < downloadedStockMedia.length) {
    const remainingStock = downloadedStockMedia.slice(stockMediaIndex);
    const videoEntries = timeline.filter(e => e.type === "video");
    
    if (videoEntries.length > 1 && remainingStock.length > 0) {
      const insertGap = Math.floor(videoEntries.length / (remainingStock.length + 1));
      let insertCount = 0;
      let outputOffset = 0;
      
      for (let i = 0; i < remainingStock.length && insertGap > 0; i++) {
        const insertAfterIndex = (i + 1) * insertGap + insertCount;
        if (insertAfterIndex < timeline.length) {
          const brollDuration = Math.min(3, remainingStock[i].item.duration || 5);
          timeline.splice(insertAfterIndex, 0, {
            type: "broll",
            stockMedia: remainingStock[i],
            brollDuration,
            outputStart: 0, // Will be recalculated
            outputDuration: brollDuration,
          });
          insertCount++;
          outputOffset += brollDuration;
        }
      }
      
      // Recalculate output times
      let recalcTime = 0;
      for (const entry of timeline) {
        entry.outputStart = recalcTime;
        recalcTime += entry.outputDuration || 0;
      }
    }
  }

  console.log(`Timeline built with ${timeline.length} entries, total output duration: ${outputTime.toFixed(2)}s`);
  for (let i = 0; i < timeline.length; i++) {
    const e = timeline[i];
    if (e.type === "video") {
      console.log(`  [${i}] VIDEO: src ${e.sourceStart?.toFixed(2)}s-${e.sourceEnd?.toFixed(2)}s -> out ${e.outputStart?.toFixed(2)}s`);
    } else {
      console.log(`  [${i}] BROLL: ${e.stockMedia?.item.type} ${e.brollDuration}s -> out ${e.outputStart?.toFixed(2)}s`);
    }
  }

  // Build adjusted captions based on output timeline
  // Map original captions to output timeline based on which video segments they fall into
  const adjustedCaptions: { start: number; end: number; text: string }[] = [];
  
  if (options.addCaptions) {
    const allOriginalCaptions = [
      ...transcript,
      ...captionActions.map(a => ({
        start: a.start || 0,
        end: a.end || (a.start || 0) + 3,
        text: a.text || ""
      }))
    ];
    
    for (const cap of allOriginalCaptions) {
      // Find which video segment(s) this caption falls into
      for (const entry of timeline) {
        if (entry.type !== "video" || entry.sourceStart === undefined || entry.sourceEnd === undefined) continue;
        
        // Check if caption overlaps with this video segment
        const capStart = cap.start;
        const capEnd = cap.end;
        const segStart = entry.sourceStart;
        const segEnd = entry.sourceEnd;
        
        if (capEnd <= segStart || capStart >= segEnd) continue;
        
        // Caption overlaps with this segment - adjust times
        const overlapStart = Math.max(capStart, segStart);
        const overlapEnd = Math.min(capEnd, segEnd);
        
        const offsetFromSegmentStart = overlapStart - segStart;
        const adjustedStart = (entry.outputStart || 0) + offsetFromSegmentStart;
        const adjustedEnd = adjustedStart + (overlapEnd - overlapStart);
        
        adjustedCaptions.push({
          start: adjustedStart,
          end: adjustedEnd,
          text: cap.text
        });
      }
    }
    
    console.log(`Adjusted ${adjustedCaptions.length} captions for output timeline`);
  }

  // Simple path: single video segment with no modifications
  if (timeline.length === 1 && timeline[0].type === "video" && !timeline[0].textOverlays && adjustedCaptions.length === 0) {
    const entry = timeline[0];
    const segStart = entry.sourceStart || 0;
    const segEnd = entry.sourceEnd || metadata.duration;
    
    console.log(`Simple path: single segment ${segStart}s to ${segEnd}s`);
    
    await new Promise<void>((resolve, reject) => {
      ffmpeg(videoPath)
        .setStartTime(segStart)
        .setDuration(segEnd - segStart)
        .outputOptions([
          "-c:v", "libx264",
          "-preset", "ultrafast",
          "-crf", "28",
          "-c:a", "aac",
          "-b:a", "96k",
          "-max_muxing_queue_size", "1024",
          "-threads", "2",
        ])
        .output(outputPath)
        .on("end", () => resolve())
        .on("error", (err) => reject(err))
        .run();
    });
    
    for (const tempPath of tempFiles) {
      await fs.unlink(tempPath).catch(() => {});
    }
    
    return outputPath;
  }

  // Render each timeline entry
  const segmentPaths: string[] = [];
  
  for (let i = 0; i < timeline.length; i++) {
    const entry = timeline[i];
    const segmentPath = path.join(OUTPUT_DIR, `segment_${outputId}_${i}.mp4`);
    
    console.log(`Rendering timeline entry ${i}: ${entry.type}`);
    
    try {
      if (entry.type === "video") {
        const start = entry.sourceStart || 0;
        const duration = (entry.sourceEnd || metadata.duration) - start;
        
        await createVideoSegment(
          videoPath,
          segmentPath,
          start,
          duration,
          entry.textOverlays
        );
      } else if (entry.type === "broll" && entry.stockMedia) {
        const brollDuration = entry.brollDuration || 3;
        
        if (entry.stockMedia.item.type === "video") {
          await createVideoBroll(
            entry.stockMedia.localPath,
            segmentPath,
            brollDuration,
            metadata.width,
            metadata.height,
            entry.brollText
          );
        } else {
          await createImageBroll(
            entry.stockMedia.localPath,
            segmentPath,
            brollDuration,
            metadata.width,
            metadata.height,
            entry.brollText
          );
        }
      }
      
      segmentPaths.push(segmentPath);
      tempFiles.push(segmentPath);
      console.log(`Segment ${i} created`);
    } catch (err) {
      console.error(`Failed to create segment ${i}:`, err);
    }
  }

  if (segmentPaths.length === 0) {
    throw new Error("No segments were created");
  }

  // Concatenate segments and track transition overlaps
  let concatenatedPath: string;
  let totalTransitionOverlap = 0;
  
  if (transitionActions.length > 0 && segmentPaths.length >= 2) {
    console.log(`Applying transitions between ${segmentPaths.length} segments`);
    
    try {
      let currentPath = segmentPaths[0];
      
      for (let i = 1; i < segmentPaths.length; i++) {
        const transitionAction = transitionActions[Math.min(i - 1, transitionActions.length - 1)];
        const transitionType = transitionAction?.transitionType || "fade";
        const transitionedPath = path.join(OUTPUT_DIR, `trans_${outputId}_${i}.mp4`);
        const transitionDuration = 0.5;
        
        const actualDuration = await concatTwoWithTransition(
          currentPath,
          segmentPaths[i],
          transitionedPath,
          transitionType,
          transitionDuration
        );
        
        totalTransitionOverlap += actualDuration;
        tempFiles.push(transitionedPath);
        currentPath = transitionedPath;
        console.log(`Transition ${i} applied: ${transitionType}, overlap: ${actualDuration}s`);
      }
      
      concatenatedPath = currentPath;
      console.log(`Total transition overlap: ${totalTransitionOverlap}s`);
    } catch (err) {
      console.error(`Transitions failed, falling back to simple concat:`, err);
      concatenatedPath = path.join(OUTPUT_DIR, `concat_${outputId}.mp4`);
      await concatSegmentsSimple(segmentPaths, concatenatedPath);
      tempFiles.push(concatenatedPath);
      totalTransitionOverlap = 0;
    }
  } else {
    console.log(`Concatenating ${segmentPaths.length} segments`);
    concatenatedPath = path.join(OUTPUT_DIR, `concat_${outputId}.mp4`);
    await concatSegmentsSimple(segmentPaths, concatenatedPath);
    tempFiles.push(concatenatedPath);
  }

  // Adjust captions for transition overlaps if any
  // Each transition after segment N reduces the timeline for captions in segments N+1 and later
  if (totalTransitionOverlap > 0 && adjustedCaptions.length > 0) {
    console.log(`Adjusting ${adjustedCaptions.length} captions for ${totalTransitionOverlap}s of transition overlap`);
    
    // Calculate cumulative segment durations to know which captions to adjust
    let cumulativeDuration = 0;
    const segmentBoundaries: number[] = [];
    for (const entry of timeline) {
      cumulativeDuration += entry.outputDuration || 0;
      segmentBoundaries.push(cumulativeDuration);
    }
    
    // For simplicity in prototype: distribute overlap evenly across all captions after first segment
    // More accurate: track per-transition overlap and adjust per-segment
    const numTransitions = segmentPaths.length - 1;
    const overlapPerTransition = totalTransitionOverlap / numTransitions;
    
    for (const cap of adjustedCaptions) {
      // Find which segment this caption starts in
      let segmentIndex = 0;
      for (let i = 0; i < segmentBoundaries.length; i++) {
        if (cap.start < segmentBoundaries[i]) {
          segmentIndex = i;
          break;
        }
        segmentIndex = i + 1;
      }
      
      // Subtract cumulative overlap for all transitions before this segment
      const transitionsBefore = Math.min(segmentIndex, numTransitions);
      const overlapToSubtract = transitionsBefore * overlapPerTransition;
      
      cap.start = Math.max(0, cap.start - overlapToSubtract);
      cap.end = Math.max(cap.start + 0.5, cap.end - overlapToSubtract);
    }
  }

  // Apply captions to final video if we have any
  if (adjustedCaptions.length > 0) {
    console.log(`Burning ${adjustedCaptions.length} captions into final video`);
    
    const srtPath = path.join(OUTPUT_DIR, `${outputId}.srt`);
    const srtContent = generateSrtContent(adjustedCaptions);
    await fs.writeFile(srtPath, srtContent);
    tempFiles.push(srtPath);
    
    await burnSubtitles(concatenatedPath, outputPath, srtPath);
  } else {
    await fs.copyFile(concatenatedPath, outputPath);
  }

  // Cleanup temp files
  for (const tempPath of tempFiles) {
    await fs.unlink(tempPath).catch(() => {});
  }

  console.log("=== APPLY EDITS COMPLETE ===");
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
