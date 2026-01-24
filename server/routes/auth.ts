import type { Express, Response } from "express";
import { z } from "zod";
import { storage } from "../storage";
import {
  hashPassword,
  verifyPassword,
  requireAuth,
  type AuthenticatedRequest,
} from "../middleware/auth";

const authSchema = z.object({
  username: z.string().min(3, "Username must be at least 3 characters"),
  password: z.string().min(6, "Password must be at least 6 characters"),
});

export function registerAuthRoutes(app: Express): void {
  app.post("/api/auth/register", async (req: AuthenticatedRequest, res: Response) => {
    try {
      const parsed = authSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ 
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors 
        });
      }

      const { username, password } = parsed.data;

      const existingUser = await storage.getUserByUsername(username);
      if (existingUser) {
        return res.status(409).json({ error: "Username already exists" });
      }

      const hashedPassword = await hashPassword(password);
      const user = await storage.createUser({
        username,
        password: hashedPassword,
      });

      req.session.userId = user.id;

      res.status(201).json({
        id: user.id,
        username: user.username,
      });
    } catch (error) {
      console.error("Registration error:", error);
      res.status(500).json({ error: "Registration failed" });
    }
  });

  app.post("/api/auth/login", async (req: AuthenticatedRequest, res: Response) => {
    try {
      const parsed = authSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ 
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors 
        });
      }

      const { username, password } = parsed.data;

      const user = await storage.getUserByUsername(username);
      if (!user) {
        return res.status(401).json({ error: "Invalid username or password" });
      }

      const isValid = await verifyPassword(password, user.password);
      if (!isValid) {
        return res.status(401).json({ error: "Invalid username or password" });
      }

      req.session.userId = user.id;

      res.json({
        id: user.id,
        username: user.username,
      });
    } catch (error) {
      console.error("Login error:", error);
      res.status(500).json({ error: "Login failed" });
    }
  });

  app.post("/api/auth/logout", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    req.session.destroy((err) => {
      if (err) {
        console.error("Logout error:", err);
        return res.status(500).json({ error: "Logout failed" });
      }
      res.clearCookie("connect.sid");
      res.json({ message: "Logged out successfully" });
    });
  });

  app.get("/api/auth/me", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    res.json({
      id: req.user.id,
      username: req.user.username,
    });
  });

  app.get("/api/auth/status", async (req: AuthenticatedRequest, res: Response) => {
    if (req.session.userId) {
      const user = await storage.getUser(req.session.userId);
      if (user) {
        return res.json({
          authenticated: true,
          user: {
            id: user.id,
            username: user.username,
          },
        });
      }
    }
    res.json({ authenticated: false });
  });
}
