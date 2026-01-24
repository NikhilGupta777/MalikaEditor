import { sql } from "drizzle-orm";
import { pgTable, text, varchar, serial, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

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
  status: text("status").notNull().default("pending"),
  duration: integer("duration"),
  analysis: jsonb("analysis"),
  editPlan: jsonb("edit_plan"),
  transcript: jsonb("transcript"),
  stockMedia: jsonb("stock_media"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertVideoProjectSchema = createInsertSchema(videoProjects).omit({
  id: true,
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
  "editing",
  "rendering",
  "completed",
  "failed"
]);

export type ProcessingStatus = z.infer<typeof processingStatusEnum>;

export const transcriptSegmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
});

export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;

export const frameAnalysisSchema = z.object({
  timestamp: z.number(),
  description: z.string(),
  keyMoment: z.boolean().optional(),
  suggestedStockQuery: z.string().optional(),
});

export type FrameAnalysis = z.infer<typeof frameAnalysisSchema>;

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
});

export type VideoAnalysis = z.infer<typeof videoAnalysisSchema>;

export const editActionSchema = z.object({
  type: z.enum(["cut", "keep", "insert_stock", "add_caption", "add_text_overlay", "transition", "speed_change"]),
  start: z.number().optional(),
  end: z.number().optional(),
  text: z.string().optional(),
  stockQuery: z.string().optional(),
  stockUrl: z.string().optional(),
  transitionType: z.string().optional(),
  speed: z.number().optional(),
  reason: z.string().optional(),
});

export type EditAction = z.infer<typeof editActionSchema>;

export const editPlanSchema = z.object({
  actions: z.array(editActionSchema),
  stockQueries: z.array(z.string()).optional(),
  keyPoints: z.array(z.string()).optional(),
  estimatedDuration: z.number().optional(),
});

export type EditPlan = z.infer<typeof editPlanSchema>;

export const stockMediaItemSchema = z.object({
  type: z.enum(["image", "video"]),
  query: z.string(),
  url: z.string(),
  thumbnailUrl: z.string().optional(),
  duration: z.number().optional(),
  photographer: z.string().optional(),
});

export type StockMediaItem = z.infer<typeof stockMediaItemSchema>;
