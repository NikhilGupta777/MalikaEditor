import { z } from "zod";
import { withRetry, AI_RETRY_OPTIONS } from "../../utils/retry";
import { createLogger } from "../../utils/logger";
import { getGeminiClient } from "./clients";
import { AI_CONFIG } from "../../config/ai";
import {
  executePass1StructureAnalysis,
  executePass2QualityAssessment,
  executePass3BrollOptimization,
  executePass4QualityReview,
  executePass5CorrectionPass,
  executeConsolidatedAnalysis,
  getBrollStyleHint,
  type StructuredPlan,
  type QualityMap,
  type OptimizedBrollPlan,
  type ReviewedEditPlan,
  type ConsolidatedAnalysisResult,
  safeJsonParse,
} from "./editPlanningPasses";
import { getFeedbackContextForPlanning } from "./preRenderReview";
import { getLearningContext, retrievePatterns, applyLearnedPreferences } from "./learningSystem";
import { type ArbitrationResult } from "./arbitration";
import type {
  VideoAnalysis,
  TranscriptSegment,
  VideoContext,
  SemanticAnalysis,
  EditPlan,
  EditAction,
  TranscriptEnhancedType,
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
    animationPreset: z.enum(["zoom_in", "zoom_out", "pan_left", "pan_right", "fade_only"]).optional(),
  }),
  z.object({
    type: z.literal("insert_ai_image"),
    start: z.number().optional(),
    duration: z.number().optional(),
    imagePrompt: z.string().optional(),
    reason: z.string().optional(),
    priority: z.enum(["low", "medium", "high"]).optional(),
    animationPreset: z.enum(["zoom_in", "zoom_out", "pan_left", "pan_right", "fade_only"]).optional(),
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

function getPacingGuidanceForDuration(durationSeconds: number): string {
  if (durationSeconds < 120) {
    return `PACING GUIDANCE (SHORT VIDEO - Under 2 minutes):
- Keep cuts MINIMAL to maintain flow and avoid choppy feel
- Only cut obvious dead air or major mistakes
- Focus on smooth transitions rather than aggressive trimming
- Preserve narrative momentum - short videos need every moment to count
- B-roll should be sparse and highly impactful
- Goal: Polish, don't truncate`;
  } else if (durationSeconds < 600) {
    return `PACING GUIDANCE (MEDIUM VIDEO - 2 to 10 minutes):
- BALANCE cuts with viewer retention - remove filler but keep substance
- Cut hesitations, repeated phrases, and tangents
- Strategic B-roll at topic transitions and explanatory sections
- Consider 2-3 "micro-chapters" for mental organization
- Maintain energy through varied pacing
- Goal: Tighten without losing engagement`;
  } else {
    return `PACING GUIDANCE (LONG VIDEO - Over 10 minutes):
- More AGGRESSIVE editing to maintain viewer attention
- Create clear chapter breaks every 3-5 minutes
- Cut ruthlessly: tangents, redundant explanations, slow sections
- Use B-roll frequently to maintain visual interest
- Consider highlight moments that could work as standalone clips
- Add text overlays at chapter transitions
- Goal: Keep viewers engaged through varied, dynamic editing`;
  }
}

function getContentTypeGuidance(genre?: string): string {
  if (genre === "tutorial" || genre === "educational") {
    return `TUTORIAL/EDUCATIONAL SPECIFIC RULES:
- PRESERVE all instructional content - never cut during explanations
- Cut: "um", "uh", long pauses, off-topic tangents
- Keep: Step-by-step explanations, demonstrations, key takeaways
- Add text overlays for important steps or commands
- B-roll should illustrate concepts, not distract from learning
- Pacing should match cognitive load - slow for complex topics`;
  } else if (genre === "entertainment" || genre === "vlog" || genre === "comedy") {
    return `ENTERTAINMENT SPECIFIC RULES:
- PRIORITIZE energy and momentum over completeness
- More aggressive cuts acceptable - fast pacing keeps viewers engaged
- Cut: Slow moments, setup without payoff, repeated jokes
- Keep: Punchlines, reactions, emotional peaks, personality moments
- B-roll can be playful, reactive, and frequent
- Match cuts to music/energy when possible`;
  }
  return "";
}

function getEditStyleGuidance(context?: VideoContext): string {
  if (!context) {
    return "Apply moderate editing that balances engagement with authenticity.";
  }

  const styleGuides: Record<string, string> = {
    spiritual: `SPIRITUAL/RELIGIOUS CONTENT GUIDELINES:
- Preserve the contemplative, reverent atmosphere
- Use minimal cuts to maintain flow and allow moments of reflection
- B-roll should be calming: nature scenes, peaceful imagery, symbolic visuals BUT it should be mostly Video B-roll and according to the video context only
- Avoid jarring transitions or fast-paced editing
- Prioritize audio clarity for prayers, mantras, or teachings
- Text overlays should be subtle and elegant`,

    tutorial: `TUTORIAL/EDUCATIONAL CONTENT GUIDELINES:
- Keep demonstrations and explanations intact
- Cut repeated attempts and areas where speaker stops (cut in milliseconds only)
- Use Maximum Ai Clip's and also B-roll to illustrate concepts being explained (use video B-roll and clips wherever possible)
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
- Use Ai Clips and B-roll of modern technology, clean interfaces
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
- ai clips should be used to show the context of the video
- Maintain emotional beats and story arc
- Text overlays for dates, locations, names
- no cuts
- Balance between information and engagement`,
  };

  return styleGuides[context.genre] ||
    `For ${context.genre} content with ${context.tone} tone and ${context.pacing} pacing:
- Match editing style to content energy
- Use contextually appropriate B-roll
- Preserve key moments and authenticity
- Cut only non-essential content`;
}

export function validateAndFixBrollActions(
  actions: EditAction[],
  duration: number,
  transcript?: TranscriptSegment[]
): EditAction[] {
  // Ensure duration is valid (fallback to reasonable default if NaN/undefined)
  const validDuration = (duration && !isNaN(duration) && duration > 0) ? duration : 300;

  // Helper to find transcript text at a given timestamp
  const findTranscriptText = (start: number, end: number): string | null => {
    if (!transcript || transcript.length === 0) return null;

    // Find transcript segments that overlap with the given time range
    const overlapping = transcript.filter(seg =>
      seg.start < end && seg.end > start
    );

    if (overlapping.length === 0) return null;

    return overlapping.map(seg => seg.text).join(' ').trim();
  };

  // First, validate all actions for basic timestamp integrity
  const sanitizedActions: EditAction[] = [];

  for (const action of actions) {
    // Validate and fix cut/keep actions
    if (action.type === "cut" || action.type === "keep") {
      let start = action.start;
      let end = action.end;

      // Skip actions with missing or invalid timestamps
      if (start === undefined || end === undefined) {
        aiLogger.debug(`Skipping ${action.type} action with missing timestamps`);
        continue;
      }

      // Ensure timestamps are finite numbers
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        aiLogger.debug(`Skipping ${action.type} action with invalid timestamps: start=${start}, end=${end}`);
        continue;
      }

      // Ensure non-negative
      start = Math.max(0, start);
      end = Math.max(0, end);

      // Ensure start < end (swap if needed)
      if (start >= end) {
        if (start === end) {
          aiLogger.debug(`Skipping ${action.type} action with zero duration at ${start}s`);
          continue;
        }
        // Swap if start > end
        [start, end] = [end, start];
        aiLogger.debug(`Swapped ${action.type} action timestamps: ${action.start}s-${action.end}s -> ${start}s-${end}s`);
      }

      // Clamp to video duration
      end = Math.min(end, validDuration);
      if (start >= validDuration) {
        aiLogger.debug(`Skipping ${action.type} action starting after video end (${start}s > ${validDuration}s)`);
        continue;
      }

      sanitizedActions.push({
        ...action,
        start,
        end,
      });
    } else if (action.type === "insert_ai_image") {
      // Validate AI image actions
      let start = action.start ?? 0;
      let actionDuration = action.duration ?? 3;

      // Ensure timestamps are finite
      if (!Number.isFinite(start)) start = 0;
      if (!Number.isFinite(actionDuration)) actionDuration = 3;

      // Ensure non-negative
      start = Math.max(0, start);
      actionDuration = Math.max(0.5, Math.min(actionDuration, 30)); // 0.5-30 seconds

      // Ensure within video bounds
      if (start >= validDuration) {
        aiLogger.debug(`Skipping AI image action starting after video end (${start}s > ${validDuration}s)`);
        continue;
      }

      // Clamp duration to fit within video
      if (start + actionDuration > validDuration) {
        actionDuration = Math.max(0.5, validDuration - start);
      }

      sanitizedActions.push({
        ...action,
        start,
        duration: actionDuration,
      });
    } else if (action.type === "add_caption") {
      // Validate caption actions
      let start = action.start ?? 0;
      let end = action.end ?? (start + 3);

      // Ensure timestamps are finite
      if (!Number.isFinite(start)) start = 0;
      if (!Number.isFinite(end)) end = start + 3;

      // Ensure non-negative and proper ordering
      start = Math.max(0, start);
      end = Math.max(start + 0.1, end);

      // Clamp to video duration
      end = Math.min(end, validDuration);
      if (start >= validDuration) {
        aiLogger.debug(`Skipping caption action starting after video end`);
        continue;
      }

      // Ensure caption has text - use text, transcriptContext, or derive from transcript
      let captionText = action.text || action.transcriptContext;

      // If no text provided, try to derive from transcript at this timestamp
      if (!captionText && transcript) {
        const derivedText = findTranscriptText(start, end);
        if (derivedText) {
          captionText = derivedText;
          aiLogger.debug(`Derived caption text from transcript at ${start}s: "${derivedText.substring(0, 50)}..."`);
        }
      }

      if (!captionText) {
        // Caption without text is useless - skip it
        aiLogger.debug(`Skipping caption action at ${start}s: no text available`);
        continue;
      }

      sanitizedActions.push({
        ...action,
        start,
        end,
        text: captionText, // Ensure text field is populated
      });
    } else if (action.type === "add_text_overlay") {
      // Validate text overlay actions
      let start = action.start ?? 0;
      let actionDuration = action.duration ?? 3;

      // Ensure timestamps are finite
      if (!Number.isFinite(start)) start = 0;
      if (!Number.isFinite(actionDuration)) actionDuration = 3;

      // Ensure non-negative
      start = Math.max(0, start);
      actionDuration = Math.max(0.5, Math.min(actionDuration, 30)); // 0.5-30 seconds

      // Ensure within video bounds
      if (start >= validDuration) {
        aiLogger.debug(`Skipping text overlay action starting after video end`);
        continue;
      }

      // Clamp duration to fit within video
      if (start + actionDuration > validDuration) {
        actionDuration = Math.max(0.5, validDuration - start);
      }

      sanitizedActions.push({
        ...action,
        start,
        duration: actionDuration,
      });
    } else if (action.type === "transition") {
      // Validate transition actions
      let timestamp = action.timestamp ?? 0;
      let actionDuration = action.duration ?? 0.5;

      // Ensure timestamps are finite
      if (!Number.isFinite(timestamp)) timestamp = 0;
      if (!Number.isFinite(actionDuration)) actionDuration = 0.5;

      // Ensure non-negative
      timestamp = Math.max(0, timestamp);
      actionDuration = Math.max(0.1, Math.min(actionDuration, 2)); // 0.1-2 seconds

      // Ensure within video bounds
      if (timestamp >= validDuration) {
        aiLogger.debug(`Skipping transition action at timestamp after video end`);
        continue;
      }

      sanitizedActions.push({
        ...action,
        timestamp,
        duration: actionDuration,
      });
    } else {
      // Pass through other action types for B-roll processing below
      sanitizedActions.push(action);
    }
  }

  // Now process B-roll actions specifically
  const brollActions = sanitizedActions.filter(a => a.type === "insert_stock");
  const otherActions = sanitizedActions.filter(a => a.type !== "insert_stock");

  const brollWithTiming = brollActions.map((a, index) => ({
    ...a,
    start: a.start ?? (index * 10),
  }));

  brollWithTiming.sort((a, b) => (a.start || 0) - (b.start || 0));

  const validatedBroll: EditAction[] = [];
  let lastEnd = 0;

  for (const action of brollWithTiming) {
    const start = Math.max(0, action.start || 0);
    const actionDuration = Math.max(0.5, action.duration || 4); // Only technical minimum: 0.5s

    // Only check: clip must not overlap a previous clip AND must start before video end
    const noOverlap = start >= lastEnd;
    const beforeEnd = start < validDuration - 0.1;

    if (noOverlap && beforeEnd) {
      // Clamp end to video duration
      const clampedDuration = Math.min(actionDuration, validDuration - start);
      validatedBroll.push({
        ...action,
        start,
        duration: Math.max(0.5, clampedDuration),
      });
      lastEnd = start + clampedDuration;
    } else {
      aiLogger.debug(`Skipping B-roll at ${start}s: noOverlap=${noOverlap}, beforeEnd=${beforeEnd} (lastEnd=${lastEnd}s, videoDuration=${validDuration}s)`);
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

  // Inject historical user feedback to improve plan
  const feedbackContext = getFeedbackContextForPlanning();

  const videoDuration = analysis.duration;
  const pacingGuidance = getPacingGuidanceForDuration(videoDuration);
  const contentTypeGuidance = getContentTypeGuidance(contextInfo?.genre);

  const systemPrompt = `You are an expert professional video editor with years of experience in ${contextInfo?.genre || "video"} content. Your task is to create a precise, intelligent edit plan that maximizes viewer engagement and attention while respecting the content's nature and purpose.

VIDEO CONTEXT:
- Genre: ${contextInfo?.genre || "general"}
- Tone: ${contextInfo?.tone || "casual"}
- Pacing: ${contextInfo?.pacing || "moderate"}
- Suggested Edit Style: ${contextInfo?.suggestedEditStyle || "moderate"}
- Target Audience: ${contextInfo?.targetAudience || "general viewers"}
- Video Duration: ${videoDuration.toFixed(1)} seconds (${videoDuration < 120 ? "SHORT" : videoDuration < 600 ? "MEDIUM" : "LONG"} format)
${contextInfo?.regionalContext ? `- Regional Context: ${contextInfo.regionalContext}` : ""}

${pacingGuidance}

${contentTypeGuidance}

${editStyleGuidance}

USER FEEDBACK HISTORY (LEARN FROM THIS):
${feedbackContext}
 
EDITING RULES — CUTS:
1. CUTS ARE A LAST RESORT — only cut dead silence (>2s with no speech) or major mistakes/repeated sentences. When in doubt, DO NOT cut.
2. NEVER cut in the middle of a sentence — only cut between complete thoughts at natural pause points.
3. If a segment contains a complete thought, preserve it entirely or remove it entirely.
4. DO NOT cut simply because a section seems slow — preserve the speaker's natural pace and personality.
5. Prefer fewer, more meaningful cuts over many small cuts. Choppy editing is worse than no editing.

B-ROLL PLACEMENT — USE YOUR FULL INTELLIGENCE:
6. B-roll OVERLAYS the video — the speaker's audio continues underneath. It is NOT a cut.
7. You have watched the full video and understand it completely. Use that understanding to decide WHERE, HOW LONG, and HOW MANY B-roll clips to place — the user's prompt is your primary guide.
8. There are NO forbidden zones — you may place B-roll anywhere in the video including the intro, outro, or over emotional moments IF it serves the user's vision.
9. There is NO minimum or maximum duration for B-roll — choose whatever duration makes the edit feel best for each clip.
10. There is NO required gap between B-roll clips — you may place them back-to-back or even fill the entire video with B-roll if that is what the user wants.
11. There is NO cap on total B-roll percentage — if the user wants wall-to-wall B-roll, deliver that.
12. Each B-roll should be visually relevant and match what the speaker is saying or the mood/tone the user has requested.
13. Two B-roll clips may NOT overlap the same moment in time — they can be adjacent (clip 1 ends at 10s, clip 2 starts at 10s) but cannot overlap.

AVAILABLE EDIT ACTIONS:

1. "cut" - Remove sections (audio AND video removed synchronously) — USE SPARINGLY
2. "keep" - Explicitly mark important segments to preserve
3. "insert_stock" - OVERLAY B-roll stock footage (original audio CONTINUES underneath)
4. "add_caption" - Add captions for key dialogue
5. "add_text_overlay" - Add emphasis text

B-ROLL SEARCH QUERY GUIDELINES:
- Be specific and directly match what the speaker is saying at that exact moment
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

${analysis.scenes && analysis.scenes.length > 0 ? `SCENE ANALYSIS:
${analysis.scenes.slice(0, 10).map(s => `  - ${s.start.toFixed(1)}s-${s.end.toFixed(1)}s: ${s.sceneType} - ${s.visualDescription || 'No description'} (${s.visualImportance} importance)`).join("\n")}
` : ""}
${analysis.emotionFlow && analysis.emotionFlow.length > 0 ? `EMOTION FLOW:
${analysis.emotionFlow.slice(0, 8).map(e => `  - ${e.timestamp.toFixed(1)}s: ${e.emotion} (intensity: ${e.intensity}%)`).join("\n")}
` : ""}
${analysis.speakers && analysis.speakers.length > 0 ? `SPEAKERS DETECTED:
${analysis.speakers.slice(0, 5).map(s => `  - ${s.speakerId}: ${s.start.toFixed(1)}s-${s.end.toFixed(1)}s - "${s.speakerLabel || 'Unknown'}"`).join("\n")}
` : ""}
TOPIC SEGMENTS:
${topicsSummary}

B-ROLL OPPORTUNITIES:
${brollOppsSummary}

SILENT SEGMENTS (candidates for cutting):
${analysis.silentSegments?.map(s => `  - ${s.start.toFixed(1)}s to ${s.end.toFixed(1)}s`).join("\n") || "None detected"}

TRANSCRIPT WITH CONTEXT:
${transcript.slice(0, 100).map(t => `[${t.start.toFixed(1)}s-${t.end.toFixed(1)}s]: ${t.text}`).join("\n")}
${transcript.length > 100 ? `\n... (${transcript.length - 100} more segments)` : ""}

Total video duration: ${analysis.duration.toFixed(1)} seconds

CREATE YOUR EDIT PLAN:
1. USE the pre-identified B-roll opportunities — and add more wherever they serve the user's vision
2. For each insert_stock action, include "transcriptContext" field
3. Stock queries MUST be specific to content
4. B-roll clips must NOT overlap (clip 2 must start at or after clip 1 ends) — adjacent is fine
5. Cut silent sections carefully while preserving narrative flow

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
      model: AI_CONFIG.models.editPlanning,
      contents: [{ role: "user", parts: [{ text: systemPrompt + "\n\n" + userPrompt }] }],
      config: { responseMimeType: "application/json" },
    }),
    "generateEditPlan",
    AI_RETRY_OPTIONS
  );

  const text = response.text || "";
  const fallbackPlan = (): EditPlan => {
    const keepAction: EditAction = {
      type: "keep",
      start: 0,
      end: analysis.duration,
      reason: "Keep entire video (failed to generate specific edits)",
    };
    return { actions: [keepAction], estimatedDuration: analysis.duration };
  };

  const parsed = safeJsonParse(text, aiLogger);
  if (!parsed) {
    aiLogger.warn("Failed to parse edit plan (invalid JSON), using fallback");
    return fallbackPlan();
  }

  try {
    EditPlanResponseSchema.safeParse(parsed);
  } catch (parseError) {
    aiLogger.warn("Schema validation unexpected error:", parseError);
    // schema failure is handled below by accessing props safely?
    // Actually safeJsonParse returns any. usage below checks props.
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

  const validatedActions = validateAndFixBrollActions(actions, analysis.duration, transcript);

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
  fillerSegments: { start: number; end: number; word: string }[],
  enhancedTranscript?: TranscriptEnhancedType,
  previousPlan?: EditPlan,
  arbitrationResult?: ArbitrationResult,
  projectId?: number
): Promise<EditPlan> {
  const resolvedProjectId = projectId ?? (analysis as any).projectId ?? 0;
  aiLogger.info(`[SmartEditPlan] Generating autonomous multi-pass edit plan for project ${resolvedProjectId}...`);

  // --- START AUTONOMOUS CORRECTION LOOP ---
  // If we have arbitration feedback, trigger Pass 5 (Correction) instead of a fresh plan
  if (previousPlan && arbitrationResult && arbitrationResult.shouldReRender) {
    aiLogger.info(`[Self-Correction] Triggering Pass 5 Correction for project ${resolvedProjectId} based on Arbitrator feedback`);

    // Identify actions flagged for replacement
    const flaggedActions = (arbitrationResult.correctionPlan || []).filter(a => (a as any).needsReplacement);

    // Apply learned preferences to the correction logic
    const learningCtx = await getLearningContext(analysis, prompt);

    const correctedPlan = await executePass5CorrectionPass(
      analysis,
      transcript,
      previousPlan,
      arbitrationResult.justification,
      flaggedActions,
      learningCtx
    );

    return correctedPlan;
  }
  // --- END AUTONOMOUS CORRECTION LOOP ---

  aiLogger.info("Starting optimized smart edit planning (2-pass consolidated approach)...");
  const startTime = Date.now();

  // Log rich context availability
  if (enhancedTranscript) {
    const richDataSources: string[] = [];
    if (enhancedTranscript.speakers?.length) richDataSources.push(`${enhancedTranscript.speakers.length} speakers`);
    if (enhancedTranscript.chapters?.length) richDataSources.push(`${enhancedTranscript.chapters.length} chapters`);
    if (enhancedTranscript.entities?.length) richDataSources.push(`${enhancedTranscript.entities.length} entities`);
    if (enhancedTranscript.sentiments?.length) richDataSources.push(`${enhancedTranscript.sentiments.length} sentiments`);
    if (richDataSources.length > 0) {
      aiLogger.info(`[Rich Context] Enhanced transcript data available: ${richDataSources.join(", ")}`);
    }
  }

  // PHASE 4: Apply learned preferences from previous successful edits
  const learningContext = await getLearningContext(analysis, prompt);
  if (learningContext) {
    aiLogger.info("[Learning] Applying learned preferences from successful past edits");
  }
  const learnedPreferences = await applyLearnedPreferences(analysis, prompt);
  const relevantPatterns = await retrievePatterns(["cut", "transition", "broll", "pacing"], analysis, prompt, 5);
  if (relevantPatterns.length > 0) {
    aiLogger.info(`[Learning] Found ${relevantPatterns.length} relevant patterns from past edits`);
  }

  let structuredPlan: StructuredPlan;
  let qualityMap: QualityMap;
  let brollPlan: OptimizedBrollPlan;

  // Try consolidated analysis first (1 API call instead of 3)
  try {
    aiLogger.info("Consolidated Pass: Analyzing structure, quality, and B-roll in single call...");
    const consolidated = await executeConsolidatedAnalysis(
      analysis, transcript, semanticAnalysis, fillerSegments, enhancedTranscript, prompt
    );
    structuredPlan = consolidated.structuredPlan;
    qualityMap = consolidated.qualityMap;
    brollPlan = consolidated.brollPlan;
    aiLogger.info(`Consolidated analysis complete: ${structuredPlan.narrativeArc} structure, ${qualityMap.segmentScores.length} scored segments, ${brollPlan.brollPlacements.length} B-roll placements`);
  } catch (consolidatedError) {
    // Fallback to sequential passes if consolidated fails
    aiLogger.warn("Consolidated analysis failed, falling back to sequential passes:", consolidatedError);

    aiLogger.info("Pass 1: Analyzing video structure...");
    structuredPlan = await executePass1StructureAnalysis(analysis, transcript, semanticAnalysis);
    aiLogger.debug(`Pass 1 complete: ${structuredPlan.narrativeArc} structure with ${structuredPlan.sectionMarkers.length} markers`);

    aiLogger.info("Pass 2: Assessing segment quality...");
    qualityMap = await executePass2QualityAssessment(
      analysis, transcript, semanticAnalysis, structuredPlan, fillerSegments
    );
    aiLogger.debug(`Pass 2 complete: ${qualityMap.segmentScores.length} segments scored, hook strength: ${qualityMap.hookStrength}`);

    aiLogger.info("Pass 3: Optimizing B-roll placement...");
    brollPlan = await executePass3BrollOptimization(
      analysis, transcript, semanticAnalysis, structuredPlan, qualityMap, fillerSegments, prompt
    );
    aiLogger.debug(`Pass 3 complete: ${brollPlan.brollPlacements.length} B-roll placements, ${brollPlan.fillerActions.length} filler actions`);
  }

  aiLogger.info("Final Pass: Quality review and refinement...");
  let reviewedPlan;

  // Enhance prompt with learning context from successful past edits
  const enhancedPrompt = learningContext ? `${prompt}${learningContext}` : prompt;

  try {
    reviewedPlan = await executePass4QualityReview(
      analysis, structuredPlan, qualityMap, brollPlan, enhancedPrompt
    );
    aiLogger.debug(`Final pass complete: ${reviewedPlan.actions.length} final actions, overall score: ${reviewedPlan.qualityMetrics.overallScore}`);
  } catch (error) {
    aiLogger.error("Final pass failed, using B-roll plan directly:", error);
    reviewedPlan = {
      actions: brollPlan.brollPlacements.map(p => ({
        type: "insert_stock" as const,
        start: p.start,
        end: p.start + p.duration,
        duration: p.duration,
        stockQuery: p.query,
        reason: p.reason,
        priority: p.priority,
        animationPreset: p.animationPreset,
      })),
      qualityMetrics: {
        overallScore: 70,
        narrativeFlow: "medium",
        pacing: "moderate",
        brollRelevance: "medium"
      },
      warnings: ["Final pass refinement failed"]
    };
  }

  const validatedActions = validateAndFixBrollActions(reviewedPlan.actions, analysis.duration, transcript);

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
