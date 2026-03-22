import { z } from "zod";
import { withRetry, AI_RETRY_OPTIONS } from "../../utils/retry";
import { createLogger } from "../../utils/logger";
import { getGeminiClient } from "./clients";
import { AI_CONFIG } from "../../config/ai";
import {
  normalizePriority,
  normalizeValueLevel,
  normalizeMetricPacing,
  normalizeVisualImportance,
  normalizeEditActionType,
  normalizeNarrativeArc,
  normalizeSectionType,
  normalizeFillerAction,
} from "./normalization";
import { createContextAggregator } from "./contextAggregator";
import type {
  VideoAnalysis,
  TranscriptSegment,
  SemanticAnalysis,
  EditAction,
  EditPlan,
  TranscriptEnhancedType,
} from "@shared/schema";

const aiLogger = createLogger("ai-service");

// Safe number formatting helper - handles undefined, null, NaN
function safeFixed(value: number | undefined | null, decimals: number = 1): string {
  if (value === undefined || value === null || isNaN(value)) {
    return "0";
  }
  return value.toFixed(decimals);
}

// Alias for backward compatibility
const normalizeQualityLevel = normalizeVisualImportance;
const normalizePacing = normalizeMetricPacing;
const normalizeActionType = normalizeEditActionType;

// Safe JSON parser with repair capabilities
export function safeJsonParse(text: string, logger?: any): any {
  if (!text) return null;
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1) return null;

  const jsonText = text.slice(jsonStart, jsonEnd + 1);

  try {
    return JSON.parse(jsonText);
  } catch (e) {
    try {
      // Repair: remove control chars, fix trailing commas, fix unescaped quotes if possible
      let cleaned = jsonText
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
        .replace(/,\s*([\]}])/g, '$1');
      return JSON.parse(cleaned);
    } catch (innerE) {
      if (logger) logger.warn("JSON parse failed after cleanup:", innerE);
      return null;
    }
  }
}

// Pre-process AI responses to normalize enum values before validation
function normalizeQualityMapResponse(parsed: any): any {
  if (!parsed) return parsed;

  if (parsed.segmentScores && Array.isArray(parsed.segmentScores)) {
    parsed.segmentScores = parsed.segmentScores.map((s: any) => ({
      ...s,
      valueLevel: normalizeValueLevel(s.valueLevel),
    }));
  }

  return parsed;
}

function normalizeReviewedPlanResponse(parsed: any): any {
  if (!parsed) return parsed;

  if (parsed.qualityMetrics) {
    parsed.qualityMetrics = {
      ...parsed.qualityMetrics,
      pacing: normalizePacing(parsed.qualityMetrics.pacing),
      brollRelevance: normalizeQualityLevel(parsed.qualityMetrics.brollRelevance),
      narrativeFlow: normalizeQualityLevel(parsed.qualityMetrics.narrativeFlow),
      overallScore: typeof parsed.qualityMetrics.overallScore === 'number' ? parsed.qualityMetrics.overallScore : 60,
    };
  }

  if (parsed.actions && Array.isArray(parsed.actions)) {
    parsed.actions = parsed.actions.map((a: any) => ({
      ...a,
      type: normalizeActionType(a.type),
      priority: a.priority ? normalizePriority(a.priority) : undefined,
    }));
  }

  return parsed;
}

function normalizeBrollPlanResponse(parsed: any): any {
  if (!parsed) return parsed;

  if (parsed.brollPlacements && Array.isArray(parsed.brollPlacements)) {
    parsed.brollPlacements = parsed.brollPlacements.map((b: any) => ({
      ...b,
      priority: normalizePriority(b.priority),
    }));
  }

  return parsed;
}

export interface StructuredPlan {
  introSection: { start: number; end: number } | null;
  mainContentSection: { start: number; end: number };
  outroSection: { start: number; end: number } | null;
  sectionMarkers: Array<{
    timestamp: number;
    type: "intro_end" | "section_change" | "climax" | "outro_start" | "transition";
    description: string;
  }>;
  narrativeArc: "linear" | "problem_solution" | "story" | "tutorial" | "listicle" | "conversational";
}

// Combined result from consolidated pass (reduces 3 API calls to 1)
export interface ConsolidatedAnalysisResult {
  structuredPlan: StructuredPlan;
  qualityMap: QualityMap;
  brollPlan: OptimizedBrollPlan;
}

export interface QualityMap {
  segmentScores: Array<{
    start: number;
    end: number;
    engagementScore: number;
    valueLevel: "must_keep" | "high" | "medium" | "low" | "cut_candidate";
    reason: string;
  }>;
  hookStrength: number;
  overallEngagement: number;
  lowValueSegments: Array<{ start: number; end: number; reason: string }>;
  mustKeepSegments: Array<{ start: number; end: number; reason: string }>;
}

export interface OptimizedBrollPlan {
  brollPlacements: Array<{
    start: number;
    duration: number;
    query: string;
    transcriptContext: string;
    priority: "high" | "medium" | "low";
    reason: string;
  }>;
  fillerActions: Array<{
    start: number;
    end: number;
    word: string;
    action: "cut" | "overlay";
  }>;
  cutActions: Array<{
    start: number;
    end: number;
    reason: string;
  }>;
}

export interface ReviewedEditPlan {
  actions: EditAction[];
  qualityMetrics: {
    pacing: "slow" | "moderate" | "fast";
    brollRelevance: "high" | "medium" | "low";
    narrativeFlow: "high" | "medium" | "low";
    overallScore: number;
  };
  recommendations: string[];
  warnings: string[];
}

// Schema with AI response normalization - handles variations in AI output
const StructuredPlanSchema = z.object({
  introSection: z.object({ start: z.number(), end: z.number() }).nullable(),
  mainContentSection: z.object({ start: z.number(), end: z.number() }),
  outroSection: z.object({ start: z.number(), end: z.number() }).nullable(),
  sectionMarkers: z.array(z.object({
    timestamp: z.number(),
    type: z.enum(["intro_end", "section_change", "climax", "outro_start", "transition"])
      .or(z.string().transform(normalizeSectionType)),
    description: z.string(),
  })),
  narrativeArc: z.enum(["linear", "problem_solution", "story", "tutorial", "listicle", "conversational"])
    .or(z.string().transform(normalizeNarrativeArc)),
});

const QualityMapSchema = z.object({
  segmentScores: z.array(z.object({
    start: z.number(),
    end: z.number(),
    engagementScore: z.number(),
    valueLevel: z.enum(["must_keep", "high", "medium", "low", "cut_candidate"])
      .or(z.string().transform(normalizeValueLevel)),
    reason: z.string(),
  })),
  hookStrength: z.number(),
  overallEngagement: z.number(),
  lowValueSegments: z.array(z.object({ start: z.number(), end: z.number(), reason: z.string() })),
  mustKeepSegments: z.array(z.object({ start: z.number(), end: z.number(), reason: z.string() })),
});

