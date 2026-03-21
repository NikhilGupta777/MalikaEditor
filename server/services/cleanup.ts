import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { createLogger } from "../utils/logger";
import { storage } from "../storage";
import { fileStorage } from "./fileStorage";
import { STOCK_DIR, FRAMES_DIR, AUDIO_DIR, CHAPTERS_DIR } from "../config/paths";

const logger = createLogger("cleanup");

/**
 * Delete all files associated with a project from S3 and local temp dirs.
 * Safe to call multiple times — skips if already deleted.
 * Also safe if files don't exist — all errors are caught individually.
 */
export async function deleteProjectFiles(id: number): Promise<void> {
  const proj = await storage.getVideoProject(id);
  if (!proj || proj.sourceFilesDeletedAt) return;

  let deleted = 0;

  // Original upload
  if (proj.originalPath) {
    const key = `uploads/${path.basename(proj.originalPath)}`;
    try { await fileStorage.deleteFile(key); deleted++; logger.info(`[Cleanup] Deleted upload: ${key}`); }
    catch (e: any) { logger.warn(`[Cleanup] Could not delete upload ${key}: ${e.message}`); }
  }

  // Rendered output
  if (proj.outputPath) {
    const key = `output/${path.basename(proj.outputPath)}`;
    try { await fileStorage.deleteFile(key); deleted++; logger.info(`[Cleanup] Deleted output: ${key}`); }
    catch (e: any) { logger.warn(`[Cleanup] Could not delete output ${key}: ${e.message}`); }
  }

  // Stock / AI-generated B-roll images (S3 key prefix: stock/, also wipe local temp)
  try {
    const stockFiles = await fs.readdir(STOCK_DIR);
    for (const f of stockFiles) {
      try { await fileStorage.deleteFile(`stock/${f}`); deleted++; } catch { }
      await fs.unlink(path.join(STOCK_DIR, f)).catch(() => {});
    }
  } catch { }

  // Temp working dirs: frames (has subdirs), audio, chapters
  for (const tempDir of [FRAMES_DIR, AUDIO_DIR, CHAPTERS_DIR]) {
    try {
      const entries = await fs.readdir(tempDir);
      for (const entry of entries) {
        try { await fs.rm(path.join(tempDir, entry), { recursive: true, force: true }); deleted++; } catch { }
      }
    } catch { }
  }

  // S3 local cache entries for this project
  const s3CacheDir = path.join(os.tmpdir(), "malika_s3_cache");
  const cachePaths = [
    proj.originalPath && path.join(s3CacheDir, "uploads", path.basename(proj.originalPath)),
    proj.outputPath && path.join(s3CacheDir, "output", path.basename(proj.outputPath)),
  ].filter(Boolean) as string[];
  for (const cachePath of cachePaths) {
    try { await fs.unlink(cachePath); deleted++; } catch { }
  }

  await storage.markSourceFilesDeleted(id);
  logger.info(`[Cleanup] Done — deleted ${deleted} files for project ${id}`);
}

/**
 * Reschedule deletion timers for any projects that were reviewed but not yet
 * cleaned up (e.g. because the server restarted during the countdown).
 * Call once at startup.
 */
export async function resumePendingDeletions(): Promise<void> {
  try {
    const DELAY_MS = 10 * 60 * 1000;
    const { pool } = await import("../db");
    const result = await pool.query(
      `SELECT id, reviewed_at FROM video_projects
       WHERE reviewed_at IS NOT NULL AND source_files_deleted_at IS NULL`
    );
    for (const row of result.rows) {
      const reviewedAt = new Date(row.reviewed_at).getTime();
      const elapsed = Date.now() - reviewedAt;
      const remaining = Math.max(0, DELAY_MS - elapsed);
      logger.info(`[Cleanup] Re-scheduling deletion for project ${row.id} in ${Math.round(remaining / 1000)}s`);
      setTimeout(() => deleteProjectFiles(row.id).catch(e =>
        logger.error(`[Cleanup] Scheduled deletion failed for project ${row.id}:`, e)
      ), remaining);
    }
  } catch (e) {
    logger.warn("[Cleanup] Could not recover pending deletions on startup:", e);
  }
}

/**
 * Clean up all files for every expired project, then remove their DB records.
 * Called by the periodic cleanup job in index.ts.
 */
export async function cleanupExpiredProjectFiles(): Promise<number> {
  try {
    const { pool } = await import("../db");
    const result = await pool.query(
      `SELECT id FROM video_projects WHERE expires_at < CURRENT_TIMESTAMP`
    );
    let count = 0;
    for (const row of result.rows) {
      try {
        await deleteProjectFiles(row.id);
      } catch (e) {
        logger.warn(`[Cleanup] File cleanup failed for expired project ${row.id}:`, e);
      }
      count++;
    }
    return count;
  } catch (e) {
    logger.warn("[Cleanup] Could not query expired projects:", e);
    return 0;
  }
}
