import { createWriteStream } from "fs";

// Optional: Tee logs to file when LOG_FILE is set (helps debug crashes)
const LOG_FILE = process.env.LOG_FILE;
let logFileStream: ReturnType<typeof createWriteStream> | null = null;
if (LOG_FILE) {
  try {
    logFileStream = createWriteStream(LOG_FILE, { flags: "a" });
    const orig = { log: console.log, error: console.error, warn: console.warn, debug: console.debug };
    const tee = (fn: typeof console.log) => (...args: unknown[]) => {
      fn(...args);
      try {
        logFileStream?.write(args.map(a => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ") + "\n");
      } catch {}
    };
    console.log = tee(orig.log);
    console.error = tee(orig.error);
    console.warn = tee(orig.warn);
    console.debug = tee(orig.debug);
    process.on("uncaughtException", (err: Error) => {
      logFileStream?.write(`\n[CRASH] uncaughtException: ${err?.message}\n${err?.stack || ""}\n`);
    });
    process.on("unhandledRejection", (reason: unknown) => {
      logFileStream?.write(`\n[CRASH] unhandledRejection: ${String(reason)}\n`);
    });
  } catch {}
}

import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { sessionMiddleware, hashPassword } from "./middleware/auth";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import { createLogger } from "./utils/logger";
import { cleanupStaleTempFiles } from "./services/videoProcessor";
import { recoverInterruptedJobs } from "./services/backgroundProcessor";
import { logTranscriptionConfig } from "./services/aiService";
import { storage } from "./storage";
import { AI_CONFIG } from "./config/ai";
import { validateEnvAtStartup } from "./config/env";
import { requestIdMiddleware } from "./middleware/requestId";

const expressLogger = createLogger("express");

// Cleanup expired projects and cache using centralized config
const CLEANUP_INTERVAL = AI_CONFIG.processing.cleanupIntervalMs;
let cleanupIntervalId: NodeJS.Timeout | null = null;

async function runPeriodicCleanup() {
  try {
    const deletedProjects = await storage.cleanupExpiredProjects();
    const deletedCache = await storage.cleanupExpiredCache();
    if (deletedProjects > 0 || deletedCache > 0) {
      expressLogger.info(
        `Periodic cleanup: ${deletedProjects} expired projects, ${deletedCache} expired cache entries`,
      );
    }
  } catch (e) {
    expressLogger.warn("Periodic cleanup failed:", e);
  }
}

function startCleanupJob() {
  if (cleanupIntervalId) return;
  cleanupIntervalId = setInterval(runPeriodicCleanup, CLEANUP_INTERVAL);
  expressLogger.info("Started periodic cleanup job (every 10 minutes)");
}

const app = express();
const httpServer = createServer(app);

// Configure server timeouts for long-running SSE connections (10 minutes for renders)
httpServer.timeout = 10 * 60 * 1000; // 10 minutes
httpServer.keepAliveTimeout = 10 * 60 * 1000; // 10 minutes
httpServer.headersTimeout = 10 * 60 * 1000 + 1000; // Slightly longer than keepAliveTimeout

// ==========================================
// HEALTH CHECK ENDPOINTS - MUST BE FIRST
// These endpoints respond immediately before any middleware
// to ensure fast health check responses for deployment
// ==========================================
app.get("/health", (_req, res) => {
  res.status(200).send("OK");
});

app.get("/healthz", (_req, res) => {
  res.status(200).send("OK");
});

// Readiness check - verifies DB connectivity
// Load balancers should use this endpoint for readiness probes
app.get("/ready", async (_req, res) => {
  try {
    // Check database connectivity with a simple query
    const { pool } = await import("./db");
    await pool.query("SELECT 1");
    res.status(200).json({ status: "ready", db: "connected" });
  } catch (error) {
    expressLogger.error("Readiness check failed:", error);
    res.status(503).json({ status: "not ready", db: "disconnected" });
  }
});

// Root health check - responds immediately for deployment health checks
// Always return 200 for root to pass Cloud Run health checks
app.get("/", (req, res, next) => {
  // Check for health check indicators
  const isHealthCheck = 
    req.query.health === "1" ||
    req.headers["x-health-check"] === "true" ||
    (req.headers["user-agent"] || "").includes("GoogleHC") ||
    (req.headers["user-agent"] || "").includes("kube-probe");
  
  // In production, always respond quickly for root GET requests that look like health checks
  // or if there's no accept header for text/html (likely a health check, not a browser)
  const acceptsHtml = (req.headers.accept || "").includes("text/html");
  
  if (isHealthCheck || (process.env.NODE_ENV === "production" && !acceptsHtml)) {
    return res.status(200).send("OK");
  }
  
  // Otherwise, let it fall through to static file serving
  next();
});

// Trust proxy for production (Replit deployments)
// This is required for secure cookies to work behind Replit's load balancer
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// CORS configuration
const allowedOrigins = [
  // Development origins
  "http://localhost:5000",
  "http://localhost:3000",
  "http://127.0.0.1:5000",
  // Replit preview domains
  /\.replit\.dev$/,
  /\.repl\.co$/,
  /\.replit\.app$/,
];

const isProduction = process.env.NODE_ENV === "production";

app.use(
  cors({
    origin: (origin, callback) => {
      // In production, require a valid origin from the allowed list
      // In development, allow requests with no origin (like curl, mobile apps)
      if (!origin) {
        if (isProduction) {
          // In production, only allow no-origin for specific cases (e.g., same-origin requests)
          // Same-origin requests don't have an Origin header
          return callback(null, true);
        }
        return callback(null, true);
      }

      // Check if origin is in allowed list (string or regex)
      const isAllowed = allowedOrigins.some((allowed) => {
        if (typeof allowed === "string") {
          return origin === allowed;
        }
        return allowed.test(origin);
      });

      if (isAllowed) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Idempotency-Key", "X-Request-Id"],
  }),
);

// Security headers with helmet
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        imgSrc: ["'self'", "data:", "blob:", "https:", "http:"],
        mediaSrc: ["'self'", "data:", "blob:", "https:", "http:"],
        connectSrc: ["'self'", "wss:", "ws:", "https:", "http:"],
        frameSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: [],
      },
    },
    crossOriginEmbedderPolicy: false, // Required for loading cross-origin resources
    crossOriginResourcePolicy: { policy: "cross-origin" },
    xFrameOptions: { action: "sameorigin" },
    xContentTypeOptions: true,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    hsts: {
      maxAge: 31536000, // 1 year
      includeSubDomains: true,
      preload: true,
    },
  }),
);

