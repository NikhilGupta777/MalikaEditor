import { sql } from "drizzle-orm";
import { pgTable, text, varchar, serial, integer, timestamp, jsonb, pgEnum, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const projectStatusEnum = pgEnum("project_status", [
  "pending",
  "uploading",
  "analyzing",
  "transcribing",
  "planning",
  "fetching_stock",
  "generating_ai_images",
  "editing",
  "rendering",
  "completed",
  "failed"
]);

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

export const videoProjects = pgTable("video_projects", {
  id: serial("id").primaryKey(),
  fileName: text("file_name").notNull(),
  originalPath: text("original_path").notNull(),
  outputPath: text("output_path"),
  prompt: text("prompt"),
  status: projectStatusEnum("status").notNull().default("pending"),
  duration: integer("duration"),
  analysis: jsonb("analysis"),
  editPlan: jsonb("edit_plan"),
  transcript: jsonb("transcript"),
  stockMedia: jsonb("stock_media"),
  errorMessage: text("error_message"),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => ({
  statusIdx: index("video_projects_status_idx").on(table.status),
  createdAtIdx: index("video_projects_created_at_idx").on(table.createdAt),
}));

export const insertVideoProjectSchema = createInsertSchema(videoProjects).omit({
  id: true,
  version: true,
  createdAt: true,
  updatedAt: true,
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
  "editing",
  "rendering",
  "completed",
  "failed"
]);

export type ProcessingStatus = z.infer<typeof processingStatusEnum>;

// Word-level timing for karaoke-style captions
export const wordTimingSchema = z.object({
  word: z.string(),
  start: z.number(),
  end: z.number(),
});

export type WordTiming = z.infer<typeof wordTimingSchema>;

export const transcriptSegmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
  // Word-level timing for karaoke-style captions
  words: z.array(wordTimingSchema).optional(),
  // Semantic analysis fields
  keywords: z.array(z.string()).optional(),
  emotion: z.enum(["neutral", "excited", "serious", "calm", "urgent", "inspirational"]).optional(),
  isBrollWindow: z.boolean().optional(),
  suggestedBrollQuery: z.string().optional(),
  topic: z.string().optional(),
  // Enhanced AI video editing fields
  isFiller: z.boolean().optional(),
  hookScore: z.number().min(0).max(100).optional(),
  topicId: z.string().optional(),
  emotionalTone: z.string().optional(),
  isKeyMoment: z.boolean().optional(),
});

export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;

// Scene detection segment
export const sceneSegmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  sceneType: z.string(),
  visualDescription: z.string(),
  emotionalTone: z.string(),
  speakerId: z.string().optional(),
  visualImportance: z.enum(["high", "medium", "low"]),
});

export type SceneSegment = z.infer<typeof sceneSegmentSchema>;

// Emotion flow tracking point
export const emotionFlowPointSchema = z.object({
  timestamp: z.number(),
  emotion: z.string(),
  intensity: z.number().min(0).max(100),
});

export type EmotionFlowPoint = z.infer<typeof emotionFlowPointSchema>;

// Speaker diarization segment
export const speakerSegmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  speakerId: z.string(),
  speakerLabel: z.string().optional(),
});

export type SpeakerSegment = z.infer<typeof speakerSegmentSchema>;

// Key moment in the video
export const keyMomentSchema = z.object({
  timestamp: z.number(),
  type: z.enum(["hook", "climax", "callToAction", "keyPoint", "transition"]),
  description: z.string(),
  importance: z.enum(["high", "medium", "low"]),
  hookScore: z.number().min(0).max(100).optional(),
});

export type KeyMoment = z.infer<typeof keyMomentSchema>;

// Semantic transcript analysis result
export const semanticAnalysisSchema = z.object({
  mainTopics: z.array(z.string()),
  overallTone: z.enum(["educational", "entertaining", "inspirational", "professional", "casual", "serious"]),
  keyMoments: z.array(z.object({
    timestamp: z.number(),
    description: z.string(),
    importance: z.enum(["low", "medium", "high"]),
  })),
  brollWindows: z.array(z.object({
    start: z.number(),
    end: z.number(),
    context: z.string(),
    suggestedQuery: z.string(),
    priority: z.enum(["low", "medium", "high"]),
    reason: z.string(),
  })),
  extractedKeywords: z.array(z.string()),
  contentSummary: z.string(),
  // Enhanced AI video editing fields
  fillerSegments: z.array(z.object({
    start: z.number(),
    end: z.number(),
    word: z.string(),
  })).optional(),
  hookMoments: z.array(z.object({
    timestamp: z.number(),
    score: z.number(),
    reason: z.string(),
  })).optional(),
  structureAnalysis: z.object({
    introEnd: z.number().optional(),
    mainStart: z.number().optional(),
    mainEnd: z.number().optional(),
    outroStart: z.number().optional(),
  }).optional(),
  topicFlow: z.array(z.object({
    id: z.string(),
    name: z.string(),
    start: z.number(),
    end: z.number(),
  })).optional(),
});

export type SemanticAnalysis = z.infer<typeof semanticAnalysisSchema>;

