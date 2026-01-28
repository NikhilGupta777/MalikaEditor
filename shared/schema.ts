import { sql } from "drizzle-orm";
import { pgTable, text, varchar, serial, integer, timestamp, jsonb, pgEnum, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ============================================================================
// AI RESPONSE NORMALIZATION HELPERS
// These handle variations in AI responses to prevent validation failures
// ============================================================================

// Extract first word from values like "Dynamic (to maintain engagement)"
const extractFirstWord = (val: string): string => val.split(/[\s(]/)[0].toLowerCase();

// Generic normalizer factory for enum values
const createNormalizer = <T extends string>(
  synonymMap: Record<string, T>,
  defaultValue: T
) => (val: string): T => {
  const normalized = extractFirstWord(val);
  return synonymMap[normalized] ?? synonymMap[val.toLowerCase()] ?? defaultValue;
};

// Emotion synonyms for transcript segments
const emotionMap: Record<string, "neutral" | "excited" | "serious" | "calm" | "urgent" | "inspirational"> = {
  "neutral": "neutral", "normal": "neutral", "standard": "neutral",
  "excited": "excited", "happy": "excited", "energetic": "excited", "enthusiastic": "excited",
  "serious": "serious", "thoughtful": "serious", "focused": "serious",
  "calm": "calm", "relaxed": "calm", "peaceful": "calm",
  "urgent": "urgent", "intense": "urgent", "pressing": "urgent",
  "inspirational": "inspirational", "inspiring": "inspirational", "motivational": "inspirational",
};
const normalizeEmotion = createNormalizer(emotionMap, "neutral");

// Visual importance / priority level synonyms
const importanceMap: Record<string, "high" | "medium" | "low"> = {
  "high": "high", "critical": "high", "important": "high", "must-keep": "high", "essential": "high",
  "medium": "medium", "moderate": "medium", "normal": "medium", "average": "medium",
  "low": "low", "minor": "low", "optional": "low", "background": "low", "filler": "low",
};
const normalizeImportance = createNormalizer(importanceMap, "medium");

// Key moment type synonyms
const keyMomentTypeMap: Record<string, "hook" | "climax" | "callToAction" | "keyPoint" | "transition"> = {
  "hook": "hook", "opening": "hook", "intro": "hook", "attention": "hook",
  "climax": "climax", "peak": "climax", "highlight": "climax", "best": "climax",
  "calltoaction": "callToAction", "cta": "callToAction", "call": "callToAction",
  "keypoint": "keyPoint", "key": "keyPoint", "important": "keyPoint", "main": "keyPoint",
  "transition": "transition", "bridge": "transition", "segue": "transition",
};
const normalizeKeyMomentType = createNormalizer(keyMomentTypeMap, "keyPoint");

// Overall tone synonyms
const overallToneMap: Record<string, "educational" | "entertaining" | "inspirational" | "professional" | "casual" | "serious"> = {
  "educational": "educational", "informative": "educational", "teaching": "educational", "instructional": "educational",
  "entertaining": "entertaining", "fun": "entertaining", "engaging": "entertaining", "enjoyable": "entertaining",
  "inspirational": "inspirational", "inspiring": "inspirational", "motivational": "inspirational", "uplifting": "inspirational",
  "professional": "professional", "formal": "professional", "business": "professional", "corporate": "professional",
  "casual": "casual", "relaxed": "casual", "informal": "casual", "conversational": "casual",
  "serious": "serious", "thoughtful": "serious", "somber": "serious", "grave": "serious",
};
const normalizeOverallTone = createNormalizer(overallToneMap, "casual");

// Energy level synonyms
const energyLevelMap: Record<string, "low" | "medium" | "high"> = {
  "low": "low", "calm": "low", "relaxed": "low", "quiet": "low",
  "medium": "medium", "moderate": "medium", "normal": "medium", "average": "medium",
  "high": "high", "energetic": "high", "excited": "high", "intense": "high",
};
const normalizeEnergyLevel = createNormalizer(energyLevelMap, "medium");

// Speaking pace synonyms
const speakingPaceMap: Record<string, "slow" | "normal" | "fast"> = {
  "slow": "slow", "relaxed": "slow", "deliberate": "slow",
  "normal": "normal", "moderate": "normal", "average": "normal", "medium": "normal",
  "fast": "fast", "quick": "fast", "rapid": "fast", "energetic": "fast",
};
const normalizeSpeakingPace = createNormalizer(speakingPaceMap, "normal");

// Video context tone synonyms
const toneMap: Record<string, "serious" | "casual" | "professional" | "humorous" | "inspirational" | "dramatic" | "calm"> = {
  "serious": "serious", "thoughtful": "serious", "somber": "serious",
  "casual": "casual", "relaxed": "casual", "informal": "casual", "conversational": "casual",
  "professional": "professional", "formal": "professional", "business": "professional",
  "humorous": "humorous", "funny": "humorous", "comedic": "humorous", "witty": "humorous",
  "inspirational": "inspirational", "inspiring": "inspirational", "motivational": "inspirational",
  "dramatic": "dramatic", "intense": "dramatic", "emotional": "dramatic",
  "calm": "calm", "peaceful": "calm", "soothing": "calm",
};
const normalizeTone = createNormalizer(toneMap, "casual");

// Pacing synonyms
const pacingMap: Record<string, "slow" | "moderate" | "fast" | "dynamic"> = {
  "slow": "slow", "relaxed": "slow", "deliberate": "slow", "measured": "slow",
  "moderate": "moderate", "medium": "moderate", "normal": "moderate", "average": "moderate", "balanced": "moderate",
  "fast": "fast", "quick": "fast", "rapid": "fast", "energetic": "fast",
  "dynamic": "dynamic", "varied": "dynamic", "mixed": "dynamic", "changing": "dynamic",
};
const normalizePacing = createNormalizer(pacingMap, "moderate");

// Edit style synonyms
const editStyleMap: Record<string, "minimal" | "moderate" | "dynamic" | "cinematic" | "fast-paced"> = {
  "minimal": "minimal", "simple": "minimal", "clean": "minimal", "basic": "minimal",
  "moderate": "moderate", "balanced": "moderate", "standard": "moderate", "normal": "moderate",
  "dynamic": "dynamic", "energetic": "dynamic", "active": "dynamic", "engaging": "dynamic",
  "cinematic": "cinematic", "filmic": "cinematic", "movie": "cinematic", "professional": "cinematic",
  "fast-paced": "fast-paced", "fast": "fast-paced", "quick": "fast-paced", "rapid": "fast-paced",
};
const normalizeEditStyle = createNormalizer(editStyleMap, "moderate");

// Genre synonyms - comprehensive list
const genreMap: Record<string, string> = {
  "tutorial": "tutorial", "how-to": "tutorial", "howto": "tutorial", "guide": "tutorial", "lesson": "tutorial",
  "vlog": "vlog", "blog": "vlog", "personal": "vlog", "diary": "vlog",
  "interview": "interview", "conversation": "interview", "talk": "interview", "discussion": "interview",
  "presentation": "presentation", "lecture": "presentation", "speech": "presentation", "webinar": "presentation",
  "documentary": "documentary", "doc": "documentary", "docuseries": "documentary",
  "spiritual": "spiritual", "religious": "spiritual", "meditation": "spiritual", "mindfulness": "spiritual",
  "educational": "educational", "learning": "educational", "teaching": "educational", "informative": "educational",
  "entertainment": "entertainment", "fun": "entertainment", "enjoyable": "entertainment",
  "tech": "tech", "technology": "tech", "software": "tech", "hardware": "tech", "programming": "tech",
  "lifestyle": "lifestyle", "life": "lifestyle", "daily": "lifestyle",
  "gaming": "gaming", "game": "gaming", "videogame": "gaming", "esports": "gaming",
  "music": "music", "song": "music", "musical": "music", "concert": "music",
  "news": "news", "current": "news", "events": "news", "journalism": "news",
  "review": "review", "critique": "review", "opinion": "review", "analysis": "review",
  "motivational": "motivational", "motivation": "motivational", "inspiring": "motivational",
  "advertisement": "advertisement", "ad": "advertisement", "advertising": "advertisement",
  "promotional": "promotional", "promo": "promotional", "marketing": "promotional",
  "commercial": "commercial", "brand": "commercial",
  "product": "product", "unboxing": "product", "showcase": "product",
  "finance": "finance", "financial": "finance", "money": "finance", "investing": "finance", "investment": "finance",
  "business": "business", "corporate": "business", "enterprise": "business", "startup": "business",
  "cooking": "cooking", "food": "cooking", "recipe": "cooking", "culinary": "cooking",
  "fitness": "fitness", "workout": "fitness", "exercise": "fitness", "health": "fitness",
  "travel": "travel", "trip": "travel", "vacation": "travel", "tourism": "travel",
  "comedy": "comedy", "funny": "comedy", "humor": "comedy", "comedic": "comedy",
  "drama": "drama", "dramatic": "drama", "emotional": "drama",
  "other": "other", "unknown": "other", "misc": "other", "general": "other",
};
const normalizeGenre = (val: string): string => {
  const normalized = extractFirstWord(val);
  return genreMap[normalized] ?? genreMap[val.toLowerCase()] ?? "other";
};

// Edit action type synonyms
const editActionTypeMap: Record<string, "cut" | "keep" | "insert_stock" | "insert_ai_image" | "add_caption" | "add_text_overlay" | "transition" | "speed_change"> = {
  "cut": "cut", "remove": "cut", "delete": "cut", "trim": "cut", "remove_silent_parts": "cut",
  "keep": "keep", "retain": "keep", "preserve": "keep", "maintain": "keep",
  "insert_stock": "insert_stock", "stock": "insert_stock", "broll": "insert_stock", "b-roll": "insert_stock",
  "insert_ai_image": "insert_ai_image", "ai_image": "insert_ai_image", "generated": "insert_ai_image",
  "add_caption": "add_caption", "caption": "add_caption", "subtitle": "add_caption", "text": "add_caption",
  "add_text_overlay": "add_text_overlay", "overlay": "add_text_overlay", "text_overlay": "add_text_overlay",
  "transition": "transition", "fade": "transition", "crossfade": "transition", "wipe": "transition",
  "speed_change": "speed_change", "speed": "speed_change", "tempo": "speed_change", "slowmo": "speed_change",
};
const normalizeEditActionType = createNormalizer(editActionTypeMap, "keep");

// Stock media type synonyms
const stockMediaTypeMap: Record<string, "image" | "video" | "ai_generated"> = {
  "image": "image", "photo": "image", "picture": "image", "still": "image",
  "video": "video", "clip": "video", "footage": "video", "motion": "video",
  "ai_generated": "ai_generated", "ai": "ai_generated", "generated": "ai_generated", "synthetic": "ai_generated",
};
const normalizeStockMediaType = createNormalizer(stockMediaTypeMap, "image");

// Quality pacing (for qualityScoreSchema)
const qualityPacingMap: Record<string, "slow" | "moderate" | "fast"> = {
  "slow": "slow", "relaxed": "slow",
  "moderate": "moderate", "medium": "moderate", "normal": "moderate", "balanced": "moderate",
  "fast": "fast", "quick": "fast", "rapid": "fast",
};
const normalizeQualityPacing = createNormalizer(qualityPacingMap, "moderate");

// Helper to create normalized enum with fallback transform
const normalizedEnum = <T extends [string, ...string[]]>(
  values: T,
  normalizer: (val: string) => T[number]
) => z.enum(values).or(z.string().transform(normalizer));

// Coerced number that handles string inputs from AI
const coercedNumber = () => z.coerce.number().refine(v => !Number.isNaN(v), { message: "Expected valid number" });
const coercedNumberMin = (min: number) => z.coerce.number().min(min).refine(v => !Number.isNaN(v), { message: "Expected valid number" });
const coercedNumberMax = (max: number) => z.coerce.number().max(max).refine(v => !Number.isNaN(v), { message: "Expected valid number" });
const coercedNumberRange = (min: number, max: number) => z.coerce.number().min(min).max(max).refine(v => !Number.isNaN(v), { message: "Expected valid number" });

// Coerced number with fallback - use only for optional/non-critical fields where NaN should be treated as default
const coercedNumberWithDefault = (defaultValue: number = 0) => z.preprocess(
  (val) => {
    const num = Number(val);
    return Number.isNaN(num) || val === undefined || val === null ? defaultValue : num;
  },
  z.number()
);

export const projectStatusEnum = pgEnum("project_status", [
  "pending",
  "uploading",
  "analyzing",
  "transcribing",
  "planning",
  "fetching_stock",
  "generating_ai_images",
  "awaiting_review",
  "editing",
  "rendering",
  "completed",
  "failed",
  "cancelled"
]);

export type ProjectStatus = typeof projectStatusEnum.enumValues[number];

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// Processing stages for resumable processing
export const processingStageEnum = z.enum([
  "upload",           // Initial upload complete
  "transcription",    // Audio transcription
  "analysis",         // Video analysis
  "planning",         // Edit plan generation
  "media_fetch",      // Stock media fetching
  "media_selection",  // AI media selection
  "review_ready",     // Ready for user review
  "rendering",        // Final rendering
  "complete",         // Processing complete
]);
export type ProcessingStage = z.infer<typeof processingStageEnum>;

export const videoProjects = pgTable("video_projects", {
  id: serial("id").primaryKey(),
  fileName: text("file_name").notNull(),
  originalPath: text("original_path").notNull(),
  outputPath: text("output_path"),
  prompt: text("prompt"),
  status: projectStatusEnum("status").notNull().default("pending"),
  processingStage: text("processing_stage"), // Track where processing was interrupted for resumption
  duration: integer("duration"),
  analysis: jsonb("analysis"),
  editPlan: jsonb("edit_plan"),
  transcript: jsonb("transcript"),
  transcriptEnhanced: jsonb("transcript_enhanced"), // Speakers, chapters, sentiment, entities from AssemblyAI
  stockMedia: jsonb("stock_media"),
  reviewData: jsonb("review_data"),
  errorMessage: text("error_message"),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  expiresAt: timestamp("expires_at").default(sql`CURRENT_TIMESTAMP + INTERVAL '1 hour'`).notNull(),
}, (table) => ({
  statusIdx: index("video_projects_status_idx").on(table.status),
  createdAtIdx: index("video_projects_created_at_idx").on(table.createdAt),
  expiresAtIdx: index("video_projects_expires_at_idx").on(table.expiresAt),
}));

export const cachedAssets = pgTable("cached_assets", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").references(() => videoProjects.id, { onDelete: "cascade" }),
  cacheType: text("cache_type").notNull(),
  cacheKey: text("cache_key").notNull(),
  data: jsonb("data").notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  expiresAt: timestamp("expires_at").default(sql`CURRENT_TIMESTAMP + INTERVAL '1 hour'`).notNull(),
}, (table) => ({
  typeKeyIdx: index("cached_assets_type_key_idx").on(table.cacheType, table.cacheKey),
  expiresAtIdx: index("cached_assets_expires_at_idx").on(table.expiresAt),
}));

export type CachedAsset = typeof cachedAssets.$inferSelect;
export type InsertCachedAsset = typeof cachedAssets.$inferInsert;

export const projectAutosaves = pgTable("project_autosaves", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").references(() => videoProjects.id, { onDelete: "cascade" }).notNull(),
  reviewData: jsonb("review_data").notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => ({
  projectIdIdx: index("project_autosaves_project_id_idx").on(table.projectId),
}));

export type ProjectAutosave = typeof projectAutosaves.$inferSelect;
export type InsertProjectAutosave = typeof projectAutosaves.$inferInsert;

export const editFeedback = pgTable("edit_feedback", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").references(() => videoProjects.id, { onDelete: "cascade" }),
  editActionId: text("edit_action_id").notNull(),
  actionType: text("action_type").notNull(),
  wasApproved: integer("was_approved").notNull(),
  wasModified: integer("was_modified").notNull().default(0),
  userReason: text("user_reason"),
  originalStart: integer("original_start"),
  originalEnd: integer("original_end"),
  modifiedStart: integer("modified_start"),
  modifiedEnd: integer("modified_end"),
  contextGenre: text("context_genre"),
  contextTone: text("context_tone"),
  contextDuration: integer("context_duration"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => ({
  projectIdIdx: index("edit_feedback_project_id_idx").on(table.projectId),
  actionTypeIdx: index("edit_feedback_action_type_idx").on(table.actionType),
}));

export type EditFeedbackRecord = typeof editFeedback.$inferSelect;
export type InsertEditFeedback = typeof editFeedback.$inferInsert;

export const insertVideoProjectSchema = createInsertSchema(videoProjects).omit({
  id: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  expiresAt: true,
});

export type InsertVideoProject = z.infer<typeof insertVideoProjectSchema>;
export type VideoProject = typeof videoProjects.$inferSelect;

export const processingStatusEnum = z.enum([
  "pending",
  "uploading",
  "analyzing",
  "transcribing",
  "planning",
  "fetching_stock",
  "generating_ai_images",
  "awaiting_review",
  "editing",
  "rendering",
  "completed",
  "failed",
  "cancelled"
]);

export type ProcessingStatus = z.infer<typeof processingStatusEnum>;

// AssemblyAI Enhanced Transcript Schemas
export const speakerInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  wordCount: z.number(),
  speakingTime: z.number(),
});

