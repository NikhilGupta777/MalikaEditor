import { z } from "zod";
import { withRetry, AI_RETRY_OPTIONS } from "../../utils/retry";
import { createLogger } from "../../utils/logger";
import { getGeminiClient } from "./clients";
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
import type {
  VideoAnalysis,
  TranscriptSegment,
  SemanticAnalysis,
  EditAction,
} from "@shared/schema";

const aiLogger = createLogger("ai-service");

// Alias for backward compatibility
const normalizeQualityLevel = normalizeVisualImportance;
const normalizePacing = normalizeMetricPacing;
const normalizeActionType = normalizeEditActionType;

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
  const duration = analysis.duration;
  const transcriptText = transcript.slice(0, 30).map(t => 
    `[${t.start.toFixed(1)}s]: ${t.text}`
  ).join("\n");

  const prompt = `You are an expert video structure analyst. Analyze this video to identify its structural components.

VIDEO ANALYSIS:
- Duration: ${duration.toFixed(1)} seconds
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
  "outroSection": {"start": number, "end": ${duration.toFixed(1)}} | null,
  "sectionMarkers": [
    {"timestamp": number, "type": "intro_end|section_change|climax|outro_start|transition", "description": "string"}
  ],
  "narrativeArc": "linear|problem_solution|story|tutorial|listicle|conversational"
}`;

  try {
    const response = await withRetry(
      () => getGeminiClient().models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      }),
      "pass1StructureAnalysis",
      AI_RETRY_OPTIONS
    );

    const text = response.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) {
      aiLogger.warn("Pass 1: Failed to parse structure analysis, using defaults");
      return getDefaultStructuredPlan(duration, analysis, semanticAnalysis);
    }

    const parsed = JSON.parse(jsonMatch[0]);
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
    ...(analysis.keyMoments || []).map(k => `[${k.timestamp.toFixed(1)}s] ${k.type}: ${k.description} (${k.importance})`),
    ...(semanticAnalysis.keyMoments || []).map(k => `[${k.timestamp.toFixed(1)}s] ${k.description} (${k.importance})`),
  ].slice(0, 15).join("\n");

  const scenesSummary = (analysis.scenes || []).slice(0, 10).map(s => 
    `[${s.start.toFixed(1)}s-${s.end.toFixed(1)}s] ${s.sceneType} - ${s.emotionalTone}, visual importance: ${s.visualImportance}`
  ).join("\n");

  const emotionFlowSummary = (analysis.emotionFlow || []).slice(0, 10).map(e =>
    `[${e.timestamp.toFixed(1)}s] ${e.emotion} (intensity: ${e.intensity})`
  ).join("\n");

  const prompt = `You are an expert video quality analyst. Score each segment of this video for engagement potential.

VIDEO INFO:
- Duration: ${duration.toFixed(1)} seconds
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
${fillerSegments.slice(0, 10).map(f => `[${f.start.toFixed(1)}s] "${f.word}"`).join(", ")}

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
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      }),
      "pass2QualityAssessment",
      AI_RETRY_OPTIONS
    );

    const text = response.text || "";
    // Robust JSON extraction for potential malformed AI responses
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    
    if (jsonStart === -1 || jsonEnd === -1) {
      aiLogger.warn("Pass 2: No JSON block found in response, using defaults");
      return getDefaultQualityMap(duration, semanticAnalysis);
    }

    const jsonText = text.slice(jsonStart, jsonEnd + 1)
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, "") // Remove control characters
      .replace(/\\n/g, " ") // Normalize newlines inside strings
      .trim();
    
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      aiLogger.error("Pass 2: JSON.parse failed on cleaned text:", e);
      // Fallback: try to clean up trailing commas which is a common AI error
      try {
        const cleanedJson = jsonText.replace(/,\s*([\]}])/g, '$1');
        parsed = JSON.parse(cleanedJson);
      } catch (innerE) {
        aiLogger.error("Pass 2: JSON.parse failed even after cleanup, using defaults");
        return getDefaultQualityMap(duration, semanticAnalysis);
      }
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
    .map(s => `[${s.start.toFixed(1)}s-${s.end.toFixed(1)}s] ${s.visualDescription || s.sceneType}`);

  const brollWindowsSummary = semanticAnalysis.brollWindows.slice(0, 12).map(b =>
    `[${b.start.toFixed(1)}s-${b.end.toFixed(1)}s] Context: "${b.context}" - Query: "${b.suggestedQuery}" (${b.priority})`
  ).join("\n");

  const lowValueSummary = qualityMap.lowValueSegments.map(s =>
    `[${s.start.toFixed(1)}s-${s.end.toFixed(1)}s] ${s.reason}`
  ).join("\n");

  const transcriptContext = transcript.slice(0, 25).map(t =>
    `[${t.start.toFixed(1)}s-${t.end.toFixed(1)}s]: ${t.text}`
  ).join("\n");

  const prompt = `You are an expert B-roll optimization specialist. Create an intelligent B-roll placement plan.

