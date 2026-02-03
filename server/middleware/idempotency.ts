import type { Request, Response, NextFunction } from "express";
import { createLogger } from "../utils/logger";

const logger = createLogger("idempotency");

// In-memory store for idempotency keys (should use Redis for multi-instance)
interface IdempotencyEntry {
  response: { statusCode: number; body: unknown };
  timestamp: number;
}

const idempotencyStore = new Map<string, IdempotencyEntry>();

// TTL for idempotency keys (24 hours)
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

// Cleanup interval (every hour)
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

// Periodic cleanup of expired entries
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  // Use Array.from for compatibility with TypeScript target
  const entries = Array.from(idempotencyStore.entries());
  for (let i = 0; i < entries.length; i++) {
    const [key, entry] = entries[i];
    if (now - entry.timestamp > IDEMPOTENCY_TTL_MS) {
      idempotencyStore.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    logger.debug(`Cleaned up ${cleaned} expired idempotency keys`);
  }
}, CLEANUP_INTERVAL_MS);

/**
 * Middleware to handle idempotent requests.
 * If a request with the same Idempotency-Key has been processed before (within TTL),
 * returns the cached response instead of processing again.
 * 
 * Usage: Apply to POST/PUT/PATCH routes where duplicate requests should return the same result.
 */
export function idempotencyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const idempotencyKey = req.headers["idempotency-key"] as string | undefined;
  
  // If no idempotency key provided, proceed normally
  if (!idempotencyKey) {
    return next();
  }
  
  // Validate key format (should be a UUID or similar)
  if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    res.status(400).json({ error: "Invalid Idempotency-Key format" });
    return;
  }
  
  // Create a composite key including the route and method
  const compositeKey = `${req.method}:${req.path}:${idempotencyKey}`;
  
  // Check if we have a cached response
  const cached = idempotencyStore.get(compositeKey);
  if (cached) {
    // Check if within TTL
    if (Date.now() - cached.timestamp < IDEMPOTENCY_TTL_MS) {
      logger.debug(`Returning cached response for idempotency key: ${idempotencyKey}`);
      res.status(cached.response.statusCode).json(cached.response.body);
      return;
    }
    // Expired - remove and process new request
    idempotencyStore.delete(compositeKey);
  }
  
  // Override res.json to capture the response
  const originalJson = res.json.bind(res);
  res.json = function(body: unknown) {
    // Store the response for future replays
    idempotencyStore.set(compositeKey, {
      response: { statusCode: res.statusCode, body },
      timestamp: Date.now(),
    });
    logger.debug(`Stored response for idempotency key: ${idempotencyKey}`);
    return originalJson(body);
  };
  
  next();
}

/**
 * Check if a project already has an active job.
 * This provides additional deduplication beyond idempotency keys.
 */
export function checkDuplicateJob(
  isJobActive: (projectId: number) => boolean
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const idParam = req.params.id;
    const projectId = parseInt(Array.isArray(idParam) ? idParam[0] : idParam, 10);
    
    if (isNaN(projectId)) {
      return next();
    }
    
    if (isJobActive(projectId)) {
      res.status(409).json({ 
        error: "A job is already active for this project",
        message: "Please wait for the current job to complete or use reconnect=true to subscribe to the existing job"
      });
      return;
    }
    
    next();
  };
}