export const chapterInfoSchema = z.object({
  title: z.string(),
  summary: z.string(),
  gist: z.string(),
  start: z.number(),
  end: z.number(),
});

export const sentimentInfoSchema = z.object({
  text: z.string(),
  sentiment: z.enum(["positive", "negative", "neutral"]),
  confidence: z.number(),
  start: z.number(),
  end: z.number(),
  speaker: z.string().optional(),
});

export const entityInfoSchema = z.object({
  type: z.string(),
  text: z.string(),
  start: z.number(),
  end: z.number(),
});

export const transcriptEnhancedSchema = z.object({
  speakers: z.array(speakerInfoSchema).optional(),
  chapters: z.array(chapterInfoSchema).optional(),
  sentiments: z.array(sentimentInfoSchema).optional(),
  entities: z.array(entityInfoSchema).optional(),
  detectedLanguage: z.string().optional(),
});

export type SpeakerInfoType = z.infer<typeof speakerInfoSchema>;
export type ChapterInfoType = z.infer<typeof chapterInfoSchema>;
export type SentimentInfoType = z.infer<typeof sentimentInfoSchema>;
export type EntityInfoType = z.infer<typeof entityInfoSchema>;
export type TranscriptEnhancedType = z.infer<typeof transcriptEnhancedSchema>;