VIDEO CONTEXT:
- Duration: ${duration.toFixed(1)} seconds
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
${fillerSegments.slice(0, 15).map(f => `[${f.start.toFixed(1)}s-${f.end.toFixed(1)}s] "${f.word}"`).join("\n")}

TRANSCRIPT CONTEXT:
${transcriptContext}

B-ROLL OPTIMIZATION RULES:
1. NEVER place B-roll during "high" visual importance segments
2. Use ULTRA-SPECIFIC queries based on exact transcript context
3. Match genre/tone: ${genre} content should get ${tone} imagery
4. DISTRIBUTE EVENLY across the entire video - no clustering
5. Minimum 3-5 second spacing between B-roll clips
6. Each B-roll should be 3-5 seconds duration
7. Target ${Math.min(12, Math.max(4, Math.ceil(duration / 8)))} B-roll placements

Respond in JSON format only (no markdown):
{
  "brollPlacements": [
    {"start": number, "duration": number (3-5 seconds), "query": "ULTRA-SPECIFIC search query", "transcriptContext": "what speaker is saying", "priority": "high|medium|low", "reason": "why B-roll here"}
  ],
  "fillerActions": [{"start": number, "end": number, "word": "the filler word", "action": "cut|overlay"}],
  "cutActions": [{"start": number, "end": number, "reason": "why to cut this segment"}]
}`;

  try {
    const response = await withRetry(
      () => getGeminiClient().models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      }),
      "pass3BrollOptimization",
      AI_RETRY_OPTIONS
    );

    const text = response.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) {
      aiLogger.warn("Pass 3: Failed to parse B-roll optimization, using defaults");
      return getDefaultBrollPlan(duration, semanticAnalysis, fillerSegments);
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const normalized = normalizeBrollPlanResponse(parsed);
    const validated = OptimizedBrollPlanSchema.safeParse(normalized);
    if (!validated.success) {
      aiLogger.warn("Pass 3: Schema validation failed, using defaults:", validated.error.issues);
      return getDefaultBrollPlan(duration, semanticAnalysis, fillerSegments);
    }
    
    const brollPlacements = validateBrollSpacing(
      validated.data.brollPlacements.map((b) => ({
        start: Math.max(0, b.start),
        duration: Math.min(6, Math.max(2, b.duration)),
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
  let lastEnd = -5;

  for (const placement of sorted) {
    if (placement.start >= lastEnd + 3 && placement.start < duration - 1) {
      validated.push({ ...placement, priority: placement.priority as "high" | "medium" | "low" });
      lastEnd = placement.start + placement.duration;
    } else {
      aiLogger.debug(`Pass 3: Skipping overlapping B-roll at ${placement.start}s`);
    }
  }

  return validated;
}

function getDefaultBrollPlan(
  duration: number,
  semanticAnalysis: SemanticAnalysis,
  fillerSegments: { start: number; end: number; word: string }[]
): OptimizedBrollPlan {
  const brollPlacements = semanticAnalysis.brollWindows
    .filter(b => b.start !== undefined && b.suggestedQuery)
    .slice(0, 8)
    .map(b => ({
      start: b.start,
      duration: Math.min(5, b.end - b.start),
      query: b.suggestedQuery,
      transcriptContext: b.context,
      priority: (b.priority || "medium") as "low" | "medium" | "high",
      reason: b.reason,
    }));

  const fillerActions = fillerSegments
    .filter(f => (f.end - f.start) < 1)
    .slice(0, 10)
    .map(f => ({ start: f.start, end: f.end, word: f.word, action: "cut" as const }));

  return { brollPlacements, fillerActions, cutActions: [] };
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
    if (a.type === "insert_stock") return `[${a.start?.toFixed(1)}s] insert_stock: "${a.stockQuery}" (${a.duration}s)`;
    if (a.type === "cut") return `[${a.start?.toFixed(1)}s-${a.end?.toFixed(1)}s] cut: ${a.reason}`;
    if (a.type === "keep") return `[${a.start?.toFixed(1)}s-${a.end?.toFixed(1)}s] keep: ${a.reason}`;
    return `[${a.start?.toFixed(1)}s] ${a.type}`;
  }).join("\n");

  const reviewPrompt = `You are a senior video editor performing quality review. Review this edit plan for consistency and quality.

USER'S EDITING INSTRUCTIONS: "${prompt}"

VIDEO INFO:
- Duration: ${duration.toFixed(1)} seconds
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
1. NO OVERLAPPING EDITS
2. PROPER B-ROLL SPACING - minimum 3 seconds between B-roll clips
3. NARRATIVE FLOW - edits should preserve story arc
4. PACING - matches content type (${genre})
5. B-ROLL RELEVANCE - queries match transcript context

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
        model: "gemini-2.5-flash",
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
    aiLogger.warn(`Keep actions only cover ${keepPercentage.toFixed(1)}% - adding full video keep`);
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
