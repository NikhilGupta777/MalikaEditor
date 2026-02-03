import { createLogger } from "./logger";

const retryLogger = createLogger("retry");

interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  retryableErrors?: (error: unknown) => boolean;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  retryableErrors: isRetryableError,
};

interface CircuitBreakerState {
  failures: number;
  lastFailure: number;
  isOpen: boolean;
}

const circuitBreakers = new Map<string, CircuitBreakerState>();

const CIRCUIT_BREAKER_CONFIG = {
  failureThreshold: 3, // Open circuit after 3 failures (lowered from 5 for faster rate limit response)
  resetTimeMs: 60000,
  halfOpenMaxRequests: 2,
};

export function getCircuitState(serviceName: string): CircuitBreakerState {
  if (!circuitBreakers.has(serviceName)) {
    circuitBreakers.set(serviceName, { failures: 0, lastFailure: 0, isOpen: false });
  }
  return circuitBreakers.get(serviceName)!;
}

export function recordSuccess(serviceName: string): void {
  const state = getCircuitState(serviceName);
  state.failures = 0;
  state.isOpen = false;
}

export function recordFailure(serviceName: string): void {
  const state = getCircuitState(serviceName);
  state.failures++;
  state.lastFailure = Date.now();

  if (state.failures >= CIRCUIT_BREAKER_CONFIG.failureThreshold) {
    state.isOpen = true;
    retryLogger.warn(`Circuit breaker OPEN for ${serviceName} after ${state.failures} failures`);
  }
}

export function isCircuitOpen(serviceName: string): boolean {
  const state = getCircuitState(serviceName);

  if (!state.isOpen) return false;

  const timeSinceLastFailure = Date.now() - state.lastFailure;
  if (timeSinceLastFailure >= CIRCUIT_BREAKER_CONFIG.resetTimeMs) {
    retryLogger.info(`Circuit breaker HALF-OPEN for ${serviceName} (reset timeout elapsed)`);
    state.isOpen = false;
    state.failures = Math.floor(CIRCUIT_BREAKER_CONFIG.failureThreshold / 2);
    return false;
  }

  return true;
}

export function resetCircuitBreaker(serviceName: string): void {
  circuitBreakers.delete(serviceName);
  retryLogger.info(`Circuit breaker reset for ${serviceName}`);
}

interface ErrorWithStatus extends Error {
  status?: number;
  statusCode?: number;
  code?: number | string;
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const errWithStatus = error as ErrorWithStatus;
    const status = errWithStatus.status || errWithStatus.statusCode || errWithStatus.code;

    if (typeof status === "number" && (status === 429 || status === 503 || status === 502 || status === 500)) {
      return true;
    }

    const message = error.message.toLowerCase();
    const statusMatch = message.match(/status[:\s]*(\d+)/);
    const parsedStatus = statusMatch ? parseInt(statusMatch[1]) : null;

    if (parsedStatus && (parsedStatus === 429 || parsedStatus === 503 || parsedStatus === 502 || parsedStatus === 500)) {
      return true;
    }

    const retryablePatterns = [
      "rate limit",
      "too many requests",
      "timeout",
      "timed out",
      "network error",
      "connection reset",
      "econnreset",
      "econnrefused",
      "socket hang up",
      "service unavailable",
      "temporarily unavailable",
      "overloaded",
      "capacity",
      "resource_exhausted",
      "deadline_exceeded",
    ];

    return retryablePatterns.some(pattern => message.includes(pattern));
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  options: RetryOptions = {},
  serviceName?: string
): Promise<T> {
  const config = { ...DEFAULT_OPTIONS, ...options };
  let lastError: unknown;
  let delay = config.initialDelayMs;

  const circuitName = serviceName || operationName.split(" ")[0];

  if (isCircuitOpen(circuitName)) {
    throw new Error(`Circuit breaker is open for ${circuitName} - service temporarily unavailable`);
  }

  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt++) {
    try {
      const result = await operation();
      if (serviceName) recordSuccess(circuitName);
      return result;
    } catch (error) {
      lastError = error;

      if (attempt > config.maxRetries || !config.retryableErrors(error)) {
        if (serviceName) recordFailure(circuitName);
        break;
      }

      const jitter = Math.random() * 0.2 * delay;
      const waitTime = Math.min(delay + jitter, config.maxDelayMs);

      retryLogger.warn(
        `${operationName} failed (attempt ${attempt}/${config.maxRetries + 1}), ` +
        `retrying in ${Math.round(waitTime)}ms: ${error instanceof Error ? error.message : String(error)}`
      );

      await sleep(waitTime);
      delay = Math.min(delay * config.backoffMultiplier, config.maxDelayMs);
    }
  }

  throw lastError;
}

export const AI_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};
