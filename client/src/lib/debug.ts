/**
 * Debug logger for client-side code
 * Only logs in development mode or when DEBUG flag is set
 */

const isDevelopment = process.env.NODE_ENV === "development";
const debugEnabled = isDevelopment || (typeof window !== "undefined" && (window as any).__DEBUG__);

export function debugLog(context: string, message: string, ...args: unknown[]): void {
  if (debugEnabled) {
    console.log(`[${context}] ${message}`, ...args);
  }
}

export function debugWarn(context: string, message: string, ...args: unknown[]): void {
  if (debugEnabled) {
    console.warn(`[${context}] ${message}`, ...args);
  }
}

export function debugError(context: string, message: string, ...args: unknown[]): void {
  // Errors are always logged
  console.error(`[${context}] ${message}`, ...args);
}