// Word-level timing for karaoke-style captions
export const wordTimingSchema = z.object({
  word: z.string(),
  start: coercedNumber(),
  end: coercedNumber(),
});

export type WordTiming = z.infer<typeof wordTimingSchema>;

export const transcriptSegmentSchema = z.object({
  start: coercedNumber(),
  end: coercedNumber(),
  text: z.string(),
  // Word-level timing for karaoke-style captions
  words: z.array(wordTimingSchema).optional(),
  // Semantic analysis fields
  keywords: z.array(z.string()).optional(),
  emotion: normalizedEnum(["neutral", "excited", "serious", "calm", "urgent", "inspirational"], normalizeEmotion).optional(),
  isBrollWindow: z.boolean().optional(),
  suggestedBrollQuery: z.string().optional(),
  topic: z.string().optional(),
  // Enhanced AI video editing fields
  isFiller: z.boolean().optional(),
  hookScore: coercedNumberRange(0, 100).optional(),
  topicId: z.string().optional(),
  emotionalTone: z.string().optional(),
  isKeyMoment: z.boolean().optional(),
});

export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;

// Scene detection segment
export const sceneSegmentSchema = z.object({
  start: coercedNumber(),
  end: coercedNumber(),
  sceneType: z.string(),
  visualDescription: z.string(),
  emotionalTone: z.string(),
  speakerId: z.string().nullish(),
  visualImportance: normalizedEnum(["high", "medium", "low"], normalizeImportance),
});

