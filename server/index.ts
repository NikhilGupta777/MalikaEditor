import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { sessionMiddleware, hashPassword } from "./middleware/auth";
import cors from "cors";
import helmet from "helmet";
import { createLogger } from "./utils/logger";
import { cleanupStaleTempFiles } from "./services/videoProcessor";
import { recoverInterruptedJobs } from "./services/backgroundProcessor";
import { logTranscriptionConfig } from "./services/aiService";
import { storage } from "./storage";
import { AI_CONFIG } from "./config/ai";

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

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps or curl requests)
      if (!origin) {
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
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
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

app.use(
  express.json({
    limit: "70mb", // ✅ FIX for 413 error
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false, limit: "1gb" }));

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
      const existingUser = await storage.getUserByUsername(defaultUsername);
      if (!existingUser) {
        const hashedPassword = await hashPassword(defaultPassword);
        await storage.createUser({
          username: defaultUsername,
          password: hashedPassword,
        });
        log(
          `Admin user '${defaultUsername}' created from environment variables`,
        );
      } else {
        log(`Admin user '${defaultUsername}' already exists`);
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
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
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
})();
