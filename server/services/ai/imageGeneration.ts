import { withRetry, AI_RETRY_OPTIONS } from "../../utils/retry";
import { createLogger } from "../../utils/logger";
import { getGeminiClient } from "./clients";
import { AI_CONFIG } from "../../config/ai";
import type { VideoContext, SemanticAnalysis } from "@shared/schema";
import fs from "fs/promises";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { STOCK_DIR } from "../../config/paths";
import { fileStorage } from "../fileStorage";

const aiLogger = createLogger("ai-service");

export interface GeneratedAiImage {
  prompt: string;
  filePath: string; // Changed from base64Data to filePath for memory optimization
  mimeType: string;
  startTime: number;
  endTime: number;
  duration: number;
  context: string;
  animationPreset?: string;
}

export async function generateAiImage(
  prompt: string,
  videoContext?: VideoContext,
): Promise<{ filePath: string; mimeType: string }> {
  try {
    // Sanitize prompt to remove conflicting style instructions that could break consistency
    const sanitizedPrompt = prompt
      .replace(/\b(abstract|digital animation|cartoon|animated|illustration|graphic design|3d render|cgi|vector|stylized|anime|pixel art)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    const contextualPrompt = videoContext
      ? `Create a UHD, cinematic, high-quality PHOTOREALISTIC image suitable for ${videoContext.genre} video content with a ${videoContext.tone} tone. 
         The image should visually represent: ${sanitizedPrompt}
       CRITICAL STYLE REQUIREMENTS (override any conflicting instructions):
       - MUST be photorealistic - no abstract, digital, animated, or illustrated styles
       - Use realistic lighting, natural depth of field, strong composition, and emotionally appropriate atmosphere
       - Style: Professional, cinematic realism, documentary-grade, clean and context-aware
       - Must look authentic, timeless, and suitable for high-quality B-roll usage
       - Consistent with other images in the same video project
       No text, subtitles, logos, symbols, watermarks, UI elements, or graphic overlays.`
      : `Create a UHD, cinematic, professional-quality PHOTOREALISTIC image representing: ${sanitizedPrompt}.
       CRITICAL STYLE REQUIREMENTS (override any conflicting instructions):
       - MUST be photorealistic - no abstract, digital, animated, or illustrated styles
       - Use realistic lighting, clear subject focus, natural depth, and balanced composition
       - Style: Clean, cinematic realism suitable for generic AI B-roll footage
       No text, subtitles, logos, watermarks, or graphic overlays.`;

    aiLogger.debug(
      `Generating AI image with prompt: ${contextualPrompt.substring(0, 100)}...`,
    );

    const response = await withRetry(
      () =>
        getGeminiClient().models.generateContent({
          model: AI_CONFIG.models.imageGeneration,
          contents: [
            {
              role: "user",
              parts: [{ text: contextualPrompt }],
            },
          ],
          config: {
            responseModalities: ["TEXT", "IMAGE"],
          },
        }),
      "generateAiImage",
      AI_RETRY_OPTIONS,
    );

    const candidate = response.candidates?.[0];
    const imagePart = candidate?.content?.parts?.find(
      (part: { inlineData?: { data?: string; mimeType?: string } }) =>
        part.inlineData,
    );

    if (!imagePart?.inlineData?.data) {
      const error = new Error(
        "No image data in AI generation response - the model may have failed to generate an image",
      );
      aiLogger.error("AI image generation failed: no image data in response");
      throw error;
    }

    const base64Data = imagePart.inlineData.data;
    const mimeType = imagePart.inlineData.mimeType || "image/png";

    // Validate base64 data
    if (typeof base64Data !== "string" || base64Data.length === 0) {
      throw new Error("AI image generation returned empty or invalid base64 data");
    }

    // Validate mime type (only allow image types)
    const allowedMimeTypes = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
    if (!allowedMimeTypes.includes(mimeType.toLowerCase())) {
      aiLogger.warn(`AI image has unexpected mime type: ${mimeType}, defaulting to image/png`);
    }

    // Decode and save to file immediately to free memory
    const buffer = Buffer.from(base64Data, "base64");

    // Ensure STOCK_DIR exists
    await fs.mkdir(STOCK_DIR, { recursive: true });

    const ext = mimeType.split('/')[1] || 'png';
    const filename = `ai_gen_${uuidv4()}.${ext}`;
    const filePath = path.join(STOCK_DIR, filename);

    await fs.writeFile(filePath, buffer);

    // Upload to persistent storage (if configured)
    try {
      await fileStorage.uploadFile(filePath, `stock/${filename}`, {
        contentType: mimeType,
        originalName: filename,
      });
      aiLogger.info(`Synced AI image to storage: stock/${filename}`);
    } catch (storageError) {
      aiLogger.warn(`Failed to sync AI image to storage (non-critical): ${storageError}`);
    }

    aiLogger.debug(`AI image generated and saved: ${filePath}, size: ${(buffer.length / 1024).toFixed(1)}KB`);

    return {
      filePath, // Return path instead of data
      mimeType: allowedMimeTypes.includes(mimeType.toLowerCase()) ? mimeType : "image/png",
    };
  } catch (error) {
    aiLogger.error("AI image generation error:", error);
    throw error;
  }
}

export async function generateAiImagesForVideo(
  semanticAnalysis: SemanticAnalysis,
  videoContext?: VideoContext,
  videoDuration?: number,
  explicitBrollWindows?: Array<{ start: number; end: number; suggestedQuery: string; priority?: string; context?: string }>,
): Promise<GeneratedAiImage[]> {
  // No limits - AI decides how many images to generate based on content analysis
  aiLogger.info(
    `AI image generation: no limit (AI decides based on content, duration=${videoDuration}s)`,
  );

  const generatedImages: GeneratedAiImage[] = [];

  // Use explicit B-roll windows from edit plan if provided, otherwise fall back to semantic analysis
  const sourceWindows = explicitBrollWindows && explicitBrollWindows.length > 0
    ? explicitBrollWindows
    : semanticAnalysis.brollWindows;

  aiLogger.debug(`Using ${explicitBrollWindows?.length || 0} explicit windows, ${semanticAnalysis.brollWindows?.length || 0} semantic windows`);

  // Use all valid B-roll windows - no slicing or limiting
  const validCandidates = sourceWindows
    .filter((w) => {
      if (typeof w.start !== "number" || typeof w.end !== "number") {
        aiLogger.warn(
          `Rejecting AI image candidate: missing start/end time - ${w.suggestedQuery}`,
        );
        return false;
      }
      if (w.start < 0 || w.end <= w.start) {
        aiLogger.warn(
          `Rejecting AI image candidate: invalid timing (${w.start}s-${w.end}s) - ${w.suggestedQuery}`,
        );
        return false;
      }
      return true;
    })
    .sort((a, b) => a.start - b.start);

  aiLogger.info(
    `AI decided: ${validCandidates.length} B-roll windows for AI image generation`,
  );

  // Use all valid candidates - AI already decided the count based on content
  const aiImageCandidates = validCandidates;

  aiLogger.debug(
    `AI Image candidates: ${aiImageCandidates.length} (AI-determined based on content)`,
  );

  // Parallel generation with controlled concurrency
  const CONCURRENCY_LIMIT = 5; // Limit parallel requests to avoid rate limiting
  const errors: { candidate: (typeof aiImageCandidates)[0]; error: Error }[] =
    [];

  // Process in batches for controlled parallelism
  for (
    let batchStart = 0;
    batchStart < aiImageCandidates.length;
    batchStart += CONCURRENCY_LIMIT
  ) {
    const batch = aiImageCandidates.slice(
      batchStart,
      batchStart + CONCURRENCY_LIMIT,
    );

    aiLogger.debug(
      `Processing AI image batch ${Math.floor(batchStart / CONCURRENCY_LIMIT) + 1}/${Math.ceil(aiImageCandidates.length / CONCURRENCY_LIMIT)} (${batch.length} images)`,
    );

    // Generate images in parallel within the batch
    const batchResults = await Promise.allSettled(
      batch.map(async (candidate) => {
        const imagePrompt = `${candidate.suggestedQuery}. Context: ${candidate.context}`;
        const result = await generateAiImage(imagePrompt, videoContext);

        return {
          prompt: candidate.suggestedQuery,
          filePath: result.filePath, // Use filePath
          mimeType: result.mimeType,
          startTime: candidate.start,
          endTime: candidate.end,
          duration: Math.min(candidate.end - candidate.start, 5),
          context: candidate.context,
        } as GeneratedAiImage;
      }),
    );

    // Process batch results
    for (let i = 0; i < batchResults.length; i++) {
      const result = batchResults[i];
      const candidate = batch[i];

      if (result.status === "fulfilled") {
        generatedImages.push(result.value);
      } else {
        const err =
          result.reason instanceof Error
            ? result.reason
            : new Error(String(result.reason));
        errors.push({ candidate, error: err });
        aiLogger.warn(
          `Failed to generate AI image for: "${candidate.suggestedQuery.substring(0, 50)}..." - ${err.message}`,
        );
      }
    }
  }

  const successCount = generatedImages.length;
  const failureCount = errors.length;

  if (failureCount > 0) {
    aiLogger.warn(
      `AI image generation: ${successCount}/${aiImageCandidates.length} succeeded, ${failureCount} failed`,
    );
  }

  // Only throw if ALL images failed AND we had candidates
  if (aiImageCandidates.length > 0 && generatedImages.length === 0) {
    const aggregateError = new Error(
      `All ${failureCount} AI image generation attempts failed. First error: ${errors[0]?.error?.message || "Unknown error"}`,
    );
    aiLogger.error("All AI image generation attempts failed", aggregateError);
    // Don't throw - return empty array to allow video processing to continue without AI images
    aiLogger.warn(
      "Continuing without AI images - video will use stock media only",
    );
    return [];
  }

  aiLogger.info(
    `Generated ${generatedImages.length} AI images for video (${failureCount} failures, continuing with partial success)`,
  );
  return generatedImages;
}