export type SceneSegment = z.infer<typeof sceneSegmentSchema>;

// Emotion flow tracking point
export const emotionFlowPointSchema = z.object({
  timestamp: coercedNumber(),
  emotion: z.string(),
  intensity: coercedNumberRange(0, 100),
});

export type EmotionFlowPoint = z.infer<typeof emotionFlowPointSchema>;

// Speaker diarization segment
export const speakerSegmentSchema = z.object({
  start: coercedNumber(),
  end: coercedNumber(),
  speakerId: z.string().nullish().transform(v => v ?? "speaker_1"),
  speakerLabel: z.string().optional(),
});

export type SpeakerSegment = z.infer<typeof speakerSegmentSchema>;

// Key moment in the video
export const keyMomentSchema = z.object({
  timestamp: coercedNumber(),
  type: normalizedEnum(["hook", "climax", "callToAction", "keyPoint", "transition"], normalizeKeyMomentType),
  description: z.string(),
  importance: normalizedEnum(["high", "medium", "low"], normalizeImportance),
  hookScore: coercedNumberRange(0, 100).optional(),
});

export type KeyMoment = z.infer<typeof keyMomentSchema>;

// Semantic transcript analysis result
export const semanticAnalysisSchema = z.object({
  mainTopics: z.array(z.string()),
  overallTone: normalizedEnum(["educational", "entertaining", "inspirational", "professional", "casual", "serious"], normalizeOverallTone),
  keyMoments: z.array(z.object({
    timestamp: coercedNumber(),
    description: z.string(),
    importance: normalizedEnum(["low", "medium", "high"], normalizeImportance),
  })),
  brollWindows: z.array(z.object({
    start: coercedNumber(),
    end: coercedNumber(),
    context: z.string(),
    suggestedQuery: z.string(),
    priority: normalizedEnum(["low", "medium", "high"], normalizeImportance),
    reason: z.string(),
  })),
  extractedKeywords: z.array(z.string()),
  contentSummary: z.string(),
  // Enhanced AI video editing fields
  fillerSegments: z.array(z.object({
    start: coercedNumber(),
    end: coercedNumber(),
    word: z.string(),
  })).optional(),
  hookMoments: z.array(z.object({
    timestamp: coercedNumber(),
    score: coercedNumber(),
    reason: z.string(),
  })).optional(),
  structureAnalysis: z.object({
    introEnd: coercedNumber().optional(),
    mainStart: coercedNumber().optional(),
    mainEnd: coercedNumber().optional(),
    outroStart: coercedNumber().optional(),
  }).optional(),
  topicFlow: z.array(z.object({
    id: z.string(),
    name: z.string(),
    start: coercedNumber(),
    end: coercedNumber(),
  })).optional(),
});

