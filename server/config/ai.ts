export const AI_CONFIG = {
  models: {
    transcription: {
      // Replit AI Integration only supports gpt-4o-mini-transcribe with 'json' format
      // Word-level timestamps are synthesized from segment timing
      primary: "gpt-4o-mini-transcribe",
      fallback: "gemini-2.5-flash",
    },
    analysis: "gemini-2.5-flash",
    editPlanning: "gemini-2.5-flash",
    imageGeneration: "gemini-2.5-flash-image",
    mediaSelection: "gemini-2.5-flash",
    reviewPass: "gemini-2.5-flash",
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
  
  // Confidence thresholds for filtering AI-generated content
  confidence: {
    minMediaSelectionScore: 10, // Skip low-confidence B-roll selections
    minTranscriptConfidence: 0.6, // Minimum confidence for transcript segments
    highConfidenceScore: 20, // Score threshold for "high confidence" label
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
