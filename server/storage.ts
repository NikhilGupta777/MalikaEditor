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

export class MemStorage implements IStorage {
  private users: Map<string, User>;
  private videoProjects: Map<number, VideoProject>;
  private nextProjectId: number;

  constructor() {
    this.users = new Map();
    this.videoProjects = new Map();
    this.nextProjectId = 1;
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
    return videoProject;
  }

  async getVideoProject(id: number): Promise<VideoProject | undefined> {
    return this.videoProjects.get(id);
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
    return updatedProject;
  }

  async getAllVideoProjects(): Promise<VideoProject[]> {
    return Array.from(this.videoProjects.values()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    );
  }
}

export const storage = new MemStorage();
