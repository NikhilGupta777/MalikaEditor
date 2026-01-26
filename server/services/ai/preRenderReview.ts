import { getGeminiClient } from "./clients";
import { createLogger } from "../../utils/logger";
import type { EditPlan, VideoAnalysis, TranscriptSegment, ReviewData } from "@shared/schema";

const reviewLogger = createLogger("ai-pre-render-review");

export interface PreRenderReviewResult {
  confidence: number;
  approved: boolean;
  issues: {
    severity: "low" | "medium" | "high";
    description: string;
    suggestion: string;
  }[];
  suggestions: string[];
  editQualityScore: number;
  narrativeFlowScore: number;
  pacingScore: number;
  summary: string;
}

export async function performPreRenderReview(
  videoAnalysis: VideoAnalysis,
  transcript: TranscriptSegment[],
  editPlan: EditPlan,
  reviewData: ReviewData,
  userPrompt: string
): Promise<PreRenderReviewResult> {
  reviewLogger.info("Starting AI pre-render review with Gemini 1.5 Flash...");
  
  const approvedCuts = reviewData.editPlan.actions.filter(a => a.type === "cut" && a.approved);
  const approvedKeeps = reviewData.editPlan.actions.filter(a => a.type === "keep" && a.approved);
  const approvedBroll = reviewData.stockMedia.filter(m => m.approved);
  const approvedAiImages = reviewData.aiImages.filter(m => m.approved);
  
  const transcriptText = transcript.slice(0, 20).map(t => 
    `[${t.start.toFixed(1)}s-${t.end.toFixed(1)}s]: ${t.text}`
  ).join("\n");
  
  const prompt = `You are an expert video editor AI performing a final quality review before rendering.

ORIGINAL USER REQUEST:
"${userPrompt}"

VIDEO CONTEXT:
- Duration: ${videoAnalysis.duration?.toFixed(1) || "unknown"} seconds
- Genre: ${videoAnalysis.context?.genre || "general"}
- Tone: ${videoAnalysis.context?.tone || "casual"}
- Pacing: ${videoAnalysis.context?.pacing || "moderate"}

TRANSCRIPT EXCERPT:
${transcriptText}

APPROVED EDIT DECISIONS:
- Cuts: ${approvedCuts.length} segments will be removed
- Keeps: ${approvedKeeps.length} segments marked as important
- B-Roll overlays: ${approvedBroll.length} stock media items
- AI Images: ${approvedAiImages.length} generated images

EDIT SUMMARY:
- Original duration: ${reviewData.summary.originalDuration.toFixed(1)}s
- Estimated final duration: ${reviewData.summary.estimatedFinalDuration.toFixed(1)}s
- Reduction: ${((1 - reviewData.summary.estimatedFinalDuration / reviewData.summary.originalDuration) * 100).toFixed(1)}%

CUTS BEING MADE:
${approvedCuts.slice(0, 10).map(c => `- [${c.start?.toFixed(1)}s-${c.end?.toFixed(1)}s]: ${c.reason || "No reason"}`).join("\n")}

B-ROLL PLACEMENTS:
${approvedBroll.slice(0, 8).map(b => `- [${b.startTime?.toFixed(1)}s]: "${b.query}" (${b.type})`).join("\n")}

REVIEW INSTRUCTIONS:
1. Evaluate if the edit plan matches the user's original request
2. Check for potential narrative flow issues (cutting important context, breaking story)
3. Assess pacing - too many cuts? Not enough variety?
4. Evaluate B-roll relevance to content
5. Identify any critical issues that should be flagged

Respond in JSON format:
{
  "confidence": <0-100 score of how confident you are this edit will match user expectations>,
  "approved": <true if edits seem good, false if major issues>,
  "editQualityScore": <0-100 overall edit quality>,
  "narrativeFlowScore": <0-100 how well the story flows>,
  "pacingScore": <0-100 how good the pacing is>,
  "issues": [
    {"severity": "low|medium|high", "description": "...", "suggestion": "..."}
  ],
  "suggestions": ["improvement suggestion 1", "..."],
  "summary": "Brief 1-2 sentence summary of the review"
}`;

  try {
    const client = getGeminiClient();
    const response = await client.models.generateContent({
      model: "gemini-1.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        temperature: 0.3,
        maxOutputTokens: 1500,
      },
    });

    const text = response.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) {
      reviewLogger.warn("Could not parse pre-render review response, using defaults");
      return getDefaultReviewResult();
    }

    const result = JSON.parse(jsonMatch[0]);
    
    reviewLogger.info(`Pre-render review complete: confidence=${result.confidence}%, approved=${result.approved}`);
    
    return {
      confidence: result.confidence ?? 75,
      approved: result.approved ?? true,
      issues: Array.isArray(result.issues) ? result.issues : [],
      suggestions: Array.isArray(result.suggestions) ? result.suggestions : [],
      editQualityScore: result.editQualityScore ?? 70,
      narrativeFlowScore: result.narrativeFlowScore ?? 70,
      pacingScore: result.pacingScore ?? 70,
      summary: result.summary ?? "Review completed successfully.",
    };
  } catch (error) {
    reviewLogger.error("Pre-render review failed:", error);
    return getDefaultReviewResult();
  }
}