const OptimizedBrollPlanSchema = z.object({
  brollPlacements: z.array(z.object({
    start: z.number(),
    duration: z.number(),
    query: z.string(),
    transcriptContext: z.string(),
    priority: z.enum(["high", "medium", "low"])
      .or(z.string().transform(normalizePriority)),
    reason: z.string(),
  })),
  fillerActions: z.array(z.object({
    start: z.number(),
    end: z.number(),
    word: z.string(),
    action: z.enum(["cut", "overlay"])
      .or(z.string().transform(normalizeFillerAction)),
  })),
  cutActions: z.array(z.object({
    start: z.number(),
    end: z.number(),
    reason: z.string(),
  })),
});

const ReviewedEditPlanSchema = z.object({
  actions: z.array(z.any()),
  qualityMetrics: z.object({
    pacing: z.enum(["slow", "moderate", "fast"])
      .or(z.string().transform(normalizeMetricPacing)),
    brollRelevance: z.enum(["high", "medium", "low"])
      .or(z.string().transform(normalizeVisualImportance)),
    narrativeFlow: z.enum(["high", "medium", "low"])
      .or(z.string().transform(normalizeVisualImportance)),
    overallScore: z.number(),
  }).optional(),
  recommendations: z.array(z.string()),
  warnings: z.array(z.string()),
});

export function getBrollStyleHint(genre?: string): string {
  const hints: Record<string, string> = {
    spiritual: "serene nature, peaceful temples, soft lighting, symbolic imagery, meditation scenes",
    tutorial: "process diagrams, tools, workspaces, hands working, screen recordings",
    interview: "location establishing shots, related activities, archival footage",
    tech: "modern devices, clean interfaces, data visualization, innovation imagery",
    vlog: "location shots, lifestyle imagery, activities, travel scenes",
    motivational: "success imagery, athletes, sunrise, achievement moments, inspiring landscapes",
    documentary: "archival footage, location establishing, contextual imagery",
    educational: "diagrams, illustrations, real-world examples, demonstrations",
    entertainment: "dynamic visuals, reactions, complementary footage",
    lifestyle: "aesthetic interiors, activities, products, daily life",
    gaming: "gameplay footage, gaming setups, community events",
    music: "performance shots, instruments, concert imagery, artistic visuals",
    news: "location footage, relevant imagery, data graphics",
    review: "product shots, comparisons, detail close-ups, usage scenarios",
  };
  return hints[genre || "other"] || "contextually relevant imagery that matches the content tone";
}

export async function executePass1StructureAnalysis(
  analysis: VideoAnalysis,
  transcript: TranscriptSegment[],
  semanticAnalysis: SemanticAnalysis
): Promise<StructuredPlan> {
  const duration = analysis.duration || 0;
  const transcriptText = transcript.slice(0, 30).map(t =>
    `[${safeFixed(t.start)}s]: ${t.text}`
  ).join("\n");

  const prompt = `You are an expert video structure analyst. Analyze this video to identify its structural components.

VIDEO ANALYSIS:
- Duration: ${safeFixed(duration)} seconds
- Genre: ${analysis.context?.genre || "general"}
- Tone: ${analysis.context?.tone || "casual"}
- Existing narrative structure: ${JSON.stringify(analysis.narrativeStructure || {})}

SEMANTIC ANALYSIS:
- Main topics: ${semanticAnalysis.mainTopics.join(", ")}
- Structure hints: ${JSON.stringify(semanticAnalysis.structureAnalysis || {})}
- Topic flow: ${JSON.stringify(semanticAnalysis.topicFlow?.slice(0, 5) || [])}

TRANSCRIPT (first 30 segments):
${transcriptText}

ANALYZE THE VIDEO STRUCTURE:

1. INTRO SECTION: Identify where the introduction ends (typically 5-30 seconds)
2. MAIN CONTENT SECTION: Core content that delivers value
3. OUTRO SECTION: Identify where conclusion begins (typically last 10-60 seconds)
4. SECTION MARKERS: Key structural points where topics change or transitions occur
5. NARRATIVE ARC: Classify the overall structure

Respond in JSON format only (no markdown):
{
  "introSection": {"start": 0, "end": number} | null,
  "mainContentSection": {"start": number, "end": number},
  "outroSection": {"start": number, "end": ${safeFixed(duration)}} | null,
  "sectionMarkers": [
    {"timestamp": number, "type": "intro_end|section_change|climax|outro_start|transition", "description": "string"}
  ],
  "narrativeArc": "linear|problem_solution|story|tutorial|listicle|conversational"
}`;

  try {
    const response = await withRetry(
      () => getGeminiClient().models.generateContent({
        model: AI_CONFIG.models.editPlanning,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { responseMimeType: "application/json" },
      }),
      "pass1StructureAnalysis",
      AI_RETRY_OPTIONS
    );

    const text = response.text || "";
    const parsed = safeJsonParse(text, aiLogger);
    if (!parsed) {
      aiLogger.warn("Pass 1: Failed to parse structure analysis (invalid JSON), using defaults");
      return getDefaultStructuredPlan(duration, analysis, semanticAnalysis);
    }
    const validated = StructuredPlanSchema.safeParse(parsed);
    if (!validated.success) {
      aiLogger.warn("Pass 1: Schema validation failed, using defaults:", validated.error.issues);
      return getDefaultStructuredPlan(duration, analysis, semanticAnalysis);
    }

    return {
      introSection: validated.data.introSection || null,
      mainContentSection: validated.data.mainContentSection || { start: 0, end: duration },
      outroSection: validated.data.outroSection || null,
      sectionMarkers: validated.data.sectionMarkers.map((m) => ({
        timestamp: m.timestamp,
        type: m.type,
        description: m.description,
      })),
      narrativeArc: validated.data.narrativeArc,
    };
  } catch (error) {
    aiLogger.error("Pass 1 error:", error);
    return getDefaultStructuredPlan(duration, analysis, semanticAnalysis);
  }
}

function getDefaultStructuredPlan(
  duration: number,
  analysis: VideoAnalysis,
  semanticAnalysis: SemanticAnalysis
): StructuredPlan {
  const introEnd = semanticAnalysis.structureAnalysis?.introEnd ||
    analysis.narrativeStructure?.introEnd ||
    Math.min(10, duration * 0.1);
  const outroStart = semanticAnalysis.structureAnalysis?.outroStart ||
    analysis.narrativeStructure?.outroStart ||
    Math.max(duration - 15, duration * 0.9);

  return {
    introSection: introEnd > 3 ? { start: 0, end: introEnd } : null,
    mainContentSection: { start: introEnd || 0, end: outroStart || duration },
    outroSection: outroStart < duration - 5 ? { start: outroStart, end: duration } : null,
    sectionMarkers: [],
    narrativeArc: "linear",
  };
}

