import {
  type User,
  type InsertUser,
  type VideoProject,
  type InsertVideoProject,
  type ProcessingStatus,
  type EditPlan,
  type StockMediaItem,
  type VideoAnalysis,
  type TranscriptSegment,
  type InsertEditFeedback,
  type EditFeedbackRecord,
  videoAnalysisSchema,
  editPlanSchema,
  transcriptSegmentSchema,
  stockMediaItemSchema,
  reviewDataSchema,
  videoProjects,
  cachedAssets,
  projectAutosaves,
  editFeedback,
} from "@shared/schema";
import { randomUUID } from "crypto";
import { z } from "zod";
import { createLogger } from "./utils/logger";
import { db } from "./db";
import { eq, desc, lt, and, gt, sql } from "drizzle-orm";

const logger = createLogger("storage");

// Transaction helper for multi-step database operations
export async function withTransaction<T>(
  operation: (tx: typeof db) => Promise<T>
): Promise<T> {
  return await db.transaction(async (tx) => {
    return await operation(tx as typeof db);
  });
}

export class OptimisticLockError extends Error {
  constructor(message: string = "Version mismatch: resource was modified by another request") {
    super(message);
    this.name = "OptimisticLockError";
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  createVideoProject(project: InsertVideoProject): Promise<VideoProject>;
  getVideoProject(id: number): Promise<VideoProject | undefined>;
  updateVideoProject(id: number, updates: Partial<VideoProject>, expectedVersion?: number): Promise<VideoProject | undefined>;
  getAllVideoProjects(): Promise<VideoProject[]>;
  deleteVideoProject(id: number): Promise<void>;
  getActiveProjects(): Promise<VideoProject[]>;
  cleanupExpiredProjects(): Promise<number>;

  getCachedAsset(cacheType: string, cacheKey: string): Promise<any | undefined>;
  setCachedAsset(cacheType: string, cacheKey: string, data: any, projectId?: number): Promise<void>;
  cleanupExpiredCache(): Promise<number>;

  getAutosave(projectId: number): Promise<any | undefined>;
  saveAutosave(projectId: number, reviewData: any): Promise<void>;
  deleteAutosave(projectId: number): Promise<void>;

  saveEditFeedback(feedback: InsertEditFeedback): Promise<EditFeedbackRecord>;
  getEditFeedbackByProject(projectId: number): Promise<EditFeedbackRecord[]>;
  getFeedbackSummary(): Promise<{
    approvalRate: number;
    totalFeedback: number;
    byActionType: Record<string, { approved: number; rejected: number }>;
  }>;
}

function validateAndNormalizeJsonbFields(data: Partial<VideoProject>): Partial<VideoProject> {
  const normalized = { ...data };
  
  if (data.analysis !== undefined && data.analysis !== null) {
    const result = videoAnalysisSchema.safeParse(data.analysis);
    if (!result.success) {
      logger.warn("Analysis data validation warning - storing raw data", {
        error: result.error.issues.slice(0, 3).map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
      });
    } else {
      normalized.analysis = result.data;
    }
  }
  
  if (data.editPlan !== undefined && data.editPlan !== null) {
    const result = editPlanSchema.safeParse(data.editPlan);
    if (!result.success) {
      logger.warn("EditPlan data validation warning - storing raw data", {
        error: result.error.issues.slice(0, 3).map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
      });
    } else {
      normalized.editPlan = result.data;
    }
  }
  
  if (data.transcript !== undefined && data.transcript !== null) {
    const result = z.array(transcriptSegmentSchema).safeParse(data.transcript);
    if (!result.success) {
      logger.warn("Transcript data validation warning - storing raw data", {
        error: result.error.issues.slice(0, 3).map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
      });
    } else {
      normalized.transcript = result.data;
    }
  }
  
  if (data.stockMedia !== undefined && data.stockMedia !== null) {
    const result = z.array(stockMediaItemSchema).safeParse(data.stockMedia);
    if (!result.success) {
      logger.warn("StockMedia data validation warning - storing raw data", {
        error: result.error.issues.slice(0, 3).map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
      });
    } else {
      normalized.stockMedia = result.data;
    }
  }
  
  if (data.reviewData !== undefined && data.reviewData !== null) {
    const result = reviewDataSchema.safeParse(data.reviewData);
    if (!result.success) {
      logger.warn("ReviewData validation warning - storing raw data", {
        error: result.error.issues.slice(0, 3).map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
      });
    } else {
      normalized.reviewData = result.data;
    }
  }
  
  return normalized;
}

export class MemStorage {
  private users: Map<string, User>;

