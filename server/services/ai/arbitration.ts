import { createLogger } from "../../utils/logger";
import type { PreRenderReviewResult } from "./preRenderReview";
import type { SelfReviewResult } from "./postRenderReview";
import type { EditPlan, EditAction } from "@shared/schema";

const arbLogger = createLogger("ai-arbitrator");

export interface ArbitrationResult {
    shouldReRender: boolean;
    correctionPlan: EditAction[];
    justification: string;
    confidence: number;
}

/**
 * Resolves conflicts between initial AI planning review and post-render self-review.
 */
export async function arbitrateReviewConflicts(
    preRenderResult: PreRenderReviewResult,
    postRenderResult: SelfReviewResult,
    currentPlan: EditPlan
): Promise<ArbitrationResult> {
    arbLogger.info("Starting autonomous arbitration between pre-render and post-render reviews...");

    const preApproved = preRenderResult.approved;
    const postApproved = postRenderResult.approved;
    const postScore = postRenderResult.overallScore;

    // Scenario 1: Both agree it's good
    if (preApproved && postApproved) {
        return {
            shouldReRender: false,
            correctionPlan: [],
            justification: "Both review stages confirmed high quality. No arbitration needed.",
            confidence: (preRenderResult.confidence + postRenderResult.overallScore) / 2,
        };
    }

    // Scenario 2: Pre-render approved, but Post-render found issues (Visual/Audio Reality mismatch)
    if (preApproved && !postApproved) {
        arbLogger.warn(`Conflict detected: Pre-render approved, but Post-render failed with score: ${postScore}`);

        // Identify critical issues from post-render
        const criticalIssues = postRenderResult.issues.filter(i => i.severity === "critical" || i.autoFixable);

        if (criticalIssues.length > 0) {
            return {
                shouldReRender: true,
                correctionPlan: generateArbitratedCorrections(postRenderResult, currentPlan),
                justification: `Post-render analysis identified ${criticalIssues.length} critical visual/audio issues that were not apparent in the edit plan structure.`,
                confidence: 85,
            };
        }
    }

    // Scenario 3: Pre-render had warnings, but Post-render says it looks great
    if (!preApproved && postApproved && postScore > 85) {
        return {
            shouldReRender: false,
            correctionPlan: [],
            justification: "Initial structural warnings were resolved by the actual render quality. Visual output exceeds structural expectations.",
            confidence: postScore,
        };
    }

    // Scenario 4: Both agree there are issues
    if (!preApproved && !postApproved) {
        return {
            shouldReRender: true,
            correctionPlan: generateArbitratedCorrections(postRenderResult, currentPlan),
            justification: "Critical consensus: Multiple stages identified quality failures.",
            confidence: 95,
        };
    }

    return {
        shouldReRender: postScore < 60,
        correctionPlan: [],
        justification: "Standard quality threshold check.",
        confidence: 70,
    };
}

function generateArbitratedCorrections(
    postRenderResult: SelfReviewResult,
    currentPlan: EditPlan
): EditAction[] {
    const newActions = [...currentPlan.actions];

    // Map post-render issues to specific action modifications
    for (const issue of postRenderResult.issues) {
        if (!issue.autoFixable) continue;

        // Example: "B-roll at 15s is distracting" -> Disable or replace that action
        if (issue.type === "b_roll" && issue.timestamp !== undefined) {
            const idx = newActions.findIndex(a =>
                a.type === "insert_stock" &&
                a.start !== undefined &&
                Math.abs(a.start - issue.timestamp!) < 2
            );

            if (idx !== -1) {
                arbLogger.info(`Arbitrator: Adjusting B-roll action at ${issue.timestamp}s due to: ${issue.description}`);
                // If it's a minor issue, we might just tweak duration, but here we'll flag for replacement
                (newActions[idx] as any).needsReplacement = true;
                newActions[idx].reason = `Corrected: ${issue.suggestedFix}`;
            }
        }

        // Example: "Segment 10-12s has silence that should be cut"
        if (issue.type === "cuts" && issue.timestamp !== undefined) {
            newActions.push({
                type: "cut",
                start: issue.timestamp,
                end: (issue as any).end ?? (issue.timestamp + 1),
                reason: `Arbitrated cut: ${issue.description}`
            });
        }
    }

    return newActions;
}