// Request ID middleware for log correlation
app.use(requestIdMiddleware);

// Response compression for JSON and static assets
// Reduces bandwidth and improves latency for large payloads
app.use(compression({
  // Only compress responses larger than 1KB
  threshold: 1024,
  // Filter: compress text-based responses and JSON
  filter: (req, res) => {
    // Skip compression for SSE connections
    if (req.headers.accept === 'text/event-stream') {
      return false;
    }
    return compression.filter(req, res);
  },
}));

app.use(
  express.json({
    limit: "20mb", // Reduced from 70mb - most API payloads should be under this; specific routes can override if needed
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false, limit: "20mb" })); // Reduced from 1gb

// Session middleware - skip for health check routes to avoid DB dependency
app.use((req, res, next) => {
  // Skip session for health check endpoints
  if (req.path === "/health" || req.path === "/healthz") {
    return next();
  }
  return sessionMiddleware(req, res, next);
});

export function log(message: string, source = "express") {
  const sourceLogger = createLogger(source);
  sourceLogger.info(message);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        // Truncate large responses to avoid log spam (transcripts, etc.)
        const jsonStr = JSON.stringify(capturedJsonResponse);
        if (jsonStr.length > 500) {
          logLine += ` :: [Response truncated: ${jsonStr.length} chars]`;
        } else {
          logLine += ` :: ${jsonStr}`;
        }
      }

      log(logLine);
    }
  });

  next();
});

