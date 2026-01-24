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

function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const errAny = error as any;
    const status = errAny.status || errAny.statusCode || errAny.code;
    
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
  options: RetryOptions = {}
): Promise<T> {
  const config = { ...DEFAULT_OPTIONS, ...options };
  let lastError: unknown;
  let delay = config.initialDelayMs;
  
  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      
      if (attempt > config.maxRetries || !config.retryableErrors(error)) {
        break;
      }
      
      const jitter = Math.random() * 0.2 * delay;
      const waitTime = Math.min(delay + jitter, config.maxDelayMs);
      
      console.warn(
        `[Retry] ${operationName} failed (attempt ${attempt}/${config.maxRetries + 1}), ` +
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
