import { z } from "zod";
import { withRetry, AI_RETRY_OPTIONS } from "../../utils/retry";
import { createLogger } from "../../utils/logger";
import { getGeminiClient } from "./clients";
import {
  executePass1StructureAnalysis,
  executePass2QualityAssessment,
  executePass3BrollOptimization,
  executePass4QualityReview,
  getBrollStyleHint,
  type StructuredPlan,
  type QualityMap,
  type OptimizedBrollPlan,
  type ReviewedEditPlan,
} from "./editPlanningPasses";
import type {
  VideoAnalysis,
  TranscriptSegment,
  VideoContext,
  SemanticAnalysis,
  EditPlan,
  EditAction,
} from "@shared/schema";

const aiLogger = createLogger("ai-service");

const EditActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("cut"),
    start: z.number().optional(),
    end: z.number().optional(),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal("keep"),
    start: z.number().optional(),
    end: z.number().optional(),
    reason: z.string().optional(),
    priority: z.enum(["low", "medium", "high"]).optional(),
  }),
  z.object({
    type: z.literal("insert_stock"),
    start: z.number().optional(),
    duration: z.number().optional(),
    stockQuery: z.string().optional(),
    transcriptContext: z.string().optional(),
    reason: z.string().optional(),
    priority: z.enum(["low", "medium", "high"]).optional(),
  }),
  z.object({
    type: z.literal("insert_ai_image"),
    start: z.number().optional(),
    duration: z.number().optional(),
    imagePrompt: z.string().optional(),
    reason: z.string().optional(),
    priority: z.enum(["low", "medium", "high"]).optional(),
  }),
  z.object({
    type: z.literal("add_caption"),
    start: z.number().optional(),
    end: z.number().optional(),
    text: z.string().optional(),
    style: z.string().optional(),
  }),
  z.object({
    type: z.literal("add_text_overlay"),
    start: z.number().optional(),
    duration: z.number().optional(),
    text: z.string().optional(),
    position: z.string().optional(),
    style: z.string().optional(),
  }),
  z.object({
    type: z.literal("transition"),
    timestamp: z.number().optional(),
    transitionType: z.string().optional(),
    duration: z.number().optional(),
  }),
]);

const EditPlanResponseSchema = z.object({
  actions: z.array(z.any()),
  stockQueries: z.array(z.string()).optional(),
  keyPoints: z.array(z.string()).optional(),
  estimatedDuration: z.number().optional(),
  editingStrategy: z.object({
    approach: z.string().optional(),
    focusAreas: z.array(z.string()).optional(),
    avoidAreas: z.array(z.string()).optional(),
  }).optional(),
  qualityScore: z.object({
    pacing: z.string().optional(),
    brollRelevance: z.string().optional(),
    narrativeFlow: z.string().optional(),
  }).optional(),
});