export type SemanticAnalysis = z.infer<typeof semanticAnalysisSchema>;

export const frameAnalysisSchema = z.object({
  timestamp: coercedNumber(),
  description: z.string(),
  keyMoment: z.boolean().optional(),
  suggestedStockQuery: z.string().optional(),
  energyLevel: normalizedEnum(["low", "medium", "high"], normalizeEnergyLevel).optional(),
  speakingPace: normalizedEnum(["slow", "normal", "fast"], normalizeSpeakingPace).optional(),
});

export type FrameAnalysis = z.infer<typeof frameAnalysisSchema>;

export const topicSegmentSchema = z.object({
  start: coercedNumber(),
  end: coercedNumber(),
  topic: z.string(),
  importance: normalizedEnum(["low", "medium", "high"], normalizeImportance).optional(),
  suggestedBrollWindow: z.boolean().optional(),
});

export type TopicSegment = z.infer<typeof topicSegmentSchema>;

// All valid genres - comprehensive list to handle AI variations
const genreValues = [
  "tutorial", "vlog", "interview", "presentation", "documentary",
  "spiritual", "educational", "entertainment", "tech", "lifestyle",
  "gaming", "music", "news", "review", "motivational", "advertisement",
  "promotional", "commercial", "product", "finance", "business", 
  "cooking", "fitness", "travel", "comedy", "drama", "other"
] as const;

