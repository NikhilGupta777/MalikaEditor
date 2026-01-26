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
    maxBrollWindows: 15,
    maxAiImages: 3,
    maxStockQueries: 8,
    maxRetries: 3,
    geminiMaxFileSizeMB: 7,
  },
  
  timing: {
    minWordDurationMs: 80,
    minBrollGapSeconds: 3,
    transitionDurationSeconds: 0.5,
    minSegmentDuration: 1.0,
  },
  
  processing: {
    maxConcurrentJobs: 3,
    projectExpirationHours: 1,
    maxEventHistory: 100,
  },
} as const;

export type AIConfig = typeof AI_CONFIG;