function getEditStyleGuidance(context?: VideoContext): string {
  if (!context) {
    return "Apply moderate editing that balances engagement with authenticity.";
  }

  const styleGuides: Record<string, string> = {
    spiritual: `SPIRITUAL/RELIGIOUS CONTENT GUIDELINES:
- Preserve the contemplative, reverent atmosphere
- Use minimal cuts to maintain flow and allow moments of reflection
- B-roll should be calming: nature scenes, peaceful imagery, symbolic visuals
- Avoid jarring transitions or fast-paced editing
- Prioritize audio clarity for prayers, mantras, or teachings
- Text overlays should be subtle and elegant`,

    tutorial: `TUTORIAL/EDUCATIONAL CONTENT GUIDELINES:
- Keep demonstrations and explanations intact
- Cut hesitations, repeated attempts, and off-topic tangents
- Use B-roll to illustrate concepts being explained
- Add text overlays for key steps or important notes
- Maintain logical flow and progression
- Ensure all instructional content is preserved`,

    interview: `INTERVIEW CONTENT GUIDELINES:
- Preserve natural conversation flow and emotional moments
- Cut only obvious dead air, not thoughtful pauses
- Use B-roll during explanatory portions, not during emotional responses
- Keep reaction shots and facial expressions visible
- Text overlays for speaker names and key quotes
- Maintain conversational rhythm`,

    tech: `TECH CONTENT GUIDELINES:
- Keep code demonstrations and explanations clear
- Use B-roll of modern technology, clean interfaces
- Cut tangents while preserving technical accuracy
- Text overlays for code snippets, URLs, or key specs
- Maintain logical progression of technical concepts
- Fast-paced editing acceptable but not distracting`,

    vlog: `VLOG CONTENT GUIDELINES:
- Preserve personality and authentic moments
- Dynamic editing to maintain engagement
- Use B-roll to establish locations and context
- Cut dead air but keep personality quirks
- Text overlays for locations, dates, or emphasis
- Match energy level of the creator`,

    motivational: `MOTIVATIONAL CONTENT GUIDELINES:
- Build emotional momentum throughout
- Use inspiring B-roll: success imagery, nature, achievement
- Preserve powerful delivery moments
- Strategic text overlays for key quotes
- Maintain building intensity toward climax
- Cut hesitations but not powerful pauses`,

    documentary: `DOCUMENTARY CONTENT GUIDELINES:
- Preserve narrative structure and pacing
- Use archival or contextual B-roll appropriately
- Maintain emotional beats and story arc
- Text overlays for dates, locations, names
- Thoughtful cuts that serve the story
- Balance between information and engagement`,
  };

  return styleGuides[context.genre] || 
    `For ${context.genre} content with ${context.tone} tone and ${context.pacing} pacing:
- Match editing style to content energy
- Use contextually appropriate B-roll
- Preserve key moments and authenticity
- Cut only non-essential content`;
}

export function validateAndFixBrollActions(actions: EditAction[], duration: number): EditAction[] {
  const brollActions = actions.filter(a => a.type === "insert_stock");
  const otherActions = actions.filter(a => a.type !== "insert_stock");
  
  const brollWithTiming = brollActions.map((a, index) => ({
    ...a,
    start: a.start ?? (index * 10),
  }));
  
  brollWithTiming.sort((a, b) => (a.start || 0) - (b.start || 0));
  
  const validatedBroll: EditAction[] = [];
  let lastEnd = -3;
  
  for (const action of brollWithTiming) {
    const start = Math.max(0, action.start || 0);
    const actionDuration = action.duration || 4;
    
    if (start >= lastEnd + 3 && start < duration - 1) {
      validatedBroll.push({
        ...action,
        start,
        duration: Math.min(6, Math.max(2, actionDuration)),
      });
      lastEnd = start + actionDuration;
    } else {
      aiLogger.debug(`Skipping overlapping B-roll at ${start}s (previous ended at ${lastEnd}s)`);
    }
  }
  
  return [...otherActions, ...validatedBroll];
}

