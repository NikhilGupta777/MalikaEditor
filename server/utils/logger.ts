import { broadcastLog } from "./logBroadcaster";

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getConfiguredLogLevel(): LogLevel {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase();
  if (envLevel && envLevel in LOG_LEVELS) {
    return envLevel as LogLevel;
  }
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

class Logger {
  private context: string;
  private static currentLevel: LogLevel = getConfiguredLogLevel();

  constructor(context: string = "app") {
    this.context = context;
  }

  private getTimestamp(): string {
    return new Date().toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[Logger.currentLevel];
  }

  private formatMessage(level: LogLevel, message: string): string {
    const timestamp = this.getTimestamp();
    return `${timestamp} [${level.toUpperCase()}] [${this.context}] ${message}`;
  }

  private emit(level: LogLevel, message: string, args: unknown[]): void {
    const extra = args.length
      ? " " + args.map(a => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")
      : "";
    broadcastLog(level, this.context, message + extra);
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.shouldLog("debug")) {
      console.debug(this.formatMessage("debug", message), ...args);
      this.emit("debug", message, args);
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (this.shouldLog("info")) {
      console.log(this.formatMessage("info", message), ...args);
      this.emit("info", message, args);
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (this.shouldLog("warn")) {
      console.warn(this.formatMessage("warn", message), ...args);
      this.emit("warn", message, args);
    }
  }

  error(message: string, ...args: unknown[]): void {
    if (this.shouldLog("error")) {
      console.error(this.formatMessage("error", message), ...args);
      this.emit("error", message, args);
    }
  }

  child(context: string): Logger {
    return new Logger(`${this.context}:${context}`);
  }

  static setLevel(level: LogLevel): void {
    Logger.currentLevel = level;
  }

  static getLevel(): LogLevel {
    return Logger.currentLevel;
  }
}

export const logger = new Logger("server");

export function createLogger(context: string): Logger {
  return new Logger(context);
}

export { Logger, LogLevel };
