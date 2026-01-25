/**
 * AI Response Normalization Utilities
 * 
 * AI models often return variations of expected values:
 * - Different capitalization ("High" vs "high")
 * - Synonyms ("quick" vs "fast")
 * - Extra text ("Dynamic (for engagement)" vs "dynamic")
 * - Creative variations ("must-keep" vs "must_keep")
 * 
 * These functions normalize AI responses to valid enum values,
 * preventing validation failures and crashes.
 */

// Helper to extract first word and normalize
function extractFirstWord(value: string): string {
  return value.toLowerCase().trim().split(/[\s(,\-_]/)[0];
}

// ============================================================================
// PRIORITY / IMPORTANCE / LEVEL NORMALIZATION
// ============================================================================

const VALID_PRIORITIES = ["low", "medium", "high"] as const;
export type Priority = typeof VALID_PRIORITIES[number];

export function normalizePriority(value: string): Priority {
  const normalized = extractFirstWord(value);
  
  if (VALID_PRIORITIES.includes(normalized as any)) {
    return normalized as Priority;
  }
  
  const map: Record<string, Priority> = {
    "critical": "high",
    "important": "high",
    "essential": "high",
    "must": "high",
    "required": "high",
    "normal": "medium",
    "moderate": "medium",
    "average": "medium",
    "standard": "medium",
    "optional": "low",
    "minor": "low",
    "minimal": "low",
    "nice": "low", // nice-to-have
  };
  
  return map[normalized] || "medium";
}

// ============================================================================
// VALUE LEVEL NORMALIZATION (must_keep, high, medium, low, cut_candidate)
// ============================================================================

const VALID_VALUE_LEVELS = ["must_keep", "high", "medium", "low", "cut_candidate"] as const;
export type ValueLevel = typeof VALID_VALUE_LEVELS[number];

export function normalizeValueLevel(value: string): ValueLevel {
  const normalized = value.toLowerCase().trim().replace(/[\s\-]/g, "_");
  
  if (VALID_VALUE_LEVELS.includes(normalized as any)) {
    return normalized as ValueLevel;
  }
  
  // Handle variations
  const map: Record<string, ValueLevel> = {
    "must": "must_keep",
    "mustkeep": "must_keep",
    "keep": "must_keep",
    "essential": "must_keep",
    "critical": "must_keep",
    "important": "high",
    "valuable": "high",
    "good": "high",
    "average": "medium",
    "okay": "medium",
    "ok": "medium",
    "normal": "medium",
    "skip": "low",
    "boring": "low",
    "filler": "low",
    "cut": "cut_candidate",
    "remove": "cut_candidate",
    "delete": "cut_candidate",
    "unnecessary": "cut_candidate",
  };
  
  const firstWord = extractFirstWord(value);
  return map[firstWord] || map[normalized] || "medium";
}

// ============================================================================
// NARRATIVE ARC NORMALIZATION
// ============================================================================

const VALID_NARRATIVE_ARCS = ["linear", "problem_solution", "story", "tutorial", "listicle", "conversational"] as const;
export type NarrativeArc = typeof VALID_NARRATIVE_ARCS[number];

export function normalizeNarrativeArc(value: string): NarrativeArc {
  const normalized = value.toLowerCase().trim().replace(/[\s\-]/g, "_");
  
  if (VALID_NARRATIVE_ARCS.includes(normalized as any)) {
    return normalized as NarrativeArc;
  }
  
  const map: Record<string, NarrativeArc> = {
    "straightforward": "linear",
    "chronological": "linear",
    "sequential": "linear",
    "simple": "linear",
    "problem": "problem_solution",
    "solution": "problem_solution",
    "howto": "tutorial",
    "how_to": "tutorial",
    "educational": "tutorial",
    "guide": "tutorial",
    "list": "listicle",
    "numbered": "listicle",
    "tips": "listicle",
    "talk": "conversational",
    "chat": "conversational",
    "discussion": "conversational",
    "interview": "conversational",
    "narrative": "story",
    "journey": "story",
    "arc": "story",
  };
  
  const firstWord = extractFirstWord(value);
  return map[firstWord] || map[normalized] || "linear";
}

// ============================================================================
// SECTION MARKER TYPE NORMALIZATION
// ============================================================================

const VALID_SECTION_TYPES = ["intro_end", "section_change", "climax", "outro_start", "transition"] as const;
export type SectionType = typeof VALID_SECTION_TYPES[number];

export function normalizeSectionType(value: string): SectionType {
  const normalized = value.toLowerCase().trim().replace(/[\s\-]/g, "_");
  
  if (VALID_SECTION_TYPES.includes(normalized as any)) {
    return normalized as SectionType;
  }
  
  const map: Record<string, SectionType> = {
    "intro": "intro_end",
    "introduction": "intro_end",
    "opening": "intro_end",
    "section": "section_change",
    "change": "section_change",
    "topic": "section_change",
    "new": "section_change",
    "peak": "climax",
    "highlight": "climax",
    "key": "climax",
    "important": "climax",
    "outro": "outro_start",
    "ending": "outro_start",
    "conclusion": "outro_start",
    "close": "outro_start",
    "bridge": "transition",
    "segue": "transition",
    "shift": "transition",
  };
  
  const firstWord = extractFirstWord(value);
  return map[firstWord] || map[normalized] || "section_change";
}

// ============================================================================
// FILLER ACTION NORMALIZATION
// ============================================================================

const VALID_FILLER_ACTIONS = ["cut", "overlay"] as const;
export type FillerAction = typeof VALID_FILLER_ACTIONS[number];

export function normalizeFillerAction(value: string): FillerAction {
  const normalized = extractFirstWord(value);
  
  if (VALID_FILLER_ACTIONS.includes(normalized as any)) {
    return normalized as FillerAction;
  }
  
  const map: Record<string, FillerAction> = {
    "remove": "cut",
    "delete": "cut",
    "trim": "cut",
    "cover": "overlay",
    "broll": "overlay",
    "b_roll": "overlay",
    "hide": "overlay",
  };
  
  return map[normalized] || "cut";
}

// ============================================================================
// PACING NORMALIZATION (for quality metrics)
// ============================================================================

const VALID_METRIC_PACING = ["slow", "moderate", "fast"] as const;
export type MetricPacing = typeof VALID_METRIC_PACING[number];

export function normalizeMetricPacing(value: string): MetricPacing {
  const normalized = extractFirstWord(value);
  
  if (VALID_METRIC_PACING.includes(normalized as any)) {
    return normalized as MetricPacing;
  }
  
  const map: Record<string, MetricPacing> = {
    "quick": "fast",
    "rapid": "fast",
    "energetic": "fast",
    "dynamic": "fast",
    "medium": "moderate",
    "normal": "moderate",
    "balanced": "moderate",
    "average": "moderate",
    "relaxed": "slow",
    "calm": "slow",
    "leisurely": "slow",
  };
  
  return map[normalized] || "moderate";
}

// ============================================================================
// KEY MOMENT TYPE NORMALIZATION
// ============================================================================

const VALID_KEY_MOMENT_TYPES = ["hook", "climax", "callToAction", "keyPoint", "transition"] as const;
export type KeyMomentType = typeof VALID_KEY_MOMENT_TYPES[number];

export function normalizeKeyMomentType(value: string): KeyMomentType {
  const normalized = value.toLowerCase().trim().replace(/[\s\-_]/g, "");
  
  // Direct match
  const directMap: Record<string, KeyMomentType> = {
    "hook": "hook",
    "climax": "climax",
    "calltoaction": "callToAction",
    "cta": "callToAction",
    "keypoint": "keyPoint",
    "transition": "transition",
  };
  
  if (directMap[normalized]) {
    return directMap[normalized];
  }
  
  const map: Record<string, KeyMomentType> = {
    "intro": "hook",
    "opening": "hook",
    "attention": "hook",
    "grabber": "hook",
    "peak": "climax",
    "highlight": "climax",
    "important": "climax",
    "call": "callToAction",
    "action": "callToAction",
    "subscribe": "callToAction",
    "point": "keyPoint",
    "key": "keyPoint",
    "main": "keyPoint",
    "insight": "keyPoint",
    "bridge": "transition",
    "shift": "transition",
    "segue": "transition",
  };
  
  const firstWord = extractFirstWord(value);
  return map[firstWord] || "keyPoint";
}

// ============================================================================
// ENERGY LEVEL NORMALIZATION
// ============================================================================

const VALID_ENERGY_LEVELS = ["low", "medium", "high"] as const;
export type EnergyLevel = typeof VALID_ENERGY_LEVELS[number];

export function normalizeEnergyLevel(value: string): EnergyLevel {
  const normalized = extractFirstWord(value);
  
  if (VALID_ENERGY_LEVELS.includes(normalized as any)) {
    return normalized as EnergyLevel;
  }
  
  const map: Record<string, EnergyLevel> = {
    "calm": "low",
    "relaxed": "low",
    "quiet": "low",
    "subdued": "low",
    "moderate": "medium",
    "normal": "medium",
    "average": "medium",
    "balanced": "medium",
    "energetic": "high",
    "excited": "high",
    "dynamic": "high",
    "intense": "high",
    "loud": "high",
  };
  
  return map[normalized] || "medium";
}

// ============================================================================
// SPEAKING PACE NORMALIZATION
// ============================================================================

const VALID_SPEAKING_PACES = ["slow", "normal", "fast"] as const;
export type SpeakingPace = typeof VALID_SPEAKING_PACES[number];

export function normalizeSpeakingPace(value: string): SpeakingPace {
  const normalized = extractFirstWord(value);
  
  if (VALID_SPEAKING_PACES.includes(normalized as any)) {
    return normalized as SpeakingPace;
  }
  
  const map: Record<string, SpeakingPace> = {
    "moderate": "normal",
    "medium": "normal",
    "average": "normal",
    "quick": "fast",
    "rapid": "fast",
    "energetic": "fast",
    "relaxed": "slow",
    "calm": "slow",
    "deliberate": "slow",
  };
  
  return map[normalized] || "normal";
}

// ============================================================================
// VISUAL IMPORTANCE NORMALIZATION
// ============================================================================

const VALID_VISUAL_IMPORTANCE = ["high", "medium", "low"] as const;
export type VisualImportance = typeof VALID_VISUAL_IMPORTANCE[number];

export function normalizeVisualImportance(value: string): VisualImportance {
  const normalized = extractFirstWord(value);
  
  if (VALID_VISUAL_IMPORTANCE.includes(normalized as any)) {
    return normalized as VisualImportance;
  }
  
  const map: Record<string, VisualImportance> = {
    "critical": "high",
    "important": "high",
    "essential": "high",
    "must": "high",
    "moderate": "medium",
    "average": "medium",
    "normal": "medium",
    "optional": "low",
    "minor": "low",
    "background": "low",
  };
  
  return map[normalized] || "medium";
}

// ============================================================================
// EMOTION NORMALIZATION
// ============================================================================

const VALID_EMOTIONS = ["neutral", "excited", "serious", "calm", "urgent", "inspirational"] as const;
export type Emotion = typeof VALID_EMOTIONS[number];

export function normalizeEmotion(value: string): Emotion {
  const normalized = extractFirstWord(value);
  
  if (VALID_EMOTIONS.includes(normalized as any)) {
    return normalized as Emotion;
  }
  
  const map: Record<string, Emotion> = {
    "happy": "excited",
    "energetic": "excited",
    "enthusiastic": "excited",
    "professional": "serious",
    "formal": "serious",
    "thoughtful": "serious",
    "relaxed": "calm",
    "peaceful": "calm",
    "soothing": "calm",
    "important": "urgent",
    "critical": "urgent",
    "immediate": "urgent",
    "motivational": "inspirational",
    "uplifting": "inspirational",
    "encouraging": "inspirational",
    "normal": "neutral",
    "standard": "neutral",
    "balanced": "neutral",
  };
  
  return map[normalized] || "neutral";
}

// ============================================================================
// OVERALL TONE NORMALIZATION
// ============================================================================

const VALID_OVERALL_TONES = ["educational", "entertaining", "inspirational", "professional", "casual", "serious"] as const;
export type OverallTone = typeof VALID_OVERALL_TONES[number];

export function normalizeOverallTone(value: string): OverallTone {
  const normalized = extractFirstWord(value);
  
  if (VALID_OVERALL_TONES.includes(normalized as any)) {
    return normalized as OverallTone;
  }
  
  const map: Record<string, OverallTone> = {
    "informative": "educational",
    "teaching": "educational",
    "tutorial": "educational",
    "fun": "entertaining",
    "funny": "entertaining",
    "humorous": "entertaining",
    "motivational": "inspirational",
    "uplifting": "inspirational",
    "encouraging": "inspirational",
    "formal": "professional",
    "business": "professional",
    "corporate": "professional",
    "relaxed": "casual",
    "friendly": "casual",
    "conversational": "casual",
    "thoughtful": "serious",
    "dramatic": "serious",
    "intense": "serious",
  };
  
  return map[normalized] || "casual";
}

// ============================================================================
// EDIT ACTION TYPE NORMALIZATION
// ============================================================================

const VALID_EDIT_ACTION_TYPES = [
  "cut", "keep", "insert_stock", "insert_ai_image", 
  "add_caption", "add_text_overlay", "transition", "speed_change"
] as const;
export type EditActionType = typeof VALID_EDIT_ACTION_TYPES[number];

export function normalizeEditActionType(value: string): EditActionType {
  const normalized = value.toLowerCase().trim().replace(/[\s\-]/g, "_");
  
  if (VALID_EDIT_ACTION_TYPES.includes(normalized as any)) {
    return normalized as EditActionType;
  }
  
  const map: Record<string, EditActionType> = {
    "remove": "cut",
    "delete": "cut",
    "trim": "cut",
    "maintain": "keep",
    "preserve": "keep",
    "retain": "keep",
    "stock": "insert_stock",
    "broll": "insert_stock",
    "b_roll": "insert_stock",
    "overlay": "insert_stock",
    "ai_image": "insert_ai_image",
    "aiimage": "insert_ai_image",
    "generated": "insert_ai_image",
    "caption": "add_caption",
    "subtitle": "add_caption",
    "text": "add_text_overlay",
    "title": "add_text_overlay",
    "fade": "transition",
    "crossfade": "transition",
    "wipe": "transition",
    "speed": "speed_change",
    "slowmo": "speed_change",
    "timelapse": "speed_change",
    "remove_silent_parts": "cut",
  };
  
  const firstWord = extractFirstWord(value);
  return map[firstWord] || map[normalized] || "keep";
}

// ============================================================================
// STOCK MEDIA TYPE NORMALIZATION
// ============================================================================

const VALID_STOCK_MEDIA_TYPES = ["image", "video", "ai_generated"] as const;
export type StockMediaType = typeof VALID_STOCK_MEDIA_TYPES[number];

export function normalizeStockMediaType(value: string): StockMediaType {
  const normalized = value.toLowerCase().trim().replace(/[\s\-]/g, "_");
  
  if (VALID_STOCK_MEDIA_TYPES.includes(normalized as any)) {
    return normalized as StockMediaType;
  }
  
  const map: Record<string, StockMediaType> = {
    "photo": "image",
    "picture": "image",
    "img": "image",
    "clip": "video",
    "footage": "video",
    "movie": "video",
    "ai": "ai_generated",
    "generated": "ai_generated",
    "artificial": "ai_generated",
  };
  
  const firstWord = extractFirstWord(value);
  return map[firstWord] || map[normalized] || "video";
}

// ============================================================================
// SAFE JSON PARSING UTILITIES
// Handle malformed AI responses gracefully without crashing
// ============================================================================

/**
 * Safely parse JSON from AI response text
 * Returns parsed object or null on failure
 */
export function safeJsonParse<T>(jsonString: string): T | null {
  try {
    return JSON.parse(jsonString) as T;
  } catch (error) {
    return null;
  }
}

/**
 * Extract JSON from AI response text (handles markdown code blocks)
 * Returns the extracted JSON string or null
 */
export function extractJsonFromResponse(text: string): string | null {
  // Try to find JSON in markdown code blocks first
  const jsonBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonBlockMatch) {
    return jsonBlockMatch[1].trim();
  }
  
  // Try to find raw JSON object or array
  const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) {
    return jsonMatch[0];
  }
  
  return null;
}

