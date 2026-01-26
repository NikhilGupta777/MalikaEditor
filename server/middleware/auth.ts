import type { Request, Response, NextFunction } from "express";
import session from "express-session";
import bcrypt from "bcrypt";
import connectPgSimple from "connect-pg-simple";
import { pool } from "../db";
import { storage } from "../storage";
import type { User } from "@shared/schema";

declare module "express-session" {
  interface SessionData {
    userId: string;
  }
}

export interface AuthenticatedRequest extends Request {
  user?: User;
}

const SALT_ROUNDS = 10;

function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === "production" && !secret) {
    throw new Error("SESSION_SECRET environment variable is required in production");
  }
  return secret || "video-editor-dev-secret-change-in-production";
}

const SESSION_SECRET = getSessionSecret();

// Use PostgreSQL session store in production for scalability
const PgSession = connectPgSimple(session);
const isProduction = process.env.NODE_ENV === "production";

const sessionStore = isProduction 
  ? new PgSession({
      pool,
      tableName: "session",
      createTableIfMissing: true,
      errorLog: (err) => {
        console.error("[session-store] PostgreSQL session store error:", err);
      },
    })
  : undefined;

export const sessionMiddleware = session({
  store: sessionStore,
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProduction,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    // Use "none" in production for cross-site cookie support (Replit proxy/iframe)
    // Must be "none" when secure is true for modern browsers
    sameSite: isProduction ? "none" : "lax",
  },
});

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function requireAuth(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  // Authentication disabled - allow all requests
  next();
}

export async function optionalAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (req.session.userId) {
    const user = await storage.getUser(req.session.userId);
    if (user) {
      req.user = user;
    }
  }
  next();
}
