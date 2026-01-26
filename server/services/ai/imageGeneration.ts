import { withRetry, AI_RETRY_OPTIONS } from "../../utils/retry";
import { createLogger } from "../../utils/logger";
import { getGeminiClient } from "./clients";
import { AI_CONFIG } from "../../config/ai";
import type { VideoContext, SemanticAnalysis } from "@shared/schema";

const aiLogger = createLogger("ai-service");

export interface GeneratedAiImage {
  prompt: string;
  base64Data: string;
  mimeType: string;
  startTime: number;
  endTime: number;
  duration: number;
  context: string;
}

export async function generateAiImage(
  prompt: string,
  videoContext?: VideoContext
): Promise<{ base64Data: string; mimeType: string }> {
  try {
    const contextualPrompt = videoContext 
      ? `Create a UHD, cinematic, high-quality image suitable for ${videoContext.genre} video content with a ${videoContext.tone} tone. 
         The image should visually represent: ${prompt}
       Use realistic lighting, natural depth of field, strong composition, and emotionally appropriate atmosphere.
       Style: Professional, cinematic realism, documentary-grade, clean and context-aware.
       Must look authentic, timeless, and suitable for high-quality B-roll usage.
       No text, subtitles, logos, symbols, watermarks, UI elements, or graphic overlays.`
    : `Create a UHD, cinematic, professional-quality image representing: ${prompt}.
       Use realistic lighting, clear subject focus, natural depth, and balanced composition.
       Style: Clean, cinematic realism suitable for generic AI B-roll footage.
       No text, subtitles, logos, watermarks, or graphic overlays.`;

    aiLogger.debug(`Generating AI image with prompt: ${contextualPrompt.substring(0, 100)}...`);
    
    const response = await withRetry(
      () => getGeminiClient().models.generateContent({
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
      AI_RETRY_OPTIONS
    );

    const candidate = response.candidates?.[0];
    const imagePart = candidate?.content?.parts?.find(
      (part: { inlineData?: { data?: string; mimeType?: string } }) => part.inlineData
    );

    if (!imagePart?.inlineData?.data) {
      const error = new Error("No image data in AI generation response - the model may have failed to generate an image");
      aiLogger.error("AI image generation failed: no image data in response");
      throw error;
    }

    const mimeType = imagePart.inlineData.mimeType || "image/png";
    aiLogger.debug(`AI image generated successfully: ${mimeType}`);
    
    return {
      base64Data: imagePart.inlineData.data,
      mimeType,
    };
  } catch (error) {
    aiLogger.error("AI image generation error:", error);
    throw error;
  }
}

export async function generateAiImagesForVideo(
  semanticAnalysis: SemanticAnalysis,
  videoContext?: VideoContext,
  maxImages: number = 3,
  videoDuration?: number
): Promise<GeneratedAiImage[]> {
  const generatedImages: GeneratedAiImage[] = [];
  
  const validCandidates = semanticAnalysis.brollWindows
    .filter(w => {
      if (typeof w.start !== "number" || typeof w.end !== "number") {
        aiLogger.warn(`Rejecting AI image candidate: missing start/end time - ${w.suggestedQuery}`);
        return false;
      }
      if (w.start < 0 || w.end <= w.start) {
        aiLogger.warn(`Rejecting AI image candidate: invalid timing (${w.start}s-${w.end}s) - ${w.suggestedQuery}`);
        return false;
      }
      return true;
    })
    .sort((a, b) => a.start - b.start);
  
  aiLogger.debug(`Valid B-roll candidates: ${validCandidates.length}/${semanticAnalysis.brollWindows.length}`);
  
  let aiImageCandidates: typeof validCandidates;
  
  if (validCandidates.length <= maxImages) {
    aiImageCandidates = validCandidates;
  } else if (videoDuration && videoDuration > 0) {
    const segmentDuration = videoDuration / maxImages;
    aiImageCandidates = [];
    
    for (let i = 0; i < maxImages; i++) {
      const segmentStart = i * segmentDuration;
      const segmentEnd = (i + 1) * segmentDuration;
      
      const segmentCandidates = validCandidates.filter(c => 
        c.start >= segmentStart && c.start < segmentEnd
      );
      
      if (segmentCandidates.length > 0) {
        const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
        const best = segmentCandidates.sort((a, b) => 
          (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1)
        )[0];
        aiImageCandidates.push(best);
      } else {
        const unusedCandidates = validCandidates.filter(c => 
          !aiImageCandidates.includes(c) && 
          Math.abs(c.start - (segmentStart + segmentDuration / 2)) < segmentDuration
        );
        if (unusedCandidates.length > 0) {
          aiImageCandidates.push(unusedCandidates[0]);
        }
      }
    }
    
    aiImageCandidates.sort((a, b) => a.start - b.start);
  } else {
    const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
    aiImageCandidates = validCandidates
      .sort((a, b) => (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1))
      .slice(0, maxImages);
  }

  aiLogger.debug(`AI Image candidates after selection: ${aiImageCandidates.length} (targeting ${maxImages})`);

  // Parallel generation with controlled concurrency
  const CONCURRENCY_LIMIT = 3; // Limit parallel requests to avoid rate limiting
  const errors: { candidate: typeof aiImageCandidates[0]; error: Error }[] = [];
  
  // Process in batches for controlled parallelism
  for (let batchStart = 0; batchStart < aiImageCandidates.length; batchStart += CONCURRENCY_LIMIT) {
    const batch = aiImageCandidates.slice(batchStart, batchStart + CONCURRENCY_LIMIT);
    
    aiLogger.debug(`Processing AI image batch ${Math.floor(batchStart / CONCURRENCY_LIMIT) + 1}/${Math.ceil(aiImageCandidates.length / CONCURRENCY_LIMIT)} (${batch.length} images)`);
    
    // Generate images in parallel within the batch
    const batchResults = await Promise.allSettled(
      batch.map(async (candidate) => {
        const imagePrompt = `${candidate.suggestedQuery}. Context: ${candidate.context}`;
        const result = await generateAiImage(imagePrompt, videoContext);
        
        return {
          prompt: candidate.suggestedQuery,
          base64Data: result.base64Data,
          mimeType: result.mimeType,
          startTime: candidate.start,
          endTime: candidate.end,
          duration: Math.min(candidate.end - candidate.start, 5),
          context: candidate.context,
        } as GeneratedAiImage;
      })
    );
    
    // Process batch results
    for (let i = 0; i < batchResults.length; i++) {
      const result = batchResults[i];
      const candidate = batch[i];
      
      if (result.status === 'fulfilled') {
        generatedImages.push(result.value);
      } else {
        const err = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
        errors.push({ candidate, error: err });
        aiLogger.warn(`Failed to generate AI image for: "${candidate.suggestedQuery.substring(0, 50)}..." - ${err.message}`);
      }
    }
  }

  const successCount = generatedImages.length;
  const failureCount = errors.length;
  
  if (failureCount > 0) {
    aiLogger.warn(`AI image generation: ${successCount}/${aiImageCandidates.length} succeeded, ${failureCount} failed`);
  }
  
  // Only throw if ALL images failed AND we had candidates
  if (aiImageCandidates.length > 0 && generatedImages.length === 0) {
    const aggregateError = new Error(
      `All ${failureCount} AI image generation attempts failed. First error: ${errors[0]?.error?.message || 'Unknown error'}`
    );
    aiLogger.error("All AI image generation attempts failed", aggregateError);
    // Don't throw - return empty array to allow video processing to continue without AI images
    aiLogger.warn("Continuing without AI images - video will use stock media only");
    return [];
  }

  aiLogger.info(`Generated ${generatedImages.length} AI images for video (${failureCount} failures, continuing with partial success)`);
  return generatedImages;
}
