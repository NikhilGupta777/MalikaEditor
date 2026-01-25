import {
  type User,
  type InsertUser,
  type VideoProject,
  type InsertVideoProject,
  type ProcessingStatus,
  type EditPlan,
  type StockMediaItem,
  type VideoAnalysis,
} from "@shared/schema";
import { randomUUID } from "crypto";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  createVideoProject(project: InsertVideoProject): Promise<VideoProject>;
  getVideoProject(id: number): Promise<VideoProject | undefined>;
  updateVideoProject(id: number, updates: Partial<VideoProject>): Promise<VideoProject | undefined>;
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

    for (const [id, lastAccessed] of this.projectLastAccessed) {
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

  async createVideoProject(project: InsertVideoProject): Promise<VideoProject> {
    this.evictLeastRecentlyAccessed();
    
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
      analysis: project.analysis || null,
      editPlan: project.editPlan || null,
      transcript: project.transcript || null,
      stockMedia: project.stockMedia || null,
      errorMessage: project.errorMessage || null,
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
    updates: Partial<VideoProject>
  ): Promise<VideoProject | undefined> {
    const project = this.videoProjects.get(id);
    if (!project) return undefined;

    const updatedProject: VideoProject = {
      ...project,
      ...updates,
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
