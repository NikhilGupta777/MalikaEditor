export const AI_CONFIG = {
  models: {
    transcription: {
      // AssemblyAI provides native word-level timestamps - best for captions
      // Falls back to OpenAI/Gemini if AssemblyAI unavailable
      primary: "assemblyai-universal",
      secondary: "gpt-4o-mini-transcribe",
      fallback: "gemini-2.5-flash",
    },
    analysis: "gemini-2.5-flash",
    fullVideoWatch: "gemini-2.5-flash", // Full video file upload and analysis
    selfReview: "gemini-2.5-flash", // AI reviews its own rendered output
    editPlanning: "gemini-2.5-flash",
    imageGeneration: "gemini-2.5-flash-image",
    mediaSelection: "gemini-2.5-flash",
    mediaVision: "gemini-2.5-flash", // Vision-capable model for analyzing stock thumbnails
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
    cleanupIntervalMs: 10 * 60 * 1000, // 10 minutes
    sseHeartbeatMs: 5000, // 5 seconds - more frequent to prevent proxy timeouts
  },
  
  stockMedia: {
    // Per-query fetch limits - increased to give AI more options
    photosPerQuery: 5,
    videosPerQuery: 5,
    freepikPhotosPerQuery: 3,
    freepikVideosPerQuery: 3,
  },
  
  network: {
    defaultTimeoutMs: 30000,
    longTimeoutMs: 60000,
    retryBaseDelayMs: 1000,
    maxRetryDelayMs: 15000,
    pexelsQueryMaxLength: 80,
  },
  
  ffmpeg: {
    probeTimeoutMs: 30000,
    shortTimeoutMs: 2 * 60 * 1000, // 2 minutes
    longTimeoutMs: 10 * 60 * 1000, // 10 minutes
  },
  
  sse: {
    maxReconnectAttempts: 5,
    baseReconnectDelayMs: 2000,
    reconnectBackoffMultiplier: 1.5,
  },
} as const;

export type AIConfig = typeof AI_CONFIG;
