/**
 * Centralized path configuration
 * 
 * All temporary and upload/output directory paths should be imported from here
 * to ensure consistency across the application.
 */
import os from "os";
import path from "path";

// Base temp directory - uses UPLOADS_PATH env var if set, otherwise system temp
const TEMP_DIR = process.env.UPLOADS_PATH || os.tmpdir();

// Upload and output directories
export const UPLOADS_DIR = path.join(TEMP_DIR, "malika_uploads");
export const OUTPUT_DIR = path.join(TEMP_DIR, "malika_output");

// Processing-specific directories
export const FRAMES_DIR = path.join(TEMP_DIR, "malika_frames");
export const AUDIO_DIR = path.join(TEMP_DIR, "malika_audio");
export const STOCK_DIR = path.join(TEMP_DIR, "malika_stock");
export const CHAPTERS_DIR = path.join(TEMP_DIR, "malika_chapters");

// All temp directories that should be cleaned up
export const ALL_TEMP_DIRS = [
  UPLOADS_DIR,
  OUTPUT_DIR,
  FRAMES_DIR,
  AUDIO_DIR,
  STOCK_DIR,
  CHAPTERS_DIR,
];

// Export TEMP_DIR for any code that needs direct access
export { TEMP_DIR };