/**
 * Safely parse JSON from AI response with fallback
 * Combines extraction and parsing in one utility
 */
export function safeParseAiResponse<T>(responseText: string, fallback: T): T {
  const jsonString = extractJsonFromResponse(responseText);
  if (!jsonString) {
    return fallback;
  }
  
  const parsed = safeJsonParse<T>(jsonString);
  return parsed ?? fallback;
}

/**
 * Filter null/undefined values from arrays (AI sometimes returns sparse arrays)
 */
export function filterNullish<T>(arr: (T | null | undefined)[]): T[] {
  return arr.filter((item): item is T => item != null);
}

/**
 * Ensure value is an array (AI sometimes returns single item instead of array)
 */
export function ensureArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? filterNullish(value) : [value];
}

/**
 * Safe number coercion (AI sometimes returns "12.5" instead of 12.5)
 */
export function safeNumber(value: unknown, fallback: number = 0): number {
  if (typeof value === 'number' && !isNaN(value)) return value;
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    if (!isNaN(parsed)) return parsed;
  }
  return fallback;
}

/**
 * Safe boolean coercion (AI sometimes returns "true" instead of true)
 */
export function safeBoolean(value: unknown, fallback: boolean = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.toLowerCase().trim();
    if (lower === 'true' || lower === 'yes' || lower === '1') return true;
    if (lower === 'false' || lower === 'no' || lower === '0') return false;
  }
  if (typeof value === 'number') return value !== 0;
  return fallback;
}