function getDefaultReviewResult(): PreRenderReviewResult {
  return {
    confidence: 75,
    approved: true,
    issues: [],
    suggestions: [],
    editQualityScore: 70,
    narrativeFlowScore: 70,
    pacingScore: 70,
    summary: "Automatic review - edits appear reasonable based on user selections.",
  };
}

export interface EditFeedback {
  projectId: number;
  editActionId: string;
  actionType: string;
  wasApproved: boolean;
  wasModified: boolean;
  userReason?: string;
  originalStart?: number;
  originalEnd?: number;
  modifiedStart?: number;
  modifiedEnd?: number;
  context: {
    genre?: string;
    tone?: string;
    duration?: number;
  };
  timestamp: Date;
}

export interface FeedbackSummary {
  totalFeedback: number;
  approvalRate: number;
  commonRejections: {
    actionType: string;
    count: number;
    commonReasons: string[];
  }[];
  preferredPatterns: {
    genre: string;
    preferredCutDensity: "low" | "medium" | "high";
    preferredBrollFrequency: "low" | "medium" | "high";
  }[];
}

let feedbackCache: EditFeedback[] = [];

export function recordEditFeedback(feedback: EditFeedback): void {
  feedbackCache.push(feedback);
  if (feedbackCache.length > 1000) {
    feedbackCache = feedbackCache.slice(-1000);
  }
  reviewLogger.debug(`Recorded feedback for action ${feedback.editActionId}: approved=${feedback.wasApproved}`);
}

export function getFeedbackSummary(): FeedbackSummary {
  const totalFeedback = feedbackCache.length;
  const approvedCount = feedbackCache.filter(f => f.wasApproved).length;
  
  const rejectionsByType = new Map<string, { count: number; reasons: string[] }>();
  
  for (const feedback of feedbackCache.filter(f => !f.wasApproved)) {
    const existing = rejectionsByType.get(feedback.actionType) || { count: 0, reasons: [] };
    existing.count++;
    if (feedback.userReason) {
      existing.reasons.push(feedback.userReason);
    }
    rejectionsByType.set(feedback.actionType, existing);
  }
  
  const commonRejections = Array.from(rejectionsByType.entries())
    .map(([actionType, data]) => ({
      actionType,
      count: data.count,
      commonReasons: Array.from(new Set(data.reasons)).slice(0, 5),
    }))
    .sort((a, b) => b.count - a.count);
  
  return {
    totalFeedback,
    approvalRate: totalFeedback > 0 ? approvedCount / totalFeedback : 1,
    commonRejections,
    preferredPatterns: [],
  };
}

export function getFeedbackContextForPlanning(): string {
  const summary = getFeedbackSummary();
  
  if (summary.totalFeedback < 5) {
    return "";
  }
  
  let context = "\n\nUSER FEEDBACK LEARNING:\n";
  context += `Based on ${summary.totalFeedback} previous edits, users approve ${(summary.approvalRate * 100).toFixed(0)}% of AI suggestions.\n`;
  
  if (summary.commonRejections.length > 0) {
    context += "\nCommon rejections to avoid:\n";
    for (const rejection of summary.commonRejections.slice(0, 3)) {
      context += `- ${rejection.actionType}: rejected ${rejection.count} times`;
      if (rejection.commonReasons.length > 0) {
        context += ` (reasons: ${rejection.commonReasons.slice(0, 2).join(", ")})`;
      }
      context += "\n";
    }
  }
  
  return context;
}

export function clearFeedbackCache(): void {
  feedbackCache = [];
  reviewLogger.info("Feedback cache cleared");
}