export const videoContextSchema = z.object({
  genre: z.enum(genreValues).or(z.string().transform((val) => {
    const normalized = normalizeGenre(val);
    return genreValues.includes(normalized as any) ? normalized as typeof genreValues[number] : "other";
  })),
  subGenre: z.string().optional(),
  targetAudience: z.string().optional(),
  tone: normalizedEnum(["serious", "casual", "professional", "humorous", "inspirational", "dramatic", "calm"], normalizeTone),
  pacing: normalizedEnum(["slow", "moderate", "fast", "dynamic"], normalizePacing),
  visualStyle: z.string().optional(),
  suggestedEditStyle: normalizedEnum(["minimal", "moderate", "dynamic", "cinematic", "fast-paced"], normalizeEditStyle),
  regionalContext: z.string().optional(),
  languageDetected: z.string().optional(),
});

export type VideoContext = z.infer<typeof videoContextSchema>;

// Enhanced analysis schema for deep video understanding
export const enhancedAnalysisSchema = z.object({
  motionAnalysis: z.object({
    hasSignificantMotion: z.boolean(),
    motionIntensity: z.enum(["low", "medium", "high"]),
    actionSequences: z.array(z.object({
      start: coercedNumber(),
      end: coercedNumber(),
      description: z.string(),
    })).optional(),
  }).optional(),
  transitionAnalysis: z.object({
    detectedTransitions: z.array(z.object({
      timestamp: coercedNumber(),
      type: z.string(),
      description: z.string(),
    })).optional(),
    suggestedTransitionPoints: z.array(coercedNumber()).optional(),
  }).optional(),
  pacingAnalysis: z.object({
    overallPacing: z.enum(["slow", "moderate", "fast", "dynamic"]),
    pacingVariation: coercedNumber(),
    suggestedPacingAdjustments: z.array(z.object({
      timestamp: coercedNumber(),
      suggestion: z.string(),
      // Optional extended fields for future expansion
      start: coercedNumber().optional(),
      end: coercedNumber().optional(),
      adjustment: z.string().optional(),
      reason: z.string().optional(),
    })).optional(),
  }).optional(),
  audioVisualSync: z.object({
    syncQuality: z.enum(["excellent", "good", "fair", "poor"]),
    outOfSyncMoments: z.array(z.object({
      timestamp: coercedNumber(),
      issue: z.string(),
    })).optional(),
  }).optional(),
}).optional();