  constructor() {
    this.users = new Map();
  }

  async getUser(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.username === username
    );
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = randomUUID();
    const user: User = { ...insertUser, id };
    this.users.set(id, user);
    return user;
  }
}

export class DatabaseStorage {
  async createVideoProject(project: InsertVideoProject): Promise<VideoProject> {
    try {
      const normalizedProject = validateAndNormalizeJsonbFields(project as Partial<VideoProject>);
      
      const [result] = await db.insert(videoProjects).values({
        fileName: project.fileName,
        originalPath: project.originalPath,
        outputPath: project.outputPath || null,
        prompt: project.prompt || null,
        status: project.status || "pending",
        duration: project.duration || null,
        analysis: normalizedProject.analysis || null,
        editPlan: normalizedProject.editPlan || null,
        transcript: normalizedProject.transcript || null,
        stockMedia: normalizedProject.stockMedia || null,
        reviewData: normalizedProject.reviewData || null,
        errorMessage: project.errorMessage || null,
      }).returning();
      
      logger.info("Created video project", { id: result.id, fileName: result.fileName });
      return result;
    } catch (error) {
      logger.error("Failed to create video project", { error, fileName: project.fileName });
      throw error;
    }
  }

  async getVideoProject(id: number): Promise<VideoProject | undefined> {
    try {
      const [result] = await db.select().from(videoProjects).where(eq(videoProjects.id, id));
      return result;
    } catch (error) {
      logger.error("Failed to get video project", { error, id });
      throw error;
    }
  }

  async updateVideoProject(
    id: number,
    updates: Partial<VideoProject>,
    expectedVersion?: number
  ): Promise<VideoProject | undefined> {
    try {
      const existing = await this.getVideoProject(id);
      if (!existing) return undefined;

      if (expectedVersion !== undefined && existing.version !== expectedVersion) {
        throw new OptimisticLockError(
          `Version mismatch for project ${id}: expected ${expectedVersion}, found ${existing.version}`
        );
      }

      const normalizedUpdates = validateAndNormalizeJsonbFields(updates);
      
      const updateData: any = {
        ...updates,
        ...normalizedUpdates,
        version: existing.version + 1,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      };
      
      delete updateData.id;
      delete updateData.createdAt;

      const [result] = await db.update(videoProjects)
        .set(updateData)
        .where(eq(videoProjects.id, id))
        .returning();

      logger.info("Updated video project", { id, version: result.version });
      return result;
    } catch (error) {
      if (error instanceof OptimisticLockError) throw error;
      logger.error("Failed to update video project", { error, id });
      throw error;
    }
  }

  async getAllVideoProjects(): Promise<VideoProject[]> {
    try {
      const results = await db.select()
        .from(videoProjects)
        .orderBy(desc(videoProjects.createdAt));
      return results;
    } catch (error) {
      logger.error("Failed to get all video projects", { error });
      throw error;
    }
  }

  async deleteVideoProject(id: number): Promise<void> {
    try {
      await db.delete(videoProjects).where(eq(videoProjects.id, id));
      logger.info("Deleted video project", { id });
    } catch (error) {
      logger.error("Failed to delete video project", { error, id });
      throw error;
    }
  }