export async function executePass2QualityAssessment(
  analysis: VideoAnalysis,
  transcript: TranscriptSegment[],
  semanticAnalysis: SemanticAnalysis,
  structuredPlan: StructuredPlan,
  fillerSegments: { start: number; end: number; word: string }[]
): Promise<QualityMap> {
  const duration = analysis.duration;

  const keyMomentsSummary = [
    ...(analysis.keyMoments || []).map(k => `[${safeFixed(k.timestamp)}s] ${k.type}: ${k.description} (${k.importance})`),
    ...(semanticAnalysis.keyMoments || []).map(k => `[${safeFixed(k.timestamp)}s] ${k.description} (${k.importance})`),
  ].slice(0, 15).join("\n");

  const scenesSummary = (analysis.scenes || []).slice(0, 10).map(s =>
    `[${safeFixed(s.start)}s-${safeFixed(s.end)}s] ${s.sceneType} - ${s.emotionalTone}, visual importance: ${s.visualImportance}`
  ).join("\n");

  const emotionFlowSummary = (analysis.emotionFlow || []).slice(0, 10).map(e =>
    `[${safeFixed(e.timestamp)}s] ${e.emotion} (intensity: ${e.intensity})`
  ).join("\n");

  const prompt = `You are an expert video quality analyst. Score each segment of this video for engagement potential.

VIDEO INFO:
- Duration: ${safeFixed(duration)} seconds
- Genre: ${analysis.context?.genre || "general"}
- Hook moments detected: ${JSON.stringify(semanticAnalysis.hookMoments?.slice(0, 3) || [])}
- Filler words count: ${fillerSegments.length}

STRUCTURE (from Pass 1):
- Intro: ${structuredPlan.introSection ? `${structuredPlan.introSection.start}s-${structuredPlan.introSection.end}s` : "None"}
- Main content: ${structuredPlan.mainContentSection.start}s-${structuredPlan.mainContentSection.end}s
- Outro: ${structuredPlan.outroSection ? `${structuredPlan.outroSection.start}s-${structuredPlan.outroSection.end}s` : "None"}
- Narrative arc: ${structuredPlan.narrativeArc}

KEY MOMENTS DETECTED:
${keyMomentsSummary || "None"}

SCENES DETECTED:
${scenesSummary || "None"}

EMOTION FLOW:
${emotionFlowSummary || "None"}

FILLER SEGMENTS (partial):
${fillerSegments.slice(0, 10).map(f => `[${safeFixed(f.start)}s] "${f.word}"`).join(", ")}

SCORING GUIDELINES:
- 80-100: MUST KEEP - Key moments, climaxes, important reveals, strong hooks
- 60-79: HIGH VALUE - Good content, engaging, contributes to narrative
- 40-59: MEDIUM VALUE - Acceptable but not essential, could be trimmed
- 20-39: LOW VALUE - Filler, tangents, low energy sections
- 0-19: CUT CANDIDATE - Dead air, mistakes, very low value content

Break the video into 5-15 segments based on content quality shifts.

Respond in JSON format only (no markdown):
{
  "segmentScores": [
    {"start": number, "end": number, "engagementScore": number (0-100), "valueLevel": "must_keep|high|medium|low|cut_candidate", "reason": "why this score"}
  ],
  "hookStrength": number (0-100),
  "overallEngagement": number (0-100),
  "lowValueSegments": [{"start": number, "end": number, "reason": "string"}],
  "mustKeepSegments": [{"start": number, "end": number, "reason": "string"}]
}`;

  try {
    const response = await withRetry(
      () => getGeminiClient().models.generateContent({
        model: AI_CONFIG.models.editPlanning,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { responseMimeType: "application/json" },
      }),
      "pass2QualityAssessment",
      AI_RETRY_OPTIONS
    );

    const text = response.text || "";
    const parsed = safeJsonParse(text, aiLogger);
    if (!parsed) {
      aiLogger.warn("Pass 2: Failed to parse quality assessment (invalid JSON), using defaults");
      return getDefaultQualityMap(duration, semanticAnalysis);
    }

    const normalized = normalizeQualityMapResponse(parsed);
    const validated = QualityMapSchema.safeParse(normalized);
    if (!validated.success) {
      aiLogger.warn("Pass 2: Schema validation failed, using defaults:", validated.error.issues);
      return getDefaultQualityMap(duration, semanticAnalysis);
    }

    return {
      segmentScores: validated.data.segmentScores,
      hookStrength: validated.data.hookStrength,
      overallEngagement: validated.data.overallEngagement,
      lowValueSegments: validated.data.lowValueSegments,
      mustKeepSegments: validated.data.mustKeepSegments,
    };
  } catch (error) {
    aiLogger.error("Pass 2 error:", error);
    return getDefaultQualityMap(duration, semanticAnalysis);
  }
}

function getDefaultQualityMap(duration: number, semanticAnalysis: any): QualityMap {
  const hookStrength = semanticAnalysis?.hookStrength || 60;
  return {
    segmentScores: [{ start: 0, end: duration, engagementScore: 60, valueLevel: "medium", reason: "Default assessment due to error" }],
    hookStrength,
    overallEngagement: 60,
    lowValueSegments: [],
    mustKeepSegments: [],
  };
}