export type EnhancedAnalysis = z.infer<typeof enhancedAnalysisSchema>;

export const videoAnalysisSchema = z.object({
  duration: coercedNumber(),
  fps: coercedNumber().optional(),
  width: coercedNumber().optional(),
  height: coercedNumber().optional(),
  frames: z.array(frameAnalysisSchema).optional().default([]),
  silentSegments: z.array(z.object({
    start: coercedNumber(),
    end: coercedNumber(),
  })).optional(),
  summary: z.string().optional(),
  context: videoContextSchema.optional(),
  topicSegments: z.array(topicSegmentSchema).optional(),
  narrativeStructure: z.object({
    hasIntro: z.boolean().optional(),
    introEnd: coercedNumber().optional(),
    hasOutro: z.boolean().optional(),
    outroStart: coercedNumber().optional(),
    mainContentStart: coercedNumber().optional(),
    mainContentEnd: coercedNumber().optional(),
    peakMoments: z.array(coercedNumber()).optional(),
  }).optional(),
  brollOpportunities: z.array(z.object({
    start: coercedNumber(),
    end: coercedNumber(),
    suggestedDuration: coercedNumber(),
    query: z.string(),
    priority: normalizedEnum(["low", "medium", "high"], normalizeImportance),
    reason: z.string(),
  })).optional(),
  // New semantic analysis from transcript
  semanticAnalysis: semanticAnalysisSchema.optional(),
  // Enhanced AI video editing fields
  scenes: z.array(sceneSegmentSchema).optional(),
  emotionFlow: z.array(emotionFlowPointSchema).optional(),
  speakers: z.array(speakerSegmentSchema).optional(),
  keyMoments: z.array(keyMomentSchema).optional(),
  // Deep video analysis (motion, transitions, pacing, sync)
  enhancedAnalysis: enhancedAnalysisSchema,
});

export type VideoAnalysis = z.infer<typeof videoAnalysisSchema>;

// Quality score for edit plan quality assessment
export const qualityScoreSchema = z.object({
  pacing: normalizedEnum(["slow", "moderate", "fast"], normalizeQualityPacing),
  brollRelevance: normalizedEnum(["high", "medium", "low"], normalizeImportance),
  narrativeFlow: normalizedEnum(["high", "medium", "low"], normalizeImportance),
  overallScore: coercedNumberRange(0, 100),
});

export type QualityScore = z.infer<typeof qualityScoreSchema>;

export const editActionSchema = z.object({
  type: normalizedEnum(["cut", "keep", "insert_stock", "insert_ai_image", "add_caption", "add_text_overlay", "transition", "speed_change"], normalizeEditActionType),
  start: coercedNumber().optional(),
  end: coercedNumber().optional(),
  duration: coercedNumber().optional(),
  text: z.string().optional(),
  stockQuery: z.string().optional(),
  stockUrl: z.string().optional(),
  transitionType: z.string().optional(),
  timestamp: coercedNumber().optional(),
  speed: coercedNumber().optional(),
  reason: z.string().optional(),
  priority: normalizedEnum(["low", "medium", "high"], normalizeImportance).optional(),
  confidence: coercedNumber().optional(),
  transcriptContext: z.string().optional(),
  qualityScore: coercedNumberRange(0, 100).optional(),
});

export type EditAction = z.infer<typeof editActionSchema>;

export const editPlanSchema = z.object({
  actions: z.array(editActionSchema),
  stockQueries: z.array(z.string()).optional(),
  keyPoints: z.array(z.string()).optional(),
  estimatedDuration: coercedNumber().optional(),
  editingStrategy: z.object({
    approach: z.string().optional(),
    focusAreas: z.array(z.string()).optional(),
    avoidAreas: z.array(z.string()).optional(),
  }).optional(),
  qualityScore: coercedNumber().optional(),
  // Enhanced AI video editing field
  qualityMetrics: qualityScoreSchema.optional(),
});