export const frameAnalysisSchema = z.object({
  timestamp: z.number(),
  description: z.string(),
  keyMoment: z.boolean().optional(),
  suggestedStockQuery: z.string().optional(),
  energyLevel: z.enum(["low", "medium", "high"]).optional(),
  speakingPace: z.enum(["slow", "normal", "fast"]).optional(),
});

export type FrameAnalysis = z.infer<typeof frameAnalysisSchema>;

export const topicSegmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  topic: z.string(),
  importance: z.enum(["low", "medium", "high"]).optional(),
  suggestedBrollWindow: z.boolean().optional(),
});

export type TopicSegment = z.infer<typeof topicSegmentSchema>;

export const videoContextSchema = z.object({
  genre: z.enum([
    "tutorial", "vlog", "interview", "presentation", "documentary",
    "spiritual", "educational", "entertainment", "tech", "lifestyle",
    "gaming", "music", "news", "review", "motivational", "other"
  ]),
  subGenre: z.string().optional(),
  targetAudience: z.string().optional(),
  tone: z.enum(["serious", "casual", "professional", "humorous", "inspirational", "dramatic", "calm"]),
  pacing: z.enum(["slow", "moderate", "fast", "dynamic"]),
  visualStyle: z.string().optional(),
  suggestedEditStyle: z.enum([
    "minimal", "moderate", "dynamic", "cinematic", "fast-paced"
  ]),
  regionalContext: z.string().optional(),
  languageDetected: z.string().optional(),
});

export type VideoContext = z.infer<typeof videoContextSchema>;

export const videoAnalysisSchema = z.object({
  duration: z.number(),
  fps: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  frames: z.array(frameAnalysisSchema),
  silentSegments: z.array(z.object({
    start: z.number(),
    end: z.number(),
  })).optional(),
  summary: z.string().optional(),
  context: videoContextSchema.optional(),
  topicSegments: z.array(topicSegmentSchema).optional(),
  narrativeStructure: z.object({
    hasIntro: z.boolean().optional(),
    introEnd: z.number().optional(),
    hasOutro: z.boolean().optional(),
    outroStart: z.number().optional(),
    mainContentStart: z.number().optional(),
    mainContentEnd: z.number().optional(),
    peakMoments: z.array(z.number()).optional(),
  }).optional(),
  brollOpportunities: z.array(z.object({
    start: z.number(),
    end: z.number(),
    suggestedDuration: z.number(),
    query: z.string(),
    priority: z.enum(["low", "medium", "high"]),
    reason: z.string(),
  })).optional(),
  // New semantic analysis from transcript
  semanticAnalysis: semanticAnalysisSchema.optional(),
  // Enhanced AI video editing fields
  scenes: z.array(sceneSegmentSchema).optional(),
  emotionFlow: z.array(emotionFlowPointSchema).optional(),
  speakers: z.array(speakerSegmentSchema).optional(),
  keyMoments: z.array(keyMomentSchema).optional(),
});

export type VideoAnalysis = z.infer<typeof videoAnalysisSchema>;

// Quality score for edit plan quality assessment
export const qualityScoreSchema = z.object({
  pacing: z.enum(["slow", "moderate", "fast"]),
  brollRelevance: z.enum(["high", "medium", "low"]),
  narrativeFlow: z.enum(["high", "medium", "low"]),
  overallScore: z.number().min(0).max(100),
});

export type QualityScore = z.infer<typeof qualityScoreSchema>;

export const editActionSchema = z.object({
  // Note: AI images are auto-placed from semantic analysis (not in edit plan)
  type: z.enum(["cut", "keep", "insert_stock", "add_caption", "add_text_overlay", "transition", "speed_change"]),
  start: z.number().optional(),
  end: z.number().optional(),
  duration: z.number().optional(),
  text: z.string().optional(),
  stockQuery: z.string().optional(),
  stockUrl: z.string().optional(),
  transitionType: z.string().optional(),
  speed: z.number().optional(),
  reason: z.string().optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  confidence: z.number().optional(),
  // Context from transcript for better matching
  transcriptContext: z.string().optional(),
  // Enhanced AI video editing field
  qualityScore: z.number().min(0).max(100).optional(),
});

export type EditAction = z.infer<typeof editActionSchema>;

export const editPlanSchema = z.object({
  actions: z.array(editActionSchema),
  stockQueries: z.array(z.string()).optional(),
  keyPoints: z.array(z.string()).optional(),
  estimatedDuration: z.number().optional(),
  editingStrategy: z.object({
    approach: z.string().optional(),
    focusAreas: z.array(z.string()).optional(),
    avoidAreas: z.array(z.string()).optional(),
  }).optional(),
  qualityScore: z.number().optional(),
  // Enhanced AI video editing field
  qualityMetrics: qualityScoreSchema.optional(),
});

export type EditPlan = z.infer<typeof editPlanSchema>;

export const stockMediaItemSchema = z.object({
  type: z.enum(["image", "video", "ai_generated"]),
  query: z.string(),
  url: z.string(),
  thumbnailUrl: z.string().optional(),
  duration: z.number().optional(),
  photographer: z.string().optional(),
  // AI generation metadata
  aiPrompt: z.string().optional(),
  generatedAt: z.number().optional(),
  // Timing info for deterministic placement (AI images)
  startTime: z.number().optional(),
  endTime: z.number().optional(),
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