// Deferred startup tasks - run after server is ready
async function runStartupTasks() {
  // Validate environment variables (non-strict mode - logs warnings, doesn't fail)
  validateEnvAtStartup(false);
  
  // Clean up stale temp files from previous runs (files older than 2 hours)
  try {
    const cleanup = await cleanupStaleTempFiles(2);
    if (cleanup.cleaned > 0) {
      log(`Startup cleanup: removed ${cleanup.cleaned} stale temp files`);
    }
  } catch (e) {
    expressLogger.warn("Failed to clean up stale temp files on startup:", e);
  }

  // Log transcription system configuration at startup
  logTranscriptionConfig();

  // Recover any interrupted processing jobs - they will continue from their current state
  try {
    await recoverInterruptedJobs();
  } catch (e) {
    expressLogger.warn("Failed to recover interrupted jobs on startup:", e);
  }

  // Create default admin user from environment variables if not exists
  try {
    const defaultUsername = process.env.DEFAULT_ADMIN_USERNAME;
    const defaultPassword = process.env.DEFAULT_ADMIN_PASSWORD;

    if (defaultUsername && defaultPassword) {
      // Validate password strength in production
      const MIN_PASSWORD_LENGTH = 12;
      if (isProduction && defaultPassword.length < MIN_PASSWORD_LENGTH) {
        expressLogger.warn(
          `DEFAULT_ADMIN_PASSWORD is too weak (min ${MIN_PASSWORD_LENGTH} chars). Admin user not created.`
        );
      } else {
        const existingUser = await storage.getUserByUsername(defaultUsername);
        if (!existingUser) {
          const hashedPassword = await hashPassword(defaultPassword);
          await storage.createUser({
            username: defaultUsername,
            password: hashedPassword,
          });
          // Never log the password itself
          log(
            `Admin user '${defaultUsername}' created from environment variables`,
          );
        } else {
          log(`Admin user '${defaultUsername}' already exists`);
        }
      }
    } else {
      log(
        "No default admin credentials configured. Set DEFAULT_ADMIN_USERNAME and DEFAULT_ADMIN_PASSWORD environment variables to create an admin user on startup.",
      );
    }
  } catch (e) {
    expressLogger.warn("Failed to create admin user:", e);
  }
}

(async () => {
  await registerRoutes(httpServer, app);

  app.use(
    (
      err: Error & { status?: number; statusCode?: number },
      _req: Request,
      res: Response,
      next: NextFunction,
    ) => {
      const status = err.status || err.statusCode || 500;
      const message = err.message || "Internal Server Error";

      expressLogger.error("Internal Server Error:", err);

      if (res.headersSent) {
        return next(err);
      }

      return res.status(status).json({ message });
    },
  );

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  const host = process.env.HOST || (process.platform === "win32" ? "127.0.0.1" : "0.0.0.0");
  const listenOptions: { port: number; host: string; reusePort?: boolean } = { port, host };
  if (process.platform !== "win32") {
    listenOptions.reusePort = true;
  }
  httpServer.listen(
    listenOptions,
    () => {
      log(`serving on port ${port}`);
      // Defer startup tasks to run after server is ready
      // This ensures health checks pass immediately
      setImmediate(async () => {
        await runStartupTasks();
        startCleanupJob();
        runPeriodicCleanup();
      });
    },
  );

  // Graceful shutdown handler - cleanup temp files and resources
  const gracefulShutdown = async (signal: string) => {
    expressLogger.info(`Received ${signal}, starting graceful shutdown...`);
    
    // Stop accepting new connections
    httpServer.close(async () => {
      expressLogger.info("HTTP server closed");
      
      // Clean up temp files
      try {
        const { cleaned, errors } = await cleanupStaleTempFiles(0); // 0 = cleanup all temp files
        expressLogger.info(`Shutdown cleanup: ${cleaned} temp files cleaned${errors > 0 ? `, ${errors} errors` : ""}`);
      } catch (error) {
        expressLogger.warn("Failed to cleanup temp files during shutdown:", error);
      }
      
      // Stop cleanup interval
      if (cleanupIntervalId) {
        clearInterval(cleanupIntervalId);
        cleanupIntervalId = null;
      }
      
      expressLogger.info("Graceful shutdown complete");
      process.exit(0);
    });
    
    // Force exit after 30 seconds if graceful shutdown takes too long
    setTimeout(() => {
      expressLogger.warn("Graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, 30000);
  };
  
  // Register shutdown handlers
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
})();