export type EditPlan = z.infer<typeof editPlanSchema>;

export const stockMediaItemSchema = z.object({
  type: normalizedEnum(["image", "video", "ai_generated"], normalizeStockMediaType),
  query: z.string(),
  url: z.string(),
  thumbnailUrl: z.string().optional(),
  duration: coercedNumber().optional(),
  photographer: z.string().optional(),
  // Source provider (pexels, freepik, ai)
  source: z.enum(["pexels", "freepik", "ai"]).optional(),
  // Freepik-specific metadata
  freepikId: z.number().optional(),
  freepikPremium: z.boolean().optional(),
  // AI generation metadata
  aiPrompt: z.string().optional(),
  generatedAt: coercedNumber().optional(),
  // Timing info for deterministic placement (AI images)
  startTime: coercedNumber().optional(),
  endTime: coercedNumber().optional(),
});

export type StockMediaItem = z.infer<typeof stockMediaItemSchema>;

// Edit options passed from frontend
export const editOptionsSchema = z.object({
  addCaptions: z.boolean().default(true),
  addBroll: z.boolean().default(true),
  removeSilence: z.boolean().default(true),
  generateAiImages: z.boolean().default(false),
  addTransitions: z.boolean().default(false),
});

export type EditOptionsType = z.infer<typeof editOptionsSchema>;

// Review data for user approval before final processing
export const reviewMediaItemSchema = z.object({
  id: z.string(),
  type: normalizedEnum(["image", "video", "ai_generated"], normalizeStockMediaType),
  query: z.string(),
  url: z.string(),
  thumbnailUrl: z.string().optional(),
  duration: coercedNumber().optional(),
  startTime: coercedNumber().optional(),
  endTime: coercedNumber().optional(),
  reason: z.string().optional(),
  approved: z.boolean().default(true),
});

export type ReviewMediaItem = z.infer<typeof reviewMediaItemSchema>;

export const reviewEditActionSchema = z.object({
  id: z.string(),
  type: normalizedEnum(["cut", "keep", "insert_stock", "insert_ai_image", "add_caption", "add_text_overlay", "transition", "speed_change"], normalizeEditActionType),
  start: coercedNumber().optional(),
  end: coercedNumber().optional(),
  duration: coercedNumber().optional(),
  text: z.string().optional(),
  reason: z.string().optional(),
  approved: z.boolean().default(true),
});

export type ReviewEditAction = z.infer<typeof reviewEditActionSchema>;

export const reviewTranscriptSegmentSchema = z.object({
  id: z.string(),
  start: coercedNumber(),
  end: coercedNumber(),
  text: z.string(),
  words: z.array(wordTimingSchema).optional(),
  emotion: z.string().optional(),
  approved: z.boolean().default(true),
  edited: z.boolean().default(false),
});

export type ReviewTranscriptSegment = z.infer<typeof reviewTranscriptSegmentSchema>;

export const aiReviewResultSchema = z.object({
  confidence: coercedNumber(),
  approved: z.boolean(),
  editQualityScore: coercedNumber(),
  narrativeFlowScore: coercedNumber(),
  pacingScore: coercedNumber(),
  issues: z.array(z.object({
    severity: z.enum(["low", "medium", "high"]),
    description: z.string(),
    suggestion: z.string(),
  })).optional(),
  suggestions: z.array(z.string()).optional(),
  summary: z.string().optional(),
});

export type AiReviewResult = z.infer<typeof aiReviewResultSchema>;

export const reviewDataSchema = z.object({
  transcript: z.array(reviewTranscriptSegmentSchema),
  editPlan: z.object({
    actions: z.array(reviewEditActionSchema),
    estimatedDuration: coercedNumber().optional(),
    originalDuration: coercedNumber().optional(),
  }),
  stockMedia: z.array(reviewMediaItemSchema),
  aiImages: z.array(reviewMediaItemSchema),
  summary: z.object({
    originalDuration: coercedNumber(),
    estimatedFinalDuration: coercedNumber(),
    totalCuts: coercedNumber(),
    totalKeeps: coercedNumber(),
    totalBroll: coercedNumber(),
    totalAiImages: coercedNumber(),
  }),
  userApproved: z.boolean().default(false),
  userNotes: z.string().optional(),
  editOptions: editOptionsSchema.optional(),
  aiReview: aiReviewResultSchema.optional(),
});

export type ReviewData = z.infer<typeof reviewDataSchema>;
