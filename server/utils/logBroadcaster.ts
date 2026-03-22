import type { Response } from "express";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  id: number;
  timestamp: string;
  level: LogLevel;
  context: string;
  message: string;
}

const RING_BUFFER_SIZE = 500;
let idCounter = 0;

const ringBuffer: LogEntry[] = [];
const clients = new Set<Response>();

export function broadcastLog(level: LogLevel, context: string, message: string): void {
  const entry: LogEntry = {
    id: ++idCounter,
    timestamp: new Date().toISOString(),
    level,
    context,
    message,
  };

  if (ringBuffer.length >= RING_BUFFER_SIZE) {
    ringBuffer.shift();
  }
  ringBuffer.push(entry);

  const data = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of clients) {
    try {
      res.write(data);
    } catch {
      clients.delete(res);
    }
  }
}

export function getRecentLogs(): LogEntry[] {
  return [...ringBuffer];
}

export function subscribeClient(res: Response): void {
  clients.add(res);
}

export function unsubscribeClient(res: Response): void {
  clients.delete(res);
}
