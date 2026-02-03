/**
 * File Storage Service
 * 
 * Provides a unified interface for file storage that can use either:
 * - Local filesystem (development/default)
 * - Google Cloud Storage (production)
 * 
 * Configuration via environment variables:
 * - FILE_STORAGE_TYPE: 'local' | 'gcs' (default: 'local')
 * - GCS_BUCKET_NAME: Google Cloud Storage bucket name
 * - GCS_PROJECT_ID: Google Cloud project ID (optional, uses default)
 * - GOOGLE_APPLICATION_CREDENTIALS: Path to service account key (for GCS)
 */

import { Storage, Bucket } from "@google-cloud/storage";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createLogger } from "../utils/logger";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { v4 as uuidv4 } from "uuid";
import { Readable } from "stream";

const logger = createLogger("file-storage");

export type StorageType = "local" | "gcs" | "s3";

interface FileMetadata {
  contentType?: string;
  size?: number;
  createdAt?: Date;
  updatedAt?: Date;
  originalName?: string;
}

interface StoredFile {
  key: string;
  path: string;
  metadata: FileMetadata;
}

interface FileStorageConfig {
  type: StorageType;
  localBasePath?: string;
  gcsBucket?: string;
  gcsProjectId?: string;
  s3Bucket?: string;
  s3Region?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
}

// Get configuration from environment
function getConfig(): FileStorageConfig {
  const type = (process.env.FILE_STORAGE_TYPE || "local") as StorageType;

  return {
    type,
    localBasePath: process.env.UPLOADS_PATH || os.tmpdir(),
    gcsBucket: process.env.GCS_BUCKET_NAME,
    gcsProjectId: process.env.GCS_PROJECT_ID,
    s3Bucket: process.env.S3_BUCKET_NAME,
    s3Region: process.env.S3_REGION || "us-east-1",
    awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
    awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  };
}

// Local filesystem storage implementation
class LocalFileStorage {
  private basePath: string;
  private uploadsDir: string;
  private outputDir: string;

  constructor(basePath: string) {
    this.basePath = basePath;
    this.uploadsDir = path.join(basePath, "malika_uploads");
    this.outputDir = path.join(basePath, "malika_output");
  }

  async ensureDirs(): Promise<void> {
    await fs.mkdir(this.uploadsDir, { recursive: true });
    await fs.mkdir(this.outputDir, { recursive: true });
  }

  async uploadFile(
    localPath: string,
    key: string,
    metadata?: FileMetadata
  ): Promise<StoredFile> {
    await this.ensureDirs();

    const destDir = key.startsWith("output/") ? this.outputDir : this.uploadsDir;
    const fileName = path.basename(key);
    const destPath = path.join(destDir, fileName);

    await fs.copyFile(localPath, destPath);

    const stats = await fs.stat(destPath);

    return {
      key,
      path: destPath,
      metadata: {
        ...metadata,
        size: stats.size,
        createdAt: stats.birthtime,
        updatedAt: stats.mtime,
      },
    };
  }

  async downloadFile(key: string, destPath: string): Promise<void> {
    const srcDir = key.startsWith("output/") ? this.outputDir : this.uploadsDir;
    const fileName = path.basename(key);
    const srcPath = path.join(srcDir, fileName);

    await fs.copyFile(srcPath, destPath);
  }

  async getFileUrl(key: string): Promise<string> {
    const dir = key.startsWith("output/") ? this.outputDir : this.uploadsDir;
    const fileName = path.basename(key);
    return path.join(dir, fileName);
  }

  async getFilePath(key: string): Promise<string> {
    return this.getFileUrl(key);
  }