export async function generateEditPlan(
  prompt: string,
  analysis: VideoAnalysis,
  transcript: TranscriptSegment[],
  semanticAnalysis?: SemanticAnalysis
): Promise<EditPlan> {
  const contextInfo = analysis.context;
  const editStyleGuidance = getEditStyleGuidance(contextInfo);
  
  const semanticBrollWindows = semanticAnalysis?.brollWindows || [];
  const extractedKeywords = semanticAnalysis?.extractedKeywords || [];
  const contentSummary = semanticAnalysis?.contentSummary || analysis.summary || "";
  
  const systemPrompt = `You are an expert professional video editor with years of experience in ${contextInfo?.genre || "video"} content. Your task is to create a precise, intelligent edit plan that maximizes viewer engagement while respecting the content's nature and purpose.

VIDEO CONTEXT:
- Genre: ${contextInfo?.genre || "general"}
- Tone: ${contextInfo?.tone || "casual"}
- Pacing: ${contextInfo?.pacing || "moderate"}
- Suggested Edit Style: ${contextInfo?.suggestedEditStyle || "moderate"}
- Target Audience: ${contextInfo?.targetAudience || "general viewers"}
${contextInfo?.regionalContext ? `- Regional Context: ${contextInfo.regionalContext}` : ""}

${editStyleGuidance}

AVAILABLE EDIT ACTIONS:

1. "cut" - Remove sections (audio AND video removed)
2. "keep" - Explicitly mark important segments to preserve
3. "insert_stock" - OVERLAY B-roll stock footage (original audio CONTINUES)
4. "add_caption" - Add captions for key dialogue
5. "add_text_overlay" - Add emphasis text

TIMING RULES FOR B-ROLL:
- Minimum duration: 2 seconds
- Maximum duration: 6 seconds
- Optimal duration: 3-4 seconds
- Leave 2+ seconds between B-roll overlays

B-ROLL SEARCH QUERY GUIDELINES:
- Be specific and contextual
- Match the video's tone: ${contextInfo?.tone || "casual"}
- For ${contextInfo?.genre || "general"} content, prefer: ${getBrollStyleHint(contextInfo?.genre)}`;

  const brollOppsSummary = semanticBrollWindows.length > 0 
    ? semanticBrollWindows.map(b => 
        `  - ${b.start.toFixed(1)}s-${b.end.toFixed(1)}s: "${b.suggestedQuery}" (${b.priority} priority)`
      ).join("\n")
    : analysis.brollOpportunities?.slice(0, 5).map(b => 
        `  - ${b.start.toFixed(1)}s-${b.end.toFixed(1)}s: "${b.query}" (${b.priority} priority)`
      ).join("\n") || "No specific opportunities identified";

  const topicsSummary = analysis.topicSegments?.map(t =>
    `  - ${t.start.toFixed(1)}s-${t.end.toFixed(1)}s: ${t.topic} (${t.importance || "medium"} importance)`
  ).join("\n") || "No topic segments identified";

  const semanticContext = semanticAnalysis ? `
SEMANTIC ANALYSIS (from transcript):
- Main Topics: ${semanticAnalysis.mainTopics.join(", ")}
- Overall Tone: ${semanticAnalysis.overallTone}
- Key Keywords: ${extractedKeywords.slice(0, 15).join(", ")}
- Content Summary: ${contentSummary}

KEY MOMENTS IDENTIFIED:
${semanticAnalysis.keyMoments.map(k => `  - ${k.timestamp.toFixed(1)}s: ${k.description} (${k.importance} importance)`).join("\n") || "None"}
` : "";

  const userPrompt = `User's editing instructions: "${prompt}"

VIDEO SUMMARY:
${contentSummary || analysis.summary || "No summary available"}
${semanticContext}

NARRATIVE STRUCTURE:
${analysis.narrativeStructure ? `
- Has intro: ${analysis.narrativeStructure.hasIntro ? `Yes, ends at ${analysis.narrativeStructure.introEnd}s` : "No"}
- Main content: ${analysis.narrativeStructure.mainContentStart || 0}s to ${analysis.narrativeStructure.mainContentEnd || analysis.duration}s
- Has outro: ${analysis.narrativeStructure.hasOutro ? `Yes, starts at ${analysis.narrativeStructure.outroStart}s` : "No"}
` : "Not analyzed"}

TOPIC SEGMENTS:
${topicsSummary}

B-ROLL OPPORTUNITIES:
${brollOppsSummary}

SILENT SEGMENTS (candidates for cutting):
${analysis.silentSegments?.map(s => `  - ${s.start.toFixed(1)}s to ${s.end.toFixed(1)}s`).join("\n") || "None detected"}

TRANSCRIPT WITH CONTEXT:
${transcript.slice(0, 50).map(t => `[${t.start.toFixed(1)}s-${t.end.toFixed(1)}s]: ${t.text}`).join("\n")}
${transcript.length > 50 ? `\n... (${transcript.length - 50} more segments)` : ""}

Total video duration: ${analysis.duration.toFixed(1)} seconds

CREATE YOUR EDIT PLAN:
1. USE the pre-identified B-roll opportunities
2. For each insert_stock action, include "transcriptContext" field
3. Stock queries MUST be specific to content
4. Ensure B-roll doesn't overlap and has 3+ seconds spacing
5. Cut silent/boring sections while preserving narrative flow

Respond with a JSON object only (no markdown):
{
  "actions": [...],
  "stockQueries": ["list of unique stock media searches needed"],
  "keyPoints": ["main topics and highlights from the video"],
  "estimatedDuration": number,
  "editingStrategy": {...}
}`;

  const response = await withRetry(
    () => getGeminiClient().models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: systemPrompt + "\n\n" + userPrompt }] }],
    }),
    "generateEditPlan",
    AI_RETRY_OPTIONS
  );

  const text = response.text || "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  
  const fallbackPlan = (): EditPlan => {
    const keepAction: EditAction = {
      type: "keep",
      start: 0,
      end: analysis.duration,
      reason: "Keep entire video (failed to generate specific edits)",
    };
    return { actions: [keepAction], estimatedDuration: analysis.duration };
  };
  
  if (!jsonMatch) {
    aiLogger.warn("No JSON found in AI response for edit plan");
    return fallbackPlan();
  }

  let parsed: z.infer<typeof EditPlanResponseSchema>;
  try {
    parsed = JSON.parse(jsonMatch[0]) as z.infer<typeof EditPlanResponseSchema>;
    EditPlanResponseSchema.safeParse(parsed);
  } catch (parseError) {
    aiLogger.warn("JSON parse error in edit plan:", parseError);
    return fallbackPlan();
  }

  if (!parsed.actions || !Array.isArray(parsed.actions)) {
    aiLogger.warn("No valid actions array in AI response");
    return fallbackPlan();
  }

  const actions: EditAction[] = [];
  for (const a of parsed.actions) {
    const actionValidation = EditActionSchema.safeParse(a);
    if (actionValidation.success) {
      const validAction = actionValidation.data;
      if ('start' in validAction && validAction.start !== undefined && validAction.start < 0) {
        (validAction as { start: number }).start = 0;
      }
      if ('end' in validAction && validAction.end !== undefined && validAction.end > analysis.duration) {
        (validAction as { end: number }).end = analysis.duration;
      }
      actions.push(validAction as EditAction);
    }
  }

  const hasKeepActions = actions.some((a) => a.type === "keep");
  if (!hasKeepActions) {
    const sortedCuts = actions
      .filter((a) => a.type === "cut" && a.start !== undefined && a.end !== undefined)
      .sort((a, b) => (a.start || 0) - (b.start || 0));

    const keepActions: EditAction[] = [];
    let currentTime = 0;

    for (const cut of sortedCuts) {
      if (cut.start! > currentTime) {
        keepActions.push({ type: "keep", start: currentTime, end: cut.start!, reason: "Content between cuts" });
      }
      currentTime = cut.end!;
    }

    if (currentTime < analysis.duration) {
      keepActions.push({ type: "keep", start: currentTime, end: analysis.duration, reason: "Content after last cut" });
    }

    if (keepActions.length === 0) {
      keepActions.push({ type: "keep", start: 0, end: analysis.duration, reason: "Keep entire video" });
    }

    actions.push(...keepActions);
  }

  const validatedActions = validateAndFixBrollActions(actions, analysis.duration);

  return {
    actions: validatedActions,
    stockQueries: parsed.stockQueries || [],
    keyPoints: parsed.keyPoints || [],
    estimatedDuration: parsed.estimatedDuration || analysis.duration,
    editingStrategy: parsed.editingStrategy || undefined,
  };
}

