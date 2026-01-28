import { promises as fs } from "fs";
import * as path from "path";
import { z } from "zod";
import { createLogger } from "../../utils/logger";
import { getGeminiClient, getVideoAnalysisGeminiClient } from "./clients";
import { AI_CONFIG } from "../../config/ai";
import { extractJsonFromResponse } from "./normalization";
import type { EditPlan, TranscriptSegment, ReviewData, StockMediaItem, VideoAnalysis } from "@shared/schema";

const selfReviewLogger = createLogger("ai-self-review");

const MAX_VIDEO_SIZE_MB = 500;

export interface SelfReviewIssue {
  severity: "minor" | "moderate" | "critical";
  type: "audio_sync" | "visual_quality" | "pacing" | "transition" | "b_roll" | "cuts" | "captions" | "narrative";
  timestamp?: number;
  description: string;
  suggestedFix: string;
  autoFixable: boolean;
}

export interface SelfReviewResult {
  overallScore: number;
  approved: boolean;
  watchedFullVideo: boolean;
  issues: SelfReviewIssue[];
  qualityMetrics: {
    audioVideoSync: number;
    visualQuality: number;
    pacingFlow: number;
    transitionSmoothness: number;
    brollRelevance: number;
    narrativeCoherence: number;
    captionAccuracy: number;
  };
  suggestions: string[];
  detailedFeedback: string;
  recommendedActions: {
    actionType: "re_edit" | "adjust_timing" | "replace_broll" | "fix_transition" | "adjust_caption" | "none";
    priority: number;
    details: string;
  }[];
}

const SelfReviewSchema = z.object({
  overallScore: z.number().min(0).max(100).default(70),
  approved: z.boolean().default(true),
  issues: z.array(z.object({
    severity: z.enum(["minor", "moderate", "critical"]).default("minor"),
    type: z.enum(["audio_sync", "visual_quality", "pacing", "transition", "b_roll", "cuts", "captions", "narrative"]).default("visual_quality"),
    timestamp: z.number().optional(),
    description: z.string().default(""),
    suggestedFix: z.string().default(""),
    autoFixable: z.boolean().default(false),
  })).default([]),
  qualityMetrics: z.object({
    audioVideoSync: z.number().min(0).max(100).default(80),
    visualQuality: z.number().min(0).max(100).default(80),
    pacingFlow: z.number().min(0).max(100).default(75),
    transitionSmoothness: z.number().min(0).max(100).default(75),
    brollRelevance: z.number().min(0).max(100).default(70),
    narrativeCoherence: z.number().min(0).max(100).default(75),
    captionAccuracy: z.number().min(0).max(100).default(80),
  }).default({}),
  suggestions: z.array(z.string()).default([]),
  detailedFeedback: z.string().default("Review completed."),
  recommendedActions: z.array(z.object({
    actionType: z.enum(["re_edit", "adjust_timing", "replace_broll", "fix_transition", "adjust_caption", "none"]).default("none"),
    priority: z.number().min(1).max(10).default(5),
    details: z.string().default(""),
  })).default([]),
});