  async deleteFile(key: string): Promise<void> {
    const filePath = await this.getFilePath(key);
    try {
      await fs.unlink(filePath);
    } catch (error: any) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  async fileExists(key: string): Promise<boolean> {
    try {
      const filePath = await this.getFilePath(key);
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async listFiles(prefix: string): Promise<string[]> {
    const dir = prefix.startsWith("output/") ? this.outputDir : this.uploadsDir;
    try {
      const files = await fs.readdir(dir);
      return files.map(f => path.join(prefix.startsWith("output/") ? "output" : "uploads", f));
    } catch {
      return [];
    }
  }

  getUploadsDir(): string {
    return this.uploadsDir;
  }

  getOutputDir(): string {
    return this.outputDir;
  }
}

// Google Cloud Storage implementation
class GCSFileStorage {
  private storage: Storage;
  private bucket: Bucket;
  private bucketName: string;
  private localCacheDir: string;

  constructor(bucketName: string, projectId?: string) {
    const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    let storageOptions: any = { projectId };

    if (credentialsJson) {
      try {
        storageOptions.credentials = JSON.parse(credentialsJson);
        logger.info("Using GCS credentials from environment variable");
      } catch (error) {
        logger.error("Failed to parse GOOGLE_APPLICATION_CREDENTIALS_JSON:", error);
      }
    }

    this.storage = new Storage(storageOptions);
    this.bucketName = bucketName;
    this.bucket = this.storage.bucket(bucketName);
    this.localCacheDir = path.join(os.tmpdir(), "malika_gcs_cache");
  }

  async ensureDirs(): Promise<void> {
    await fs.mkdir(this.localCacheDir, { recursive: true });
    await fs.mkdir(path.join(this.localCacheDir, "uploads"), { recursive: true });
    await fs.mkdir(path.join(this.localCacheDir, "output"), { recursive: true });
  }

  async uploadFile(
    localPath: string,
    key: string,
    metadata?: FileMetadata
  ): Promise<StoredFile> {
    await this.ensureDirs();

    const gcsKey = key.startsWith("/") ? key.slice(1) : key;

    try {
      await this.bucket.upload(localPath, {
        destination: gcsKey,
        metadata: {
          contentType: metadata?.contentType || "application/octet-stream",
          metadata: {
            originalName: metadata?.originalName || path.basename(localPath),
          },
        },
      });

      logger.info(`Uploaded file to GCS: ${gcsKey}`);

      return {
        key: gcsKey,
        path: `gs://${this.bucketName}/${gcsKey}`,
        metadata: {
          ...metadata,
        },
      };
    } catch (error) {
      logger.error(`Failed to upload to GCS: ${error}`);
      throw error;
    }
  }

  async downloadFile(key: string, destPath: string): Promise<void> {
    const gcsKey = key.startsWith("/") ? key.slice(1) : key;

    try {
      await this.bucket.file(gcsKey).download({ destination: destPath });
      logger.info(`Downloaded file from GCS: ${gcsKey} -> ${destPath}`);
    } catch (error) {
      logger.error(`Failed to download from GCS: ${error}`);
      throw error;
    }
  }

  async getFileUrl(key: string, expiresIn: number = 3600): Promise<string> {
    const gcsKey = key.startsWith("/") ? key.slice(1) : key;

    try {
      const [signedUrl] = await this.bucket.file(gcsKey).getSignedUrl({
        action: "read",
        expires: Date.now() + expiresIn * 1000,
      });
      return signedUrl;
    } catch (error) {
      logger.error(`Failed to get signed URL: ${error}`);
      throw error;
    }
  }

  async getFilePath(key: string): Promise<string> {
    // For GCS, we need to download to a local cache first
    await this.ensureDirs();

    const gcsKey = key.startsWith("/") ? key.slice(1) : key;
    const localPath = path.join(this.localCacheDir, gcsKey);

    // Create directory structure
    await fs.mkdir(path.dirname(localPath), { recursive: true });

    // Check if already cached
    try {
      await fs.access(localPath);
      return localPath;
    } catch {
      // Download to cache
      await this.downloadFile(key, localPath);
      return localPath;
    }
  }

  async deleteFile(key: string): Promise<void> {
    const gcsKey = key.startsWith("/") ? key.slice(1) : key;

    try {
      await this.bucket.file(gcsKey).delete();
      logger.info(`Deleted file from GCS: ${gcsKey}`);

      // Also delete from local cache
      const localPath = path.join(this.localCacheDir, gcsKey);
      try {
        await fs.unlink(localPath);
      } catch {
        // Ignore if not in cache
      }
    } catch (error: any) {
      if (error.code !== 404) {
        throw error;
      }
    }
  }

  async fileExists(key: string): Promise<boolean> {
    const gcsKey = key.startsWith("/") ? key.slice(1) : key;

    try {
      const [exists] = await this.bucket.file(gcsKey).exists();
      return exists;
    } catch {
      return false;
    }
  }

  async listFiles(prefix: string): Promise<string[]> {
    try {
      const [files] = await this.bucket.getFiles({ prefix });
      return files.map(f => f.name);
    } catch {
      return [];
    }
  }

  getUploadsDir(): string {
    // For processing, we still need local dirs
    return path.join(this.localCacheDir, "uploads");
  }

  getOutputDir(): string {
    return path.join(this.localCacheDir, "output");
  }

  async clearCache(): Promise<number> {
    let cleared = 0;
    try {
      const cacheFiles = await fs.readdir(this.localCacheDir, { recursive: true });
      for (const file of cacheFiles) {
        const fullPath = path.join(this.localCacheDir, file.toString());
        try {
          const stat = await fs.stat(fullPath);
          if (stat.isFile()) {
            await fs.unlink(fullPath);
            cleared++;
          }
        } catch {
          // Ignore errors
        }
      }
    } catch {
      // Ignore errors
    }
    return cleared;
  }
}

// AWS S3 Storage implementation
class S3FileStorage {
  private s3Client: S3Client;
  private bucketName: string;
  private localCacheDir: string;

  constructor(bucketName: string, region: string, accessKeyId?: string, secretAccessKey?: string) {
    const config: any = { region };

    if (accessKeyId && secretAccessKey) {
      config.credentials = {
        accessKeyId,
        secretAccessKey,
      };
      logger.info("Using S3 credentials from environment variables");
    }

    this.s3Client = new S3Client(config);
    this.bucketName = bucketName;
    this.localCacheDir = path.join(os.tmpdir(), "malika_s3_cache");
  }

  async ensureDirs(): Promise<void> {
    await fs.mkdir(this.localCacheDir, { recursive: true });
    await fs.mkdir(path.join(this.localCacheDir, "uploads"), { recursive: true });
    await fs.mkdir(path.join(this.localCacheDir, "output"), { recursive: true });
  }

  async uploadFile(
    localPath: string,
    key: string,
    metadata?: FileMetadata
  ): Promise<StoredFile> {
    await this.ensureDirs();

    const s3Key = key.startsWith("/") ? key.slice(1) : key;
    const fileContent = await fs.readFile(localPath);

    try {
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: s3Key,
        Body: fileContent,
        ContentType: metadata?.contentType || "application/octet-stream",
        Metadata: {
          "original-name": metadata?.originalName || path.basename(localPath),
        },
      });

      await this.s3Client.send(command);
      logger.info(`Uploaded file to S3: ${s3Key}`);

      return {
        key: s3Key,
        path: `s3://${this.bucketName}/${s3Key}`,
        metadata: {
          ...metadata,
        },
      };
    } catch (error) {
      logger.error(`Failed to upload to S3: ${error}`);
      throw error;
    }
  }

  async downloadFile(key: string, destPath: string): Promise<void> {
    const s3Key = key.startsWith("/") ? key.slice(1) : key;

    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: s3Key,
      });

