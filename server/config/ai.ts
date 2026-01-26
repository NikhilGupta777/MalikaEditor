export const AI_CONFIG = {
  models: {
    transcription: {
      primary: "gpt-4o-mini-transcribe",
      fallback: "gemini-2.5-flash",
    },
    analysis: "gemini-2.5-flash",
    editPlanning: "gemini-2.5-flash",
    imageGeneration: "gemini-2.5-flash-image",
    mediaSelection: "gemini-2.5-flash",
    reviewPass: "gemini-1.5-flash",
  },
  
  limits: {
    maxConcurrentImageGeneration: 3,
    maxBrollWindows: 20,
    maxAiImages: 10,
    maxStockQueries: 15,
    maxRetries: 3,
    geminiMaxFileSizeMB: 7,
  },
  
  timing: {
    minWordDurationMs: 80,
    minBrollGapSeconds: 3,
    transitionDurationSeconds: 0.5,
    minSegmentDuration: 1.0,
    secondsPerBrollWindow: 15,
  },
  
  processing: {
    maxConcurrentJobs: 3,
    projectExpirationHours: 1,
    maxEventHistory: 100,
  },
} as const;

export type AIConfig = typeof AI_CONFIG;

export function calculateDynamicLimits(videoDurationSeconds: number): {
  aiImages: number;
  stockQueries: number;
  brollWindows: number;
} {
  const secondsPerBroll = AI_CONFIG.timing.secondsPerBrollWindow;
  const baseBrollWindows = Math.max(1, Math.floor(videoDurationSeconds / secondsPerBroll));
  
  return {
    aiImages: Math.min(baseBrollWindows, AI_CONFIG.limits.maxAiImages),
    stockQueries: Math.min(baseBrollWindows + 2, AI_CONFIG.limits.maxStockQueries),
    brollWindows: Math.min(baseBrollWindows + 3, AI_CONFIG.limits.maxBrollWindows),
  };
}