  async getActiveProjects(): Promise<VideoProject[]> {
    try {
      const results = await db.select()
        .from(videoProjects)
        .where(gt(videoProjects.expiresAt, sql`CURRENT_TIMESTAMP`))
        .orderBy(desc(videoProjects.createdAt));
      return results;
    } catch (error) {
      logger.error("Failed to get active projects", { error });
      throw error;
    }
  }

  async cleanupExpiredProjects(): Promise<number> {
    try {
      const result = await db.delete(videoProjects)
        .where(lt(videoProjects.expiresAt, sql`CURRENT_TIMESTAMP`))
        .returning({ id: videoProjects.id });
      
      const count = result.length;
      if (count > 0) {
        logger.info("Cleaned up expired projects", { count });
      }
      return count;
    } catch (error) {
      logger.error("Failed to cleanup expired projects", { error });
      throw error;
    }
  }

  async getCachedAsset(cacheType: string, cacheKey: string): Promise<any | undefined> {
    try {
      const [result] = await db.select()
        .from(cachedAssets)
        .where(
          and(
            eq(cachedAssets.cacheType, cacheType),
            eq(cachedAssets.cacheKey, cacheKey),
            gt(cachedAssets.expiresAt, sql`CURRENT_TIMESTAMP`)
          )
        );
      return result?.data;
    } catch (error) {
      logger.error("Failed to get cached asset", { error, cacheType, cacheKey });
      throw error;
    }
  }

  async setCachedAsset(cacheType: string, cacheKey: string, data: any, projectId?: number): Promise<void> {
    try {
      // Use transaction for atomic delete + insert operation
      await withTransaction(async (tx) => {
        await tx.delete(cachedAssets).where(
          and(
            eq(cachedAssets.cacheType, cacheType),
            eq(cachedAssets.cacheKey, cacheKey)
          )
        );

        await tx.insert(cachedAssets).values({
          cacheType,
          cacheKey,
          data,
          projectId: projectId || null,
          expiresAt: sql`CURRENT_TIMESTAMP + INTERVAL '1 hour'`,
        });
      });

      logger.debug("Set cached asset", { cacheType, cacheKey });
    } catch (error) {
      logger.error("Failed to set cached asset", { error, cacheType, cacheKey });
      throw error;
    }
  }

  async cleanupExpiredCache(): Promise<number> {
    try {
      const result = await db.delete(cachedAssets)
        .where(lt(cachedAssets.expiresAt, sql`CURRENT_TIMESTAMP`))
        .returning({ id: cachedAssets.id });
      
      const count = result.length;
      if (count > 0) {
        logger.info("Cleaned up expired cache entries", { count });
      }
      return count;
    } catch (error) {
      logger.error("Failed to cleanup expired cache", { error });
      throw error;
    }
  }

  async getAutosave(projectId: number): Promise<any | undefined> {
    try {
      const [result] = await db.select()
        .from(projectAutosaves)
        .where(eq(projectAutosaves.projectId, projectId))
        .orderBy(desc(projectAutosaves.createdAt))
        .limit(1);
      return result?.reviewData;
    } catch (error) {
      logger.error("Failed to get autosave", { error, projectId });
      throw error;
    }
  }

  async saveAutosave(projectId: number, reviewData: any): Promise<void> {
    try {
      await db.delete(projectAutosaves).where(eq(projectAutosaves.projectId, projectId));

      await db.insert(projectAutosaves).values({
        projectId,
        reviewData,
      });

      logger.debug("Saved autosave", { projectId });
    } catch (error) {
      logger.error("Failed to save autosave", { error, projectId });
      throw error;
    }
  }

  async deleteAutosave(projectId: number): Promise<void> {
    try {
      await db.delete(projectAutosaves).where(eq(projectAutosaves.projectId, projectId));
      logger.debug("Deleted autosave", { projectId });
    } catch (error) {
      logger.error("Failed to delete autosave", { error, projectId });
      throw error;
    }
  }

