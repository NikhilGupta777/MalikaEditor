import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

// Extend Express Request to include requestId
declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

/**
 * Middleware to add a unique request ID to each request.
 * Uses existing X-Request-Id header if provided, otherwise generates a new UUID.
 * The request ID is useful for correlating logs across the request lifecycle.
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Use existing request ID from header if provided (e.g., from load balancer)
  // Otherwise generate a new UUID
  const requestId = (req.headers["x-request-id"] as string) || randomUUID();
  
  // Attach to request object for use in handlers and logging
  req.requestId = requestId;
  
  // Include in response headers for client-side correlation
  res.setHeader("X-Request-Id", requestId);
  
  next();
}

/**
 * Helper to get request ID from request object for logging.
 * Returns empty string if not available (e.g., outside request context).
 */
export function getRequestId(req: Request | undefined): string {
  return req?.requestId || "";
}
