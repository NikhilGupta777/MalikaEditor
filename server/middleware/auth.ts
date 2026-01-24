import type { Request, Response, NextFunction } from "express";
import session from "express-session";
import bcrypt from "bcrypt";
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
const SESSION_SECRET = process.env.SESSION_SECRET || "video-editor-secret-key-change-in-production";

export const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: "lax",
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
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.session.userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const user = await storage.getUser(req.session.userId);
  if (!user) {
    req.session.destroy(() => {});
    res.status(401).json({ error: "Session expired" });
    return;
  }

  req.user = user;
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
