export const CLIENT_CONFIG = {
  sse: {
    maxReconnectAttempts: 5,
    baseReconnectDelayMs: 2000,
    reconnectBackoffMultiplier: 1.5,
  },
  
  review: {
    autoAcceptSeconds: 120,
    autosaveDebounceMs: 2000,
  },
  
  ui: {
    toastDurationMs: 5000,
    loadingTimeoutMs: 30000,
  },
} as const;

export type ClientConfig = typeof CLIENT_CONFIG;