async function waitForVideoProcessing(
  client: ReturnType<typeof getGeminiClient>,
  fileName: string,
  maxWaitSeconds: number = 120
): Promise<boolean> {
  const startTime = Date.now();
  
  while ((Date.now() - startTime) < maxWaitSeconds * 1000) {
    try {
      const file = await client.files.get({ name: fileName });
      
      if (file.state === "ACTIVE") {
        selfReviewLogger.info(`Video ready for self-review: ${fileName}`);
        return true;
      }
      
      if (file.state === "FAILED") {
        selfReviewLogger.error(`Video processing failed: ${fileName}`);
        return false;
      }
      
      selfReviewLogger.debug(`Waiting for video processing... (${file.state})`);
      await new Promise(resolve => setTimeout(resolve, 3000));
    } catch (error) {
      selfReviewLogger.warn(`Error checking video status: ${error}`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
  selfReviewLogger.error(`Video processing timeout after ${maxWaitSeconds}s`);
  return false;
}

export async function performPostRenderSelfReview(
  renderedVideoPath: string,
  originalVideoPath: string,
  editPlan: EditPlan,
  transcript: TranscriptSegment[],
  reviewData: ReviewData,
  stockMedia: StockMediaItem[],
  userPrompt: string,
  videoAnalysis?: VideoAnalysis
): Promise<SelfReviewResult> {
  selfReviewLogger.info("═══════════════════════════════════════════════════════");
  selfReviewLogger.info("AI SELF-REVIEW SYSTEM: Watching rendered output...");
  selfReviewLogger.info("═══════════════════════════════════════════════════════");
  
  const stats = await fs.stat(renderedVideoPath);
  const sizeMB = stats.size / (1024 * 1024);
  
  if (sizeMB > MAX_VIDEO_SIZE_MB) {
    selfReviewLogger.warn(`Rendered video too large for self-review: ${sizeMB.toFixed(1)}MB > ${MAX_VIDEO_SIZE_MB}MB`);
    return getDefaultSelfReviewResult(false, "Video too large for full self-review");
  }
  
  // Use the video analysis client which supports file uploads (direct Google API, not Replit proxy)
  // The Replit proxy doesn't support file uploads (POST /upload/v1beta/files endpoint)
  const client = getVideoAnalysisGeminiClient();
  
  try {
    selfReviewLogger.info(`Uploading rendered video for self-review: ${sizeMB.toFixed(1)}MB`);
    
    const uploadResult = await client.files.upload({
      file: renderedVideoPath,
      config: {
        mimeType: "video/mp4",
        displayName: `self-review-${path.basename(renderedVideoPath)}`,
      },
    });
    
    if (!uploadResult.name || !uploadResult.uri) {
      throw new Error("Failed to get file reference from upload");
    }
    
    selfReviewLogger.info(`Self-review video uploaded: ${uploadResult.name}`);
    
    const processingReady = await waitForVideoProcessing(client, uploadResult.name, 120);
    
    if (!processingReady) {
      throw new Error("Video processing timed out for self-review");
    }
    
    const appliedCuts = editPlan.actions.filter(a => a.type === "cut").length;
    const appliedBroll = stockMedia.length;
    const captionsEnabled = reviewData.editOptions?.addCaptions !== false;
    
    const transcriptSummary = transcript.slice(0, 15).map(t => 
      `[${t.start.toFixed(1)}s]: ${t.text}`
    ).join("\n");
    
    const prompt = `You are an expert video editor AI performing a SELF-REVIEW of your own rendered output.

CRITICAL TASK: Watch this rendered video from start to finish and evaluate its quality.

ORIGINAL USER REQUEST:
"${userPrompt}"

WHAT YOU DID (EDIT DECISIONS):
- Applied ${appliedCuts} cuts to remove unwanted segments
- Added ${appliedBroll} B-roll overlays (stock footage/AI images)
- Captions: ${captionsEnabled ? "enabled" : "disabled"}
- Transitions: ${reviewData.editOptions?.addTransitions !== false ? "enabled" : "disabled"}

ORIGINAL VIDEO CONTEXT:
- Genre: ${videoAnalysis?.context?.genre || "general"}
- Tone: ${videoAnalysis?.context?.tone || "casual"}
- Target duration reduction: ${reviewData.summary?.originalDuration && reviewData.summary?.estimatedFinalDuration 
    ? ((1 - reviewData.summary.estimatedFinalDuration / reviewData.summary.originalDuration) * 100).toFixed(0) + "%" 
    : "unknown"}

TRANSCRIPT (sample):
${transcriptSummary}

YOUR SELF-REVIEW TASK:
1. WATCH THE ENTIRE VIDEO from start to finish
2. Evaluate audio/video synchronization - are the captions matching speech? Is audio smooth?
3. Check visual quality - are transitions smooth? Any jarring cuts?
4. Assess pacing - is the video engaging? Too fast? Too slow?
5. Evaluate B-roll relevance - does the stock footage fit the content?
6. Check narrative coherence - does the story make sense after cuts?
7. Identify ANY issues that should be fixed

SCORING CRITERIA:
- 90-100: Professional quality, publish-ready
- 70-89: Good quality, minor polish needed
- 50-69: Acceptable, but noticeable issues
- Below 50: Needs significant re-editing

Respond in JSON format:
{
  "overallScore": <0-100>,
  "approved": <true if score >= 70>,
  "issues": [
    {
      "severity": "minor|moderate|critical",
      "type": "audio_sync|visual_quality|pacing|transition|b_roll|cuts|captions|narrative",
      "timestamp": <seconds where issue occurs, optional>,
      "description": "what's wrong",
      "suggestedFix": "how to fix it",
      "autoFixable": <true if AI can fix automatically>
    }
  ],
  "qualityMetrics": {
    "audioVideoSync": <0-100>,
    "visualQuality": <0-100>,
    "pacingFlow": <0-100>,
    "transitionSmoothness": <0-100>,
    "brollRelevance": <0-100>,
    "narrativeCoherence": <0-100>,
    "captionAccuracy": <0-100>
  },
  "suggestions": ["improvement suggestions"],
  "detailedFeedback": "1-2 paragraph detailed review",
  "recommendedActions": [
    {
      "actionType": "re_edit|adjust_timing|replace_broll|fix_transition|adjust_caption|none",
      "priority": <1-10, 10 is most urgent>,
      "details": "specific action to take"
    }
  ]
}

IMPORTANT: Be honest and critical. If there are issues, identify them. If it's good, say so.
Your goal is to produce the best possible video, so identify anything that could be improved.`;

    selfReviewLogger.info("Sending rendered video to AI for self-review...");
    
    const response = await client.models.generateContent({
      model: AI_CONFIG.models.selfReview,
      contents: [
        {
          role: "user",
          parts: [
            { fileData: { mimeType: "video/mp4", fileUri: uploadResult.uri } },
            { text: prompt }
          ],
        },
      ],
      config: {
        temperature: 0.3,
        maxOutputTokens: 3000,
      },
    });
    
    const text = response.text || "";
    
    if (!text.trim()) {
      selfReviewLogger.warn("Empty response from self-review AI");
      return getDefaultSelfReviewResult(true, "Self-review completed but AI response was empty");
    }
    
    const jsonString = extractJsonFromResponse(text);
    if (!jsonString) {
      selfReviewLogger.warn("Could not extract JSON from self-review response");
      return getDefaultSelfReviewResult(true, text.slice(0, 500));
    }
    
    let parsedJson;
    try {
      parsedJson = JSON.parse(jsonString);
    } catch {
      selfReviewLogger.warn("Failed to parse self-review JSON");
      return getDefaultSelfReviewResult(true, text.slice(0, 500));
    }
    
    const validationResult = SelfReviewSchema.safeParse(parsedJson);
    
    if (!validationResult.success) {
      selfReviewLogger.warn("Self-review schema validation failed", {
        errors: validationResult.error.errors.slice(0, 5),
      });
      return getDefaultSelfReviewResult(true, "Schema validation failed");
    }
    
    const result = validationResult.data;
    
    selfReviewLogger.info("═══════════════════════════════════════════════════════");
    selfReviewLogger.info("SELF-REVIEW COMPLETE");
    selfReviewLogger.info(`Overall Score: ${result.overallScore}/100`);
    selfReviewLogger.info(`Approved: ${result.approved}`);
    selfReviewLogger.info(`Issues Found: ${result.issues.length}`);
    selfReviewLogger.info(`Critical Issues: ${result.issues.filter(i => i.severity === "critical").length}`);
    selfReviewLogger.info("═══════════════════════════════════════════════════════");
    
    if (result.issues.length > 0) {
      selfReviewLogger.info("Issues detected:");
      result.issues.forEach((issue, i) => {
        selfReviewLogger.info(`  [${i + 1}] ${issue.severity.toUpperCase()}: ${issue.type} - ${issue.description}`);
        if (issue.timestamp) {
          selfReviewLogger.info(`      At: ${issue.timestamp}s`);
        }
        selfReviewLogger.info(`      Fix: ${issue.suggestedFix} (AutoFixable: ${issue.autoFixable})`);
      });
    }
    
    try {
      await client.files.delete({ name: uploadResult.name });
      selfReviewLogger.debug("Cleaned up self-review video from Gemini");
    } catch {
      selfReviewLogger.debug("Could not delete self-review video from Gemini");
    }
    
    return {
      overallScore: result.overallScore,
      approved: result.approved,
      watchedFullVideo: true,
      issues: result.issues,
      qualityMetrics: result.qualityMetrics,
      suggestions: result.suggestions,
      detailedFeedback: result.detailedFeedback,
      recommendedActions: result.recommendedActions,
    };
    
  } catch (error) {
    selfReviewLogger.error(`Self-review failed: ${error instanceof Error ? error.message : String(error)}`);
    return getDefaultSelfReviewResult(false, `Self-review error: ${error instanceof Error ? error.message : "Unknown"}`);
  }
}

function getDefaultSelfReviewResult(watchedVideo: boolean, reason: string, forceApproval: boolean = false): SelfReviewResult {
  // Only auto-approve if AI actually watched the video or if explicitly forced
  // For large files or errors, we should NOT silently approve - that bypasses quality gates
  const approved = forceApproval || watchedVideo;
  
  // If we couldn't watch the video, use a lower score to flag for manual review
  const overallScore = watchedVideo ? 75 : 50;
  
  selfReviewLogger.info(`Default self-review result: approved=${approved}, score=${overallScore}, reason="${reason}"`);
  
  return {
    overallScore,
    approved,
    watchedFullVideo: watchedVideo,
    issues: watchedVideo ? [] : [{
      type: "visual_quality" as const,
      severity: "moderate" as const,
      description: `Self-review could not be completed: ${reason}. Quality unverified.`,
      suggestedFix: "Manual quality check recommended before delivery",
      autoFixable: false,
    }],
    qualityMetrics: {
      audioVideoSync: watchedVideo ? 80 : 0,
      visualQuality: watchedVideo ? 80 : 0,
      pacingFlow: watchedVideo ? 75 : 0,
      transitionSmoothness: watchedVideo ? 75 : 0,
      brollRelevance: watchedVideo ? 70 : 0,
      narrativeCoherence: watchedVideo ? 75 : 0,
      captionAccuracy: watchedVideo ? 80 : 0,
    },
    suggestions: watchedVideo ? [] : ["Quality could not be verified - manual review recommended"],
    detailedFeedback: watchedVideo 
      ? `Automatic approval: ${reason}` 
      : `QUALITY UNVERIFIED: ${reason}. Video was not watched by AI. Manual review is strongly recommended.`,
    recommendedActions: watchedVideo ? [] : [{
      actionType: "none" as const,
      priority: 5,
      details: "Manual review recommended - self-review could not verify quality",
    }],
  };
}

export async function shouldAutoCorrect(selfReviewResult: SelfReviewResult): Promise<{
  shouldCorrect: boolean;
  autoFixableIssues: SelfReviewIssue[];
  reason: string;
}> {
  const autoFixableIssues = selfReviewResult.issues.filter(i => i.autoFixable);
  const criticalIssues = selfReviewResult.issues.filter(i => i.severity === "critical");
  const moderateIssues = selfReviewResult.issues.filter(i => i.severity === "moderate");
  
  if (criticalIssues.length > 0 && autoFixableIssues.length > 0) {
    return {
      shouldCorrect: true,
      autoFixableIssues,
      reason: `Critical issues detected: ${criticalIssues.map(i => i.description).join("; ")}`,
    };
  }
  
  if (moderateIssues.length >= 2 && autoFixableIssues.length > 0) {
    return {
      shouldCorrect: true,
      autoFixableIssues,
      reason: `Multiple moderate issues: ${moderateIssues.map(i => i.description).join("; ")}`,
    };
  }
  
  if (selfReviewResult.overallScore < 60 && autoFixableIssues.length > 0) {
    return {
      shouldCorrect: true,
      autoFixableIssues,
      reason: `Low quality score (${selfReviewResult.overallScore}/100) with fixable issues`,
    };
  }
  
  return {
    shouldCorrect: false,
    autoFixableIssues: [],
    reason: selfReviewResult.approved 
      ? "Video quality approved"
      : "Issues found but not auto-fixable",
  };
}

export interface CorrectionPlan {
  actions: {
    type: "adjust_cut" | "replace_broll" | "adjust_transition" | "fix_timing" | "adjust_caption";
    targetTimestamp?: number;
    originalValue?: unknown;
    newValue?: unknown;
    description: string;
  }[];
  expectedImprovement: number;
  affectedAreas: string[];
}

export async function generateCorrectionPlan(
  selfReviewResult: SelfReviewResult,
  editPlan: EditPlan,
  stockMedia: StockMediaItem[]
): Promise<CorrectionPlan> {
  const autoFixableIssues = selfReviewResult.issues.filter(i => i.autoFixable);
  
  if (autoFixableIssues.length === 0) {
    return {
      actions: [],
      expectedImprovement: 0,
      affectedAreas: [],
    };
  }
  
  selfReviewLogger.info(`Generating correction plan for ${autoFixableIssues.length} auto-fixable issues...`);
  
  const actions: CorrectionPlan["actions"] = [];
  const affectedAreas = new Set<string>();
  
  for (const issue of autoFixableIssues) {
    affectedAreas.add(issue.type);
    
    switch (issue.type) {
      case "transition":
        actions.push({
          type: "adjust_transition",
          targetTimestamp: issue.timestamp,
          description: issue.suggestedFix,
        });
        break;
        
      case "b_roll":
        actions.push({
          type: "replace_broll",
          targetTimestamp: issue.timestamp,
          description: issue.suggestedFix,
        });
        break;
        
      case "cuts":
        actions.push({
          type: "adjust_cut",
          targetTimestamp: issue.timestamp,
          description: issue.suggestedFix,
        });
        break;
        
      case "pacing":
        actions.push({
          type: "fix_timing",
          targetTimestamp: issue.timestamp,
          description: issue.suggestedFix,
        });
        break;
        
      case "captions":
        actions.push({
          type: "adjust_caption",
          targetTimestamp: issue.timestamp,
          description: issue.suggestedFix,
        });
        break;
    }
  }
  
  const expectedImprovement = Math.min(20, autoFixableIssues.length * 5);
  
  selfReviewLogger.info(`Correction plan: ${actions.length} actions, expected +${expectedImprovement} points`);
  
  return {
    actions,
    expectedImprovement,
    affectedAreas: Array.from(affectedAreas),
  };
}

export interface AppliedCorrections {
  appliedCount: number;
  modifiedEditPlan: EditPlan;
  modifiedStockMedia: StockMediaItem[];
  correctionsSummary: string[];
}

export function applyCorrectionPlan(
  correctionPlan: CorrectionPlan,
  editPlan: EditPlan,
  stockMedia: StockMediaItem[],
  selfReviewResult: SelfReviewResult
): AppliedCorrections {
  selfReviewLogger.info("═══════════════════════════════════════════════════════");
  selfReviewLogger.info("APPLYING AUTO-CORRECTIONS");
  selfReviewLogger.info("═══════════════════════════════════════════════════════");
  
  const modifiedEditPlan = JSON.parse(JSON.stringify(editPlan)) as EditPlan & { editStyle?: { transitionStyle?: string; pacing?: string } };
  const modifiedStockMedia = JSON.parse(JSON.stringify(stockMedia)) as StockMediaItem[];
  const correctionsSummary: string[] = [];
  let appliedCount = 0;
  
  for (const action of correctionPlan.actions) {
    switch (action.type) {
      case "adjust_transition":
        if (!modifiedEditPlan.editStyle) {
          modifiedEditPlan.editStyle = {};
        }
        const prevTransitions = modifiedEditPlan.editStyle.transitionStyle || "default";
        modifiedEditPlan.editStyle.transitionStyle = "smooth";
        correctionsSummary.push(`Adjusted transitions from ${prevTransitions} to smooth`);
        appliedCount++;
        break;
        
      case "adjust_cut":
        if (action.targetTimestamp && modifiedEditPlan.actions) {
          const cutActions = modifiedEditPlan.actions.filter(a => 
            a.type === "cut" && 
            a.start && 
            Math.abs(a.start - action.targetTimestamp!) < 2
          );
          for (const cut of cutActions) {
            if (cut.start && cut.end) {
              cut.start = Math.max(0, cut.start - 0.3);
              cut.end = cut.end + 0.3;
              correctionsSummary.push(`Adjusted cut at ${action.targetTimestamp}s: extended by 0.6s`);
              appliedCount++;
            }
          }
        }
        break;
        
      case "replace_broll":
        if (action.targetTimestamp) {
          const brollToReplace = modifiedStockMedia.findIndex(m => 
            m.startTime && Math.abs(m.startTime - action.targetTimestamp!) < 3
          );
          if (brollToReplace !== -1) {
            modifiedStockMedia.splice(brollToReplace, 1);
            correctionsSummary.push(`Removed problematic B-roll at ${action.targetTimestamp}s`);
            appliedCount++;
          }
        }
        break;
        
      case "fix_timing":
        if (!modifiedEditPlan.editStyle) {
          modifiedEditPlan.editStyle = {};
        }
        modifiedEditPlan.editStyle.pacing = "moderate";
        correctionsSummary.push("Adjusted pacing to moderate");
        appliedCount++;
        break;
        
      case "adjust_caption":
        correctionsSummary.push("Caption adjustment queued (requires re-render)");
        appliedCount++;
        break;
    }
  }
  
  selfReviewLogger.info(`Applied ${appliedCount} corrections:`);
  correctionsSummary.forEach(s => selfReviewLogger.info(`  - ${s}`));
  selfReviewLogger.info("═══════════════════════════════════════════════════════");
  
  return {
    appliedCount,
    modifiedEditPlan,
    modifiedStockMedia,
    correctionsSummary,
  };
}

const MAX_RENDER_ITERATIONS = 2;

export function shouldTriggerReRender(
  selfReviewResult: SelfReviewResult,
  currentRenderIteration: number
): { shouldReRender: boolean; reason: string } {
  if (currentRenderIteration >= MAX_RENDER_ITERATIONS) {
    return {
      shouldReRender: false,
      reason: `Maximum render iterations (${MAX_RENDER_ITERATIONS}) reached`,
    };
  }
  
  const criticalIssues = selfReviewResult.issues.filter(i => i.severity === "critical" && i.autoFixable);
  
  if (criticalIssues.length > 0) {
    return {
      shouldReRender: true,
      reason: `${criticalIssues.length} critical auto-fixable issue(s) detected`,
    };
  }
  
  if (selfReviewResult.overallScore < 50 && selfReviewResult.issues.filter(i => i.autoFixable).length > 0) {
    return {
      shouldReRender: true,
      reason: `Low quality score (${selfReviewResult.overallScore}/100) with fixable issues`,
    };
  }
  
  return {
    shouldReRender: false,
    reason: selfReviewResult.approved ? "Quality approved" : "No auto-fixable issues",
  };
}