export async function executePass3BrollOptimization(
  analysis: VideoAnalysis,
  transcript: TranscriptSegment[],
  semanticAnalysis: SemanticAnalysis,
  structuredPlan: StructuredPlan,
  qualityMap: QualityMap,
  fillerSegments: { start: number; end: number; word: string }[]
): Promise<OptimizedBrollPlan> {
  const duration = analysis.duration;
  const genre = analysis.context?.genre || "general";
  const tone = analysis.context?.tone || "casual";

  const lowImportanceScenes = (analysis.scenes || [])
    .filter(s => s.visualImportance === "low" || s.visualImportance === "medium")
    .map(s => `[${safeFixed(s.start)}s-${safeFixed(s.end)}s] ${s.visualDescription || s.sceneType}`);

  const brollWindowsSummary = semanticAnalysis.brollWindows.slice(0, 12).map(b =>
    `[${safeFixed(b.start)}s-${safeFixed(b.end)}s] Context: "${b.context}" - Query: "${b.suggestedQuery}" (${b.priority})`
  ).join("\n");

  const lowValueSummary = qualityMap.lowValueSegments.map(s =>
    `[${safeFixed(s.start)}s-${safeFixed(s.end)}s] ${s.reason}`
  ).join("\n");

  const transcriptContext = transcript.slice(0, 25).map(t =>
    `[${safeFixed(t.start)}s-${safeFixed(t.end)}s]: ${t.text}`
  ).join("\n");

  const prompt = `You are an expert B-roll optimization specialist. Create an intelligent B-roll placement plan.

VIDEO CONTEXT:
- Duration: ${safeFixed(duration)} seconds
- Genre: ${genre}
- Tone: ${tone}
- B-roll style hint: ${getBrollStyleHint(genre)}

STRUCTURE:
- Main content: ${structuredPlan.mainContentSection.start}s-${structuredPlan.mainContentSection.end}s
- Narrative arc: ${structuredPlan.narrativeArc}

LOW VISUAL IMPORTANCE SCENES (safe for B-roll overlay):
${lowImportanceScenes.slice(0, 10).join("\n") || "None identified"}

SEMANTIC B-ROLL WINDOWS (from transcript analysis):
${brollWindowsSummary || "None identified"}

LOW VALUE SEGMENTS (from quality assessment):
${lowValueSummary || "None identified"}

FILLER WORDS DETECTED:
${fillerSegments.slice(0, 15).map(f => `[${safeFixed(f.start)}s-${safeFixed(f.end)}s] "${f.word}"`).join("\n")}

TRANSCRIPT CONTEXT:
${transcriptContext}

B-ROLL OPTIMIZATION RULES:
1. Use ULTRA-SPECIFIC queries based on exact transcript context
2. Match genre/tone: ${genre} content should get ${tone} imagery
3. YOU DECIDE placement, duration, count, and spacing — there are no enforced limits. Place B-roll wherever it serves the edit best.
4. Two clips may NOT overlap the same moment in time (clip 2 must start at or after clip 1 ends)
5. B-roll may appear anywhere in the video — intro, outro, emotional moments, or continuously if that is the right creative choice
6. Duration: YOU DECIDE what feels right for each clip. Minimum 0.5s (technical floor only).

Respond in JSON format only (no markdown):
{
  "brollPlacements": [
    {"start": number, "duration": number, "query": "ULTRA-SPECIFIC search query", "transcriptContext": "what speaker is saying", "priority": "high|medium|low", "reason": "why B-roll here"}
  ],
  "fillerActions": [{"start": number, "end": number, "word": "the filler word", "action": "cut|overlay"}],
  "cutActions": [{"start": number, "end": number, "reason": "why to cut this segment"}]
}`;

  try {
    const response = await withRetry(
      () => getGeminiClient().models.generateContent({
        model: AI_CONFIG.models.editPlanning,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { responseMimeType: "application/json" },
      }),
      "pass3BrollOptimization",
      AI_RETRY_OPTIONS
    );

    const text = response.text || "";
    const parsed = safeJsonParse(text, aiLogger);
    if (!parsed) {
      aiLogger.warn("Pass 3: Failed to parse B-roll optimization (invalid JSON), using defaults");
      return getDefaultBrollPlan(duration, semanticAnalysis, fillerSegments);
    }
    const normalized = normalizeBrollPlanResponse(parsed);
    const validated = OptimizedBrollPlanSchema.safeParse(normalized);
    if (!validated.success) {
      aiLogger.warn("Pass 3: Schema validation failed, using defaults:", validated.error.issues);
      return getDefaultBrollPlan(duration, semanticAnalysis, fillerSegments);
    }

    const brollPlacements = validateBrollSpacing(
      validated.data.brollPlacements.map((b) => ({
        start: Math.max(0, b.start),
        duration: Math.max(0.5, b.duration), // Only technical minimum
        query: b.query || "background footage",
        transcriptContext: b.transcriptContext,
        priority: b.priority,
        reason: b.reason,
      })),
      duration
    );

    return {
      brollPlacements,
      fillerActions: validated.data.fillerActions,
      cutActions: validated.data.cutActions,
    };
  } catch (error) {
    aiLogger.error("Pass 3 error:", error);
    return getDefaultBrollPlan(duration, semanticAnalysis, fillerSegments);
  }
}

function validateBrollSpacing(
  placements: Array<{ start: number; duration: number; query: string; transcriptContext: string; priority: string; reason: string }>,
  duration: number
): Array<{ start: number; duration: number; query: string; transcriptContext: string; priority: "high" | "medium" | "low"; reason: string }> {
  const sorted = [...placements].sort((a, b) => a.start - b.start);
  const validated: Array<{ start: number; duration: number; query: string; transcriptContext: string; priority: "high" | "medium" | "low"; reason: string }> = [];
  let lastEnd = 0;

  const validDuration = (duration && !isNaN(duration) && duration > 0) ? duration : 300;

  for (const placement of sorted) {
    // Only technical constraints: no overlapping clips AND must start before video ends
    const noOverlap = placement.start >= lastEnd;
    const beforeEnd = placement.start < validDuration - 0.1;

    if (noOverlap && beforeEnd) {
      // Clamp end to video duration
      const clampedDuration = Math.min(placement.duration, validDuration - placement.start);
      validated.push({ ...placement, duration: Math.max(0.5, clampedDuration), priority: placement.priority as "high" | "medium" | "low" });
      lastEnd = placement.start + clampedDuration;
    } else {
      aiLogger.debug(`Pass 3: Skipping B-roll at ${placement.start}s: noOverlap=${noOverlap}, beforeEnd=${beforeEnd} (lastEnd=${lastEnd}s, duration=${validDuration}s)`);
    }
  }

  return validated;
}

function getDefaultBrollPlan(
  duration: number,
  semanticAnalysis: SemanticAnalysis,
  fillerSegments: { start: number; end: number; word: string }[]
): OptimizedBrollPlan {
  // No artificial limits - use all valid B-roll windows from semantic analysis
  const brollPlacements = semanticAnalysis.brollWindows
    .filter(b => b.start !== undefined && b.suggestedQuery)
    .map(b => ({
      start: b.start,
      duration: Math.min(5, b.end - b.start),
      query: b.suggestedQuery,
      transcriptContext: b.context,
      priority: (b.priority || "medium") as "low" | "medium" | "high",
      reason: b.reason,
    }));

  // No artificial limits on filler actions
  const fillerActions = fillerSegments
    .filter(f => (f.end - f.start) < 1)
    .map(f => ({ start: f.start, end: f.end, word: f.word, action: "cut" as const }));

  return { brollPlacements, fillerActions, cutActions: [] };
}

