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
  
  // AI decides overlay counts based on content analysis - no arbitrary limits
  // Only concurrency and operational limits remain
  limits: {
    maxConcurrentImageGeneration: 3, // Prevent API rate limiting
    maxRetries: 3,
    geminiMaxFileSizeMB: 7,
    // DEPRECATED: AI now decides counts freely based on content
    // maxBrollWindows: removed - AI decides
    // maxAiImages: removed - AI decides  
    // maxStockQueries: removed - AI decides
  },
  
  timing: {
    minWordDurationMs: 80,
    minBrollGapSeconds: 3,
    transitionDurationSeconds: 0.5,
    minSegmentDuration: 1.0,
    // Used as guidance only, not a hard limit
    secondsPerBrollWindow: 15,
  },
  
  processing: {
    maxConcurrentJobs: 3,
    projectExpirationHours: 1,
    maxEventHistory: 100,
  },
} as const;

export type AIConfig = typeof AI_CONFIG;
