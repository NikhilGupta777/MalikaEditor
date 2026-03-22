/**
 * Environment variable validation
 * 
 * Validates required environment variables at startup and logs warnings
 * for optional but recommended variables.
 */
import { createLogger } from "../utils/logger";

const logger = createLogger("env-validation");

interface EnvVar {
  name: string;
  required: boolean;
  description: string;
  // Optional validator function
  validate?: (value: string) => boolean;
}

// Define all env vars used by the application
const envVars: EnvVar[] = [
  // Database
  { name: "DATABASE_URL", required: true, description: "PostgreSQL connection string" },

  // Session and auth
  { name: "SESSION_SECRET", required: process.env.NODE_ENV === "production", description: "Session encryption secret (required in production)" },
  { name: "DEFAULT_ADMIN_USERNAME", required: false, description: "Default admin username for first-run setup" },
  { name: "DEFAULT_ADMIN_PASSWORD", required: false, description: "Default admin password (min 12 chars in production)" },

  // AI Services
  { name: "ASSEMBLYAI_API_KEY", required: false, description: "AssemblyAI API key for transcription" },
  { name: "GEMINI_API_KEY", required: false, description: "Google Gemini API key for AI features" },
  { name: "OPENAI_API_KEY", required: false, description: "OpenAI API key for AI features" },

  // Media services
  { name: "PEXELS_API_KEY", required: false, description: "Pexels API key for stock media" },
  { name: "FREEPIK_API_KEY", required: false, description: "Freepik API key for stock media" },

  // Server config
  { name: "PORT", required: false, description: "Server port (defaults to 5000)" },
  { name: "NODE_ENV", required: false, description: "Environment: development or production" },
  { name: "LOG_FILE", required: false, description: "Optional file path to tee logs (helps debug crashes)" },
  { name: "LOG_LEVEL", required: false, description: "Log level: debug, info, warn, error (default: info)" },
  { name: "MAX_VIDEO_DURATION_SECONDS", required: false, description: "Max upload video duration in seconds (default: 1800)" },
  { name: "SELF_REVIEW_MAX_VIDEO_MB", required: false, description: "Max video size (MB) for AI self-review (default 50, max 200)" },

  // File storage
  { name: "FILE_STORAGE_TYPE", required: false, description: "File storage type: 'local' or 's3' (default: local)" },
  { name: "S3_BUCKET_NAME", required: process.env.FILE_STORAGE_TYPE === "s3", description: "S3 bucket name (required when FILE_STORAGE_TYPE=s3)" },
  { name: "S3_REGION", required: process.env.FILE_STORAGE_TYPE === "s3", description: "S3 region (required when FILE_STORAGE_TYPE=s3)" },
  { name: "AWS_ACCESS_KEY_ID", required: process.env.FILE_STORAGE_TYPE === "s3", description: "AWS Access Key ID (required when FILE_STORAGE_TYPE=s3)" },
  { name: "AWS_SECRET_ACCESS_KEY", required: process.env.FILE_STORAGE_TYPE === "s3", description: "AWS Secret Access Key (required when FILE_STORAGE_TYPE=s3)" },
  { name: "UPLOADS_PATH", required: false, description: "Local uploads directory path (default: system temp)" },
];

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate environment variables at startup.
 * Returns validation result with errors and warnings.
 */
export function validateEnv(): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const envVar of envVars) {
    const value = process.env[envVar.name];

    if (!value) {
      if (envVar.required) {
        errors.push(`Missing required env var: ${envVar.name} - ${envVar.description}`);
      } else if (envVar.name.includes("API_KEY")) {
        // Warn about missing API keys as features may not work
        warnings.push(`Missing optional env var: ${envVar.name} - ${envVar.description}. Some features may be unavailable.`);
      }
      continue;
    }

    // Run custom validator if provided
    if (envVar.validate && !envVar.validate(value)) {
      errors.push(`Invalid value for ${envVar.name}: validation failed`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Run env validation and log results.
 * In strict mode, throws error if validation fails.
 */
export function validateEnvAtStartup(strict = false): void {
  const result = validateEnv();

  // Log warnings
  for (const warning of result.warnings) {
    logger.warn(warning);
  }

  // Log errors
  for (const error of result.errors) {
    logger.error(error);
  }

  // In strict mode, fail startup on errors
  if (strict && !result.valid) {
    throw new Error(`Environment validation failed: ${result.errors.join("; ")}`);
  }

  if (result.valid && result.warnings.length === 0) {
    logger.info("Environment validation passed");
  } else if (result.valid) {
    logger.info(`Environment validation passed with ${result.warnings.length} warnings`);
  }
}