// CONSOLIDATED PASS: Combines Passes 1-3 into a single API call for efficiency
// Now accepts enhancedTranscript for rich context (speakers, chapters, entities, sentiment)
export async function executeConsolidatedAnalysis(
  analysis: VideoAnalysis,
  transcript: TranscriptSegment[],
  semanticAnalysis: SemanticAnalysis,
  fillerSegments: { start: number; end: number; word: string }[],
  enhancedTranscript?: TranscriptEnhancedType
): Promise<ConsolidatedAnalysisResult> {
  const duration = analysis.duration || 0;
  const genre = analysis.context?.genre || "general";
  const tone = analysis.context?.tone || "casual";

  // Create context aggregator to unify all analysis data
  const contextAggregator = createContextAggregator(
    analysis,
    transcript,
    semanticAnalysis,
    enhancedTranscript
  );

  // Generate rich context from all underused data sources
  const richContextData = contextAggregator.generateEditPlanningContext();
  const unifiedContext = contextAggregator.getUnifiedContext();

  aiLogger.info(`[Context Aggregator] Data sources available: ${Object.entries(unifiedContext.hasData).filter(([_, v]) => v).map(([k]) => k).join(", ")}`);

  // Extract enhancedAnalysis data for intelligent editing decisions (now properly typed in VideoAnalysis)
  const enhancedAnalysis = analysis.enhancedAnalysis;
  const motionAnalysis = enhancedAnalysis?.motionAnalysis;
  const transitionAnalysis = enhancedAnalysis?.transitionAnalysis;
  const pacingAnalysis = enhancedAnalysis?.pacingAnalysis;
  const audioVisualSync = enhancedAnalysis?.audioVisualSync;

  const transcriptText = transcript.slice(0, 40).map(t =>
    `[${safeFixed(t.start)}s-${safeFixed(t.end)}s]: ${t.text}`
  ).join("\n");

  const keyMomentsSummary = [
    ...(analysis.keyMoments || []).map(k => `[${safeFixed(k.timestamp)}s] ${k.type}: ${k.description}`),
    ...(semanticAnalysis.keyMoments || []).map(k => `[${safeFixed(k.timestamp)}s] ${k.description}`),
  ].slice(0, 10).join("\n");

  const brollWindowsSummary = semanticAnalysis.brollWindows.slice(0, 10).map(b =>
    `[${safeFixed(b.start)}s-${safeFixed(b.end)}s] "${b.suggestedQuery}" - ${b.context}`
  ).join("\n");

  // Build motion analysis context for AI
  const motionContext = motionAnalysis ? `
MOTION ANALYSIS (from full video watching):
- Overall Motion Intensity: ${motionAnalysis.motionIntensity || "unknown"}
- Has Significant Motion: ${motionAnalysis.hasSignificantMotion ? "YES" : "NO"}
${(motionAnalysis.actionSequences?.length || 0) > 0 ? `- Action Sequences:\n${motionAnalysis.actionSequences!.slice(0, 5).map((a) => `  [${safeFixed(a.start)}s-${safeFixed(a.end)}s]: ${a.description}`).join("\n")}` : ""}
MOTION EDITING GUIDANCE:
- For HIGH motion segments: Use shorter B-roll (2-3s), prefer VIDEO over images
- For LOW motion segments: Can use longer B-roll (4-6s), images work well
- Place B-roll during action sequences to enhance visual interest` : "";

  // Build transition analysis context for AI
  const transitionContext = transitionAnalysis ? `
DETECTED NATURAL TRANSITIONS:
${transitionAnalysis.detectedTransitions?.slice(0, 8).map((t) => `  [${safeFixed(t.timestamp)}s]: ${t.type} - ${t.description}`).join("\n") || "None detected"}
${(transitionAnalysis.suggestedTransitionPoints?.length || 0) > 0 ? `SUGGESTED CUT POINTS: ${transitionAnalysis.suggestedTransitionPoints!.slice(0, 10).map((t: number) => `${safeFixed(t)}s`).join(", ")}` : ""}
TRANSITION GUIDANCE: Use these natural transition points for cuts and B-roll insertions` : "";

  // Build pacing analysis context for AI  
  const pacingContext = pacingAnalysis ? `
PACING ANALYSIS:
- Overall Pacing: ${pacingAnalysis.overallPacing || "moderate"}
- Pacing Variation: ${pacingAnalysis.pacingVariation || 50}%
${(pacingAnalysis.suggestedPacingAdjustments?.length || 0) > 0 ? `PACING ADJUSTMENTS NEEDED:\n${pacingAnalysis.suggestedPacingAdjustments!.slice(0, 5).map((p) => `  [${safeFixed(p.timestamp)}s]: ${p.suggestion}`).join("\n")}` : ""}
PACING GUIDANCE:
- SLOW pacing: Add more B-roll, use quick cuts to increase energy
- FAST pacing: Use minimal B-roll, let content breathe
- Match B-roll duration to pacing: fast=2-3s, moderate=3-4s, slow=4-5s` : "";

  // Build sync quality context
  const syncContext = audioVisualSync ? `
AUDIO-VISUAL SYNC:
- Sync Quality: ${audioVisualSync.syncQuality || "good"}
${(audioVisualSync.outOfSyncMoments?.length || 0) > 0 ? `- Sync Issues:\n${audioVisualSync.outOfSyncMoments!.slice(0, 5).map((m) => `  [${safeFixed(m.timestamp)}s]: ${m.issue}`).join("\n")}` : ""}` : "";

  const prompt = `You are an expert video editor with deep understanding of narrative, emotion, and visual storytelling. Perform a COMPREHENSIVE analysis of this video in a single pass.

VIDEO METADATA:
- Duration: ${safeFixed(duration)} seconds
- Genre: ${genre}
- Tone: ${tone}
- Existing narrative hints: ${JSON.stringify(analysis.narrativeStructure || {})}
${motionContext}
${transitionContext}
${pacingContext}
${syncContext}

${richContextData}

SEMANTIC ANALYSIS:
- Main topics: ${semanticAnalysis.mainTopics.join(", ")}
- Overall tone: ${semanticAnalysis.overallTone}
- Content summary: ${semanticAnalysis.contentSummary}

KEY MOMENTS DETECTED:
${keyMomentsSummary || "None"}

EXISTING B-ROLL WINDOWS (from transcript analysis):
${brollWindowsSummary || "None"}

FILLER WORDS (${fillerSegments.length} total):
${fillerSegments.slice(0, 15).map(f => `[${safeFixed(f.start)}s] "${f.word}"`).join(", ")}

TRANSCRIPT:
${transcriptText}

ANALYZE AND PROVIDE:

1. STRUCTURE ANALYSIS - Identify intro/main/outro sections and key structural markers
2. QUALITY ASSESSMENT - Score segments (0-100) for engagement and value
3. B-ROLL OPTIMIZATION - Plan optimal B-roll placements with ULTRA-SPECIFIC queries

INTELLIGENT EDITING RULES (use the rich context data above):
- USE SPEAKER DATA: Prefer cuts during speaker transitions, not mid-sentence
- USE EMOTION DATA: Slow down during emotional peaks, add emphasis at high-intensity moments
- USE SCENE DATA: Use scene boundaries as natural transition points
- USE ENTITY DATA: When entities (people, places, things) are mentioned, use them in B-roll queries
- USE SENTIMENT DATA: Match B-roll mood to sentiment (positive = upbeat, negative = subdued)
- USE CHAPTER DATA: Respect chapter boundaries for natural section breaks
- AUTONOMOUS CONFLICT RESOLUTION: If different data sources suggest conflicting edits (e.g., motion says 'cut' but speaker says 'keep'), prioritize SPEAKER data for informative content and MOTION data for entertainment/b-roll.
- SELF-CORRECTION: Your first priority is narrative continuity. Ensure every cut has a justification rooted in quality assessment.

B-ROLL PLACEMENT DECISIONS (explain your reasoning):
- DECIDE where B-roll will add the most value — you have full creative freedom
- DO add B-roll when the speaker is describing something visual, during montage sections, or when visual variety improves engagement
- PREFER VIDEO over images during high-motion segments
- PREFER IMAGES during reflective/calm segments
- USE ENTITIES mentioned in transcript for specific B-roll queries
- Two clips must NOT overlap in time (clip 2 must start at or after clip 1 ends)

B-ROLL RULES:
- YOU DECIDE placement, count, duration, and spacing — no caps, no forbidden zones, no minimum gaps enforced
- B-roll may cover the intro, outro, emotional moments, or the entire video if that is the right creative call
- Duration: YOU DECIDE what feels right per clip. Minimum 0.5s (technical floor only).
- Match ${genre} content with ${tone} imagery
- Use ${getBrollStyleHint(genre)}
- NO PLACEHOLDERS: All search queries must be real, descriptive, and content-relevant.
- JSON STRICTNESS: Respond ONLY with a valid JSON object. No markdown, no backticks, no explanatory text outside the JSON.

Respond in JSON only (no markdown):
{
  "structure": {
    "introSection": {"start": 0, "end": number} | null,
    "mainContentSection": {"start": number, "end": number},
    "outroSection": {"start": number, "end": number} | null,
    "sectionMarkers": [{"timestamp": number, "type": "intro_end|section_change|climax|outro_start|transition", "description": "string"}],
    "narrativeArc": "linear|problem_solution|story|tutorial|listicle|conversational"
  },
  "quality": {
    "segmentScores": [{"start": number, "end": number, "engagementScore": 0-100, "valueLevel": "must_keep|high|medium|low|cut_candidate", "reason": "string", "speakerId": "speaker_1|null", "emotionAtPoint": "emotion|null"}],
    "hookStrength": 0-100,
    "overallEngagement": 0-100,
    "lowValueSegments": [{"start": number, "end": number, "reason": "string", "isSpeakerChange": boolean}],
    "mustKeepSegments": [{"start": number, "end": number, "reason": "string", "isKeyMoment": boolean}]
  },
  "broll": {
    "brollPlacements": [{"start": number, "duration": 2-6, "query": "SPECIFIC search query using entities if mentioned", "transcriptContext": "what speaker says", "priority": "high|medium|low", "reason": "string", "preferVideo": boolean, "emotionMatch": "emotion to match", "shouldUseBroll": true, "whyBroll": "explanation of why B-roll is appropriate here"}],
    "fillerActions": [{"start": number, "end": number, "word": "string", "action": "cut|overlay"}],
    "cutActions": [{"start": number, "end": number, "reason": "string", "isSpeakerChange": boolean, "isSceneBoundary": boolean}]
  },
  "planReasoning": {
    "overallApproach": "explanation of editing strategy",
    "dataSourcesUsed": ["speakers", "emotions", "scenes", "entities", "chapters", "sentiment"],
    "confidenceScore": 0-100,
    "keyDecisions": [{"decision": "what was decided", "reason": "why", "dataSource": "which data informed this"}]
  }
}`;

  try {
    const response = await withRetry(
      () => getGeminiClient().models.generateContent({
        model: AI_CONFIG.models.editPlanning,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      }),
      "consolidatedAnalysis",
      AI_RETRY_OPTIONS
    );

    const text = response.text || "";
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');

    if (jsonStart === -1 || jsonEnd === -1) {
      aiLogger.warn("Consolidated analysis: No JSON found, using defaults");
      return getDefaultConsolidatedResult(duration, analysis, semanticAnalysis, fillerSegments);
    }

    const jsonText = text.slice(jsonStart, jsonEnd + 1)
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
      .replace(/\\n/g, " ")
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      try {
        const cleanedJson = jsonText.replace(/,\s*([\]}])/g, '$1');
        parsed = JSON.parse(cleanedJson);
      } catch (innerE) {
        aiLogger.error("Consolidated analysis: JSON parse failed, using defaults");
        return getDefaultConsolidatedResult(duration, analysis, semanticAnalysis, fillerSegments);
      }
    }

    // Extract and validate structure
    const structuredPlan: StructuredPlan = {
      introSection: parsed.structure?.introSection || null,
      mainContentSection: parsed.structure?.mainContentSection || { start: 0, end: duration },
      outroSection: parsed.structure?.outroSection || null,
      sectionMarkers: (parsed.structure?.sectionMarkers || []).map((m: any) => ({
        timestamp: m.timestamp,
        type: normalizeSectionType(m.type),
        description: m.description || "",
      })),
      narrativeArc: normalizeNarrativeArc(parsed.structure?.narrativeArc || "linear"),
    };

    // Extract and validate quality map
    const qualityData = parsed.quality || {};
    const qualityMap: QualityMap = {
      segmentScores: (qualityData.segmentScores || []).map((s: any) => ({
        start: s.start,
        end: s.end,
        engagementScore: s.engagementScore || 60,
        valueLevel: normalizeValueLevel(s.valueLevel || "medium"),
        reason: s.reason || "",
      })),
      hookStrength: qualityData.hookStrength || 60,
      overallEngagement: qualityData.overallEngagement || 60,
      lowValueSegments: qualityData.lowValueSegments || [],
      mustKeepSegments: qualityData.mustKeepSegments || [],
    };

    // Extract and validate B-roll plan
    const brollData = parsed.broll || {};
    const brollPlacements = validateBrollSpacing(
      (brollData.brollPlacements || []).map((b: any) => ({
        start: Math.max(0, b.start),
        duration: Math.max(0.5, b.duration || 4), // Only technical minimum
        query: b.query || "background footage",
        transcriptContext: b.transcriptContext || "",
        priority: normalizePriority(b.priority || "medium"),
        reason: b.reason || "",
      })),
      duration
    );

    const brollPlan: OptimizedBrollPlan = {
      brollPlacements,
      fillerActions: (brollData.fillerActions || []).map((f: any) => ({
        start: f.start,
        end: f.end,
        word: f.word,
        action: normalizeFillerAction(f.action || "cut"),
      })),
      cutActions: brollData.cutActions || [],
    };

    aiLogger.info(`Consolidated analysis complete: ${structuredPlan.sectionMarkers.length} markers, ${qualityMap.segmentScores.length} scored segments, ${brollPlan.brollPlacements.length} B-roll placements`);

    return { structuredPlan, qualityMap, brollPlan };
  } catch (error) {
    aiLogger.error("Consolidated analysis error:", error);
    return getDefaultConsolidatedResult(duration, analysis, semanticAnalysis, fillerSegments);
  }
}