export async function generateSmartEditPlan(
  prompt: string,
  analysis: VideoAnalysis,
  transcript: TranscriptSegment[],
  semanticAnalysis: SemanticAnalysis,
  fillerSegments: { start: number; end: number; word: string }[]
): Promise<EditPlan> {
  aiLogger.info("Starting multi-pass smart edit planning...");
  const startTime = Date.now();

  aiLogger.info("Pass 1: Analyzing video structure...");
  const structuredPlan = await executePass1StructureAnalysis(analysis, transcript, semanticAnalysis);
  aiLogger.debug(`Pass 1 complete: ${structuredPlan.narrativeArc} structure with ${structuredPlan.sectionMarkers.length} markers`);

  aiLogger.info("Pass 2: Assessing segment quality...");
  const qualityMap = await executePass2QualityAssessment(
    analysis, transcript, semanticAnalysis, structuredPlan, fillerSegments
  );
  aiLogger.debug(`Pass 2 complete: ${qualityMap.segmentScores.length} segments scored, hook strength: ${qualityMap.hookStrength}`);

  aiLogger.info("Pass 3: Optimizing B-roll placement...");
  const brollPlan = await executePass3BrollOptimization(
    analysis, transcript, semanticAnalysis, structuredPlan, qualityMap, fillerSegments
  );
  aiLogger.debug(`Pass 3 complete: ${brollPlan.brollPlacements.length} B-roll placements, ${brollPlan.fillerActions.length} filler actions`);

  aiLogger.info("Pass 4: Quality review and refinement...");
  let reviewedPlan;
  try {
    reviewedPlan = await executePass4QualityReview(
      analysis, structuredPlan, qualityMap, brollPlan, prompt
    );
    aiLogger.debug(`Pass 4 complete: ${reviewedPlan.actions.length} final actions, overall score: ${reviewedPlan.qualityMetrics.overallScore}`);
  } catch (error) {
    aiLogger.error("Pass 4 failed, using B-roll plan directly:", error);
    reviewedPlan = {
      actions: brollPlan.brollPlacements.map(p => ({
        type: "insert_stock" as const,
        start: p.start,
        end: p.start + p.duration,
        stockQuery: p.query,
        mediaType: "video" as const
      })),
      qualityMetrics: { 
        overallScore: 70, 
        narrativeFlow: "medium", 
        pacing: "moderate",
        brollRelevance: "medium" 
      },
      warnings: ["Pass 4 refinement failed"]
    };
  }

  const validatedActions = validateAndFixBrollActions(reviewedPlan.actions, analysis.duration);

  const elapsedTime = Date.now() - startTime;
  aiLogger.info(`Multi-pass smart edit planning complete in ${elapsedTime}ms`);

    const stockQueriesSet = new Set<string>();
    reviewedPlan.actions.forEach(a => {
      if (a.type === "insert_stock" && (a as any).stockQuery) {
        stockQueriesSet.add((a as any).stockQuery);
      }
    });
    const stockQueries = Array.from(stockQueriesSet);

  const keyPoints = [
    ...(structuredPlan.sectionMarkers?.filter(m => m.type === "climax" || m.type === "section_change").map(m => m.description) || []),
    ...(qualityMap.mustKeepSegments?.map(s => s.reason) || []),
  ].slice(0, 10);

  const cutDuration = validatedActions
    .filter(a => a.type === "cut" && a.start !== undefined && a.end !== undefined)
    .reduce((total, a) => total + ((a.end || 0) - (a.start || 0)), 0);
  const estimatedDuration = Math.max(1, analysis.duration - cutDuration);

  return {
    actions: validatedActions,
    stockQueries,
    keyPoints,
    estimatedDuration,
    editingStrategy: {
      approach: `Multi-pass ${structuredPlan.narrativeArc} editing with ${brollPlan.brollPlacements.length} B-roll placements`,
      focusAreas: ["Narrative flow preservation", "Engagement optimization", "Context-aware B-roll"],
      avoidAreas: reviewedPlan.warnings.slice(0, 3),
    },
    qualityMetrics: reviewedPlan.qualityMetrics,
  };
}
