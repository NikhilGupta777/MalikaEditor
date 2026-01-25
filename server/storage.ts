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
  videoAnalysisSchema,
  editPlanSchema,
  transcriptSegmentSchema,
  stockMediaItemSchema,
  reviewDataSchema,
} from "@shared/schema";
import { randomUUID } from "crypto";
import { z } from "zod";
import { createLogger } from "./utils/logger";

const logger = createLogger("storage");

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
}

const MAX_PROJECTS = 100;

export class MemStorage implements IStorage {
  private users: Map<string, User>;
  private videoProjects: Map<number, VideoProject>;
  private projectLastAccessed: Map<number, number>;
  private nextProjectId: number;

  constructor() {
    this.users = new Map();
    this.videoProjects = new Map();
    this.projectLastAccessed = new Map();
    this.nextProjectId = 1;
  }

  private evictLeastRecentlyAccessed(): void {
    if (this.videoProjects.size < MAX_PROJECTS) return;

    let oldestId: number | null = null;
    let oldestTime = Infinity;

    for (const entry of Array.from(this.projectLastAccessed.entries())) {
      const [id, lastAccessed] = entry;
      if (lastAccessed < oldestTime) {
        oldestTime = lastAccessed;
        oldestId = id;
      }
    }

    if (oldestId !== null) {
      this.videoProjects.delete(oldestId);
      this.projectLastAccessed.delete(oldestId);
    }
  }

  private updateLastAccessed(id: number): void {
    this.projectLastAccessed.set(id, Date.now());
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

  private validateAndNormalizeJsonbFields(data: Partial<VideoProject>): Partial<VideoProject> {
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

  async createVideoProject(project: InsertVideoProject): Promise<VideoProject> {
    this.evictLeastRecentlyAccessed();
    
    const normalizedProject = this.validateAndNormalizeJsonbFields(project as Partial<VideoProject>);
    
    const id = this.nextProjectId++;
    const now = new Date();
    const videoProject: VideoProject = {
      id,
      fileName: project.fileName,
      originalPath: project.originalPath,
      outputPath: project.outputPath || null,
      prompt: project.prompt || null,
      status: project.status || "pending",
      duration: project.duration || null,
      analysis: (normalizedProject.analysis as any) || null,
      editPlan: (normalizedProject.editPlan as any) || null,
      transcript: (normalizedProject.transcript as any) || null,
      stockMedia: (normalizedProject.stockMedia as any) || null,
      reviewData: (normalizedProject.reviewData as any) || null,
      errorMessage: project.errorMessage || null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.videoProjects.set(id, videoProject);
    this.updateLastAccessed(id);
    return videoProject;
  }

  async getVideoProject(id: number): Promise<VideoProject | undefined> {
    const project = this.videoProjects.get(id);
    if (project) {
      this.updateLastAccessed(id);
    }
    return project;
  }

  async updateVideoProject(
    id: number,
    updates: Partial<VideoProject>,
    expectedVersion?: number
  ): Promise<VideoProject | undefined> {
    const project = this.videoProjects.get(id);
    if (!project) return undefined;

    if (expectedVersion !== undefined && project.version !== expectedVersion) {
      throw new OptimisticLockError(
        `Version mismatch for project ${id}: expected ${expectedVersion}, found ${project.version}`
      );
    }

    const normalizedUpdates = this.validateAndNormalizeJsonbFields(updates);

    const updatedProject: VideoProject = {
      ...project,
      ...updates,
      ...normalizedUpdates,
      version: project.version + 1,
      updatedAt: new Date(),
    };
    this.videoProjects.set(id, updatedProject);
    this.updateLastAccessed(id);
    return updatedProject;
  }

  async getAllVideoProjects(): Promise<VideoProject[]> {
    return Array.from(this.videoProjects.values()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    );
  }
}

export const storage = new MemStorage();