function getDefaultConsolidatedResult(
  duration: number,
  analysis: VideoAnalysis,
  semanticAnalysis: SemanticAnalysis,
  fillerSegments: { start: number; end: number; word: string }[]
): ConsolidatedAnalysisResult {
  const structuredPlan = getDefaultStructuredPlan(duration, analysis, semanticAnalysis);
  const qualityMap = getDefaultQualityMap(duration, semanticAnalysis);
  const brollPlan = getDefaultBrollPlan(duration, semanticAnalysis, fillerSegments);

  return { structuredPlan, qualityMap, brollPlan };
}

export async function executePass4QualityReview(
  analysis: VideoAnalysis,
  structuredPlan: StructuredPlan,
  qualityMap: QualityMap,
  brollPlan: OptimizedBrollPlan,
  prompt: string
): Promise<ReviewedEditPlan> {
  const duration = analysis.duration;
  const genre = analysis.context?.genre || "general";

  const preliminaryActions: EditAction[] = [];

  for (const segment of qualityMap.mustKeepSegments) {
    preliminaryActions.push({ type: "keep", start: segment.start, end: segment.end, reason: segment.reason, priority: "high" });
  }

  for (const cut of brollPlan.cutActions) {
    preliminaryActions.push({ type: "cut", start: cut.start, end: cut.end, reason: cut.reason });
  }

  for (const filler of brollPlan.fillerActions.filter(f => f.action === "cut")) {
    preliminaryActions.push({ type: "cut", start: filler.start, end: filler.end, reason: `Cut filler word: "${filler.word}"` });
  }

  for (const broll of brollPlan.brollPlacements) {
    preliminaryActions.push({
      type: "insert_stock",
      start: broll.start,
      duration: broll.duration,
      stockQuery: broll.query,
      transcriptContext: broll.transcriptContext,
      reason: broll.reason,
      priority: broll.priority,
    });
  }

  const actionsSummary = preliminaryActions.slice(0, 20).map(a => {
    if (a.type === "insert_stock") return `[${safeFixed(a.start)}s] insert_stock: "${a.stockQuery}" (${a.duration}s)`;
    if (a.type === "cut") return `[${safeFixed(a.start)}s-${safeFixed(a.end)}s] cut: ${a.reason}`;
    if (a.type === "keep") return `[${safeFixed(a.start)}s-${safeFixed(a.end)}s] keep: ${a.reason}`;
    return `[${safeFixed(a.start)}s] ${a.type}`;
  }).join("\n");

  const reviewPrompt = `You are a senior video editor performing quality review. Review this edit plan for consistency and quality.

USER'S EDITING INSTRUCTIONS: "${prompt}"

VIDEO INFO:
- Duration: ${safeFixed(duration)} seconds
- Genre: ${genre}
- Overall engagement: ${qualityMap.overallEngagement}
- Hook strength: ${qualityMap.hookStrength}

STRUCTURE:
- Intro: ${structuredPlan.introSection ? `${structuredPlan.introSection.start}s-${structuredPlan.introSection.end}s` : "None"}
- Main content: ${structuredPlan.mainContentSection.start}s-${structuredPlan.mainContentSection.end}s
- Outro: ${structuredPlan.outroSection ? `${structuredPlan.outroSection.start}s-${structuredPlan.outroSection.end}s` : "None"}

PRELIMINARY ACTIONS (${preliminaryActions.length} total):
${actionsSummary}

REVIEW CHECKLIST:
1. NO OVERLAPPING B-ROLL CLIPS (each clip must start at or after the previous one ends)
2. NARRATIVE FLOW - edits should preserve story arc
3. PACING - matches content type (${genre}) and user's prompt
4. B-ROLL RELEVANCE - queries match transcript context
5. CREATIVE FREEDOM - do not add artificial spacing or zone restrictions

Generate the FINAL reviewed and refined edit plan.

Respond in JSON format only (no markdown):
{
  "actions": [
    {"type": "keep|cut|insert_stock|add_caption|transition", "start": number, "end": number, "duration": number, "stockQuery": "string", "transcriptContext": "string", "reason": "string", "priority": "high|medium|low", "qualityScore": number (0-100)}
  ],
  "qualityMetrics": {"pacing": "slow|moderate|fast", "brollRelevance": "high|medium|low", "narrativeFlow": "high|medium|low", "overallScore": number (0-100)},
  "recommendations": ["improvement suggestions"],
  "warnings": ["potential issues detected"]
}`;

  try {
    const response = await withRetry(
      () => getGeminiClient().models.generateContent({
        model: AI_CONFIG.models.editPlanning,
        contents: [{ role: "user", parts: [{ text: reviewPrompt }] }],
      }),
      "pass4QualityReview",
      AI_RETRY_OPTIONS
    );

    const text = response.text || "";
    // Robust JSON extraction for potential malformed AI responses
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');

    if (jsonStart === -1 || jsonEnd === -1) {
      aiLogger.warn("Pass 4: No JSON block found in response, using preliminary actions");
      return getDefaultReviewedPlan(preliminaryActions, qualityMap, duration);
    }

    const jsonText = text.slice(jsonStart, jsonEnd + 1)
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, "") // Remove control characters
      .replace(/\\n/g, " ") // Normalize newlines inside strings
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      aiLogger.warn("Pass 4: JSON.parse failed, attempting cleanup");
      try {
        const cleanedJson = jsonText.replace(/,\s*([\]}])/g, '$1'); // Remove trailing commas
        parsed = JSON.parse(cleanedJson);
      } catch (innerE) {
        aiLogger.error("Pass 4: JSON.parse failed even after cleanup, using preliminary actions");
        return getDefaultReviewedPlan(preliminaryActions, qualityMap, duration);
      }
    }
    const normalized = normalizeReviewedPlanResponse(parsed);
    const validated = ReviewedEditPlanSchema.safeParse(normalized);
    if (!validated.success) {
      aiLogger.warn("Pass 4: Schema validation failed, using preliminary actions:", validated.error.issues);
      return getDefaultReviewedPlan(preliminaryActions, qualityMap, duration);
    }

    const reviewedActions: EditAction[] = validated.data.actions.map(a => {
      const rawAction = a as Record<string, unknown>;
      return {
        type: a.type,
        start: typeof rawAction.start === "number" ? Math.max(0, rawAction.start) : undefined,
        end: typeof rawAction.end === "number" ? Math.min(duration, rawAction.end) : undefined,
        duration: typeof rawAction.duration === "number" ? rawAction.duration : undefined,
        stockQuery: typeof rawAction.stockQuery === "string" ? rawAction.stockQuery : undefined,
        transcriptContext: typeof rawAction.transcriptContext === "string" ? rawAction.transcriptContext : undefined,
        reason: typeof rawAction.reason === "string" ? rawAction.reason : undefined,
        priority: typeof rawAction.priority === "string" ? (rawAction.priority as "low" | "medium" | "high") : undefined,
        qualityScore: typeof rawAction.qualityScore === "number" ? rawAction.qualityScore : 50,
      } as EditAction;
    });

    ensureKeepCoverage(reviewedActions, duration);

    return {
      actions: reviewedActions,
      qualityMetrics: validated.data.qualityMetrics || { pacing: "moderate", brollRelevance: "medium", narrativeFlow: "medium", overallScore: 60 },
      recommendations: validated.data.recommendations,
      warnings: validated.data.warnings,
    };
  } catch (error) {
    aiLogger.error("Pass 4 error:", error);
    return getDefaultReviewedPlan(preliminaryActions, qualityMap, duration);
  }
}