      const response = await this.s3Client.send(command);
      const stream = response.Body as Readable;

      if (!stream) {
        throw new Error("Empty response body from S3");
      }

      const fileStream = await fs.open(destPath, "w");
      for await (const chunk of stream) {
        await fileStream.write(chunk);
      }
      await fileStream.close();

      logger.info(`Downloaded file from S3: ${s3Key} -> ${destPath}`);
    } catch (error) {
      logger.error(`Failed to download from S3: ${error}`);
      throw error;
    }
  }

  async getFileUrl(key: string, expiresIn: number = 3600): Promise<string> {
    const s3Key = key.startsWith("/") ? key.slice(1) : key;

    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: s3Key,
      });
      return await getSignedUrl(this.s3Client, command, { expiresIn });
    } catch (error) {
      logger.error(`Failed to get signed URL for S3: ${error}`);
      throw error;
    }
  }

  async getFilePath(key: string): Promise<string> {
    await this.ensureDirs();

    const s3Key = key.startsWith("/") ? key.slice(1) : key;
    const localPath = path.join(this.localCacheDir, s3Key);

    await fs.mkdir(path.dirname(localPath), { recursive: true });

    try {
      await fs.access(localPath);
      return localPath;
    } catch {
      await this.downloadFile(key, localPath);
      return localPath;
    }
  }

  async deleteFile(key: string): Promise<void> {
    const s3Key = key.startsWith("/") ? key.slice(1) : key;

    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: s3Key,
      });
      await this.s3Client.send(command);
      logger.info(`Deleted file from S3: ${s3Key}`);

      const localPath = path.join(this.localCacheDir, s3Key);
      try {
        await fs.unlink(localPath);
      } catch {
        // Ignore if not in cache
      }
    } catch (error: any) {
      logger.error(`Failed to delete from S3: ${error}`);
    }
  }

  async fileExists(key: string): Promise<boolean> {
    const s3Key = key.startsWith("/") ? key.slice(1) : key;

    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: s3Key,
      });
      await this.s3Client.send(command);
      return true;
    } catch {
      return false;
    }
  }

  async listFiles(prefix: string): Promise<string[]> {
    try {
      const command = new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: prefix,
      });
      const response = await this.s3Client.send(command);
      return response.Contents?.map(c => c.Key || "").filter(Boolean) || [];
    } catch {
      return [];
    }
  }

  getUploadsDir(): string {
    return path.join(this.localCacheDir, "uploads");
  }

  getOutputDir(): string {
    return path.join(this.localCacheDir, "output");
  }

  async clearCache(): Promise<number> {
    let cleared = 0;
    try {
      const cacheFiles = await fs.readdir(this.localCacheDir, { recursive: true });
      for (const file of cacheFiles) {
        const fullPath = path.join(this.localCacheDir, file.toString());
        try {
          const stat = await fs.stat(fullPath);
          if (stat.isFile()) {
            await fs.unlink(fullPath);
            cleared++;
          }
        } catch {
          // Ignore errors
        }
      }
    } catch {
      // Ignore errors
    }
    return cleared;
  }
}