  async saveEditFeedback(feedback: InsertEditFeedback): Promise<EditFeedbackRecord> {
    try {
      // Use transaction for atomic feedback insertion
      return await withTransaction(async (tx) => {
        const [result] = await tx.insert(editFeedback).values(feedback).returning();
        logger.debug("Saved edit feedback", { 
          id: result.id, 
          projectId: result.projectId,
          actionType: result.actionType,
          wasApproved: result.wasApproved,
        });
        return result;
      });
    } catch (error) {
      logger.error("Failed to save edit feedback", { error, projectId: feedback.projectId });
      throw error;
    }
  }

  async getEditFeedbackByProject(projectId: number): Promise<EditFeedbackRecord[]> {
    try {
      const results = await db.select()
        .from(editFeedback)
        .where(eq(editFeedback.projectId, projectId))
        .orderBy(desc(editFeedback.createdAt));
      return results;
    } catch (error) {
      logger.error("Failed to get edit feedback", { error, projectId });
      throw error;
    }
  }

  async getFeedbackSummary(): Promise<{
    approvalRate: number;
    totalFeedback: number;
    byActionType: Record<string, { approved: number; rejected: number }>;
  }> {
    try {
      const allFeedback = await db.select().from(editFeedback);
      
      if (allFeedback.length === 0) {
        return { approvalRate: 0, totalFeedback: 0, byActionType: {} };
      }
      
      const approved = allFeedback.filter(f => f.wasApproved === 1).length;
      const byActionType: Record<string, { approved: number; rejected: number }> = {};
      
      for (const f of allFeedback) {
        if (!byActionType[f.actionType]) {
          byActionType[f.actionType] = { approved: 0, rejected: 0 };
        }
        if (f.wasApproved === 1) {
          byActionType[f.actionType].approved++;
        } else {
          byActionType[f.actionType].rejected++;
        }
      }
      
      return {
        approvalRate: (approved / allFeedback.length) * 100,
        totalFeedback: allFeedback.length,
        byActionType,
      };
    } catch (error) {
      logger.error("Failed to get feedback summary", { error });
      throw error;
    }
  }
}

const memStorage = new MemStorage();
const dbStorage = new DatabaseStorage();

export const storage: IStorage = {
  getUser: memStorage.getUser.bind(memStorage),
  getUserByUsername: memStorage.getUserByUsername.bind(memStorage),
  createUser: memStorage.createUser.bind(memStorage),

  createVideoProject: dbStorage.createVideoProject.bind(dbStorage),
  getVideoProject: dbStorage.getVideoProject.bind(dbStorage),
  updateVideoProject: dbStorage.updateVideoProject.bind(dbStorage),
  getAllVideoProjects: dbStorage.getAllVideoProjects.bind(dbStorage),
  deleteVideoProject: dbStorage.deleteVideoProject.bind(dbStorage),
  getActiveProjects: dbStorage.getActiveProjects.bind(dbStorage),
  cleanupExpiredProjects: dbStorage.cleanupExpiredProjects.bind(dbStorage),

  getCachedAsset: dbStorage.getCachedAsset.bind(dbStorage),
  setCachedAsset: dbStorage.setCachedAsset.bind(dbStorage),
  cleanupExpiredCache: dbStorage.cleanupExpiredCache.bind(dbStorage),

  getAutosave: dbStorage.getAutosave.bind(dbStorage),
  saveAutosave: dbStorage.saveAutosave.bind(dbStorage),
  deleteAutosave: dbStorage.deleteAutosave.bind(dbStorage),

  saveEditFeedback: dbStorage.saveEditFeedback.bind(dbStorage),
  getEditFeedbackByProject: dbStorage.getEditFeedbackByProject.bind(dbStorage),
  getFeedbackSummary: dbStorage.getFeedbackSummary.bind(dbStorage),
};