function ensureKeepCoverage(actions: EditAction[], duration: number): void {
  const keepActions = actions.filter(a => a.type === "keep" && a.start !== undefined && a.end !== undefined);
  const totalKeepDuration = keepActions.reduce((sum, a) => sum + ((a.end || 0) - (a.start || 0)), 0);
  const keepPercentage = (totalKeepDuration / duration) * 100;

  if (keepPercentage < 40 || keepActions.length === 0) {
    aiLogger.warn(`Keep actions only cover ${safeFixed(keepPercentage)}% - adding full video keep`);
    const nonKeepActions = actions.filter(a => a.type !== "keep");
    actions.length = 0;
    actions.push(...nonKeepActions);
    actions.push({
      type: "keep",
      start: 0,
      end: duration,
      reason: "Default keep - entire video (safety fallback)",
      priority: "medium",
      qualityScore: 60,
    });
  }
}

const CorrectionPassSchema = z.object({
  actions: z.array(z.any()),
  justification: z.string(),
  fixedIssues: z.array(z.array(z.string()).or(z.string())), // Flexible to handle varied AI outputs
});

/**
 * PASS 5: CORRECTION PASS (Autonomous Self-Correction)
 * Specifically targets issues identified by the Arbitrator during post-render review.
 */
export async function executePass5CorrectionPass(
  analysis: VideoAnalysis,
  transcript: TranscriptSegment[],
  previousPlan: EditPlan,
  arbitrationJustification: string,
  flaggedActions: EditAction[],
  learningContext?: string
): Promise<EditPlan> {
  const apiKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Gemini API key not configured for Correction Pass");

  const gemini = getGeminiClient();
  const model = AI_CONFIG.models.editPlanning;

  const flaggedInfo = flaggedActions.map(a =>
    `- ${a.type} at ${a.start}s: ${a.reason || 'Needs replacement'}`
  ).join('\n');

  const prompt = `You are an AI Video Editor in "Self-Correction" mode. 
A previous edit plan was rendered, but a post-render review identified quality issues.

### TARGET ISSUES TO FIX:
${arbitrationJustification}

### FLAGGED ACTIONS:
${flaggedInfo}

### LEARNED PREFERENCES FROM PAST EDITS:
${learningContext || "No specific patterns discovered yet."}

### ORIGINAL PLAN:
${JSON.stringify(previousPlan.actions.slice(0, 50))}... (showing first 50 actions)

### TASK:
1. Review the flagged actions and the arbitrator's justification.
2. Generate a NEW set of actions that fixes these specific issues.
3. If a B-roll was "distracting", replace it with a better query or remove it.
4. If a "cut" was missed, add it.
5. Maintain the overall narrative flow.

Return ONLY a JSON object with:
{
  "actions": [...],
  "justification": "Why this new plan is better",
  "fixedIssues": ["List of issues from the target list that are now resolved"]
}`;

  try {
    const response = await withRetry(async () => {
      const result = await gemini.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { responseMimeType: "application/json" }
      });
      return result.text;
    }, "Pass 5 Correction", AI_RETRY_OPTIONS, "gemini");

    const parsed = safeJsonParse(response || "{}");
    const validated = CorrectionPassSchema.parse(parsed);

    aiLogger.info(`[CorrectionPass] Successfully resolved issues identified by Arbitrator`);

    return {
      ...previousPlan,
      actions: validated.actions,
      editingStrategy: {
        ...previousPlan.editingStrategy,
        approach: `Refined: ${validated.justification}`
      }
    };
  } catch (err) {
    aiLogger.error("Pass 5 Correction failed, falling back to original plan with arbitration hints:", err);
    // Fallback: return previous plan but with the flagged actions removed/modified as best as possible
    return {
      ...previousPlan,
      actions: previousPlan.actions.map((a: EditAction) => {
        const isFlagged = flaggedActions.some(f => f.start === a.start && f.type === a.type);
        if (isFlagged && a.type === 'insert_stock') {
          return { ...a, type: 'keep' as any }; // Safe fallback: don't show the bad B-roll
        }
        return a;
      })
    };
  }
}

function getDefaultReviewedPlan(
  preliminaryActions: EditAction[],
  qualityMap: QualityMap,
  duration: number
): ReviewedEditPlan {
  const scoredActions = preliminaryActions.map(a => ({
    ...a,
    qualityScore: a.type === "keep" ? 70 : a.type === "insert_stock" ? 60 : 50,
  }));

  ensureKeepCoverage(scoredActions, duration);

  return {
    actions: scoredActions,
    qualityMetrics: { pacing: "moderate", brollRelevance: "medium", narrativeFlow: "medium", overallScore: qualityMap.overallEngagement },
    recommendations: [],
    warnings: [],
  };
}