// Unified file storage interface
export interface IFileStorage {
  uploadFile(localPath: string, key: string, metadata?: FileMetadata): Promise<StoredFile>;
  downloadFile(key: string, destPath: string): Promise<void>;
  getFileUrl(key: string, expiresIn?: number): Promise<string>;
  getFilePath(key: string): Promise<string>;
  deleteFile(key: string): Promise<void>;
  fileExists(key: string): Promise<boolean>;
  listFiles(prefix: string): Promise<string[]>;
  getUploadsDir(): string;
  getOutputDir(): string;
  ensureDirs(): Promise<void>;
}

// Create the appropriate storage instance based on config
function createFileStorage(): IFileStorage {
  const config = getConfig();

  if (config.type === "gcs") {
    if (!config.gcsBucket) {
      logger.warn("GCS_BUCKET_NAME not set, falling back to local storage");
      return new LocalFileStorage(config.localBasePath || os.tmpdir());
    }

    logger.info(`Using Google Cloud Storage: ${config.gcsBucket}`);
    return new GCSFileStorage(config.gcsBucket, config.gcsProjectId);
  }

  if (config.type === "s3") {
    if (!config.s3Bucket) {
      logger.warn("S3_BUCKET_NAME not set, falling back to local storage");
      return new LocalFileStorage(config.localBasePath || os.tmpdir());
    }

    logger.info(`Using AWS S3 Storage: ${config.s3Bucket}`);
    return new S3FileStorage(
      config.s3Bucket,
      config.s3Region || "us-east-1",
      config.awsAccessKeyId,
      config.awsSecretAccessKey
    );
  }

  logger.info(`Using local file storage: ${config.localBasePath}`);
  return new LocalFileStorage(config.localBasePath || os.tmpdir());
}

// Singleton instance
let fileStorageInstance: IFileStorage | null = null;

export function getFileStorage(): IFileStorage {
  if (!fileStorageInstance) {
    fileStorageInstance = createFileStorage();
  }
  return fileStorageInstance;
}

// Helper to generate unique file keys
export function generateFileKey(prefix: string, originalName: string): string {
  const ext = path.extname(originalName);
  const uniqueId = uuidv4();
  return `${prefix}/${uniqueId}${ext}`;
}

// Export for direct use
export const fileStorage = getFileStorage();
