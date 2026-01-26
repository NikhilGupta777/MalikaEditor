/**
 * AI Service Module
 * 
 * This module has been refactored into separate focused modules for better maintainability.
 * All functions are re-exported from their respective modules:
 * 
 * - clients.ts: AI client initialization (Gemini, OpenAI)
 * - transcription.ts: Audio transcription functions
 * - videoAnalysis.ts: Video frame analysis and deep analysis
 * - semanticAnalysis.ts: Transcript semantic analysis
 * - imageGeneration.ts: AI image generation
 * - editPlanning.ts: Multi-pass edit planning system
 * 
 * For backward compatibility, all exports are available from this file.
 */

export {
  getGeminiClient,
  getOpenAIClient,
  logTranscriptionConfig,
  transcribeAudio,
  analyzeVideoFrames,
  analyzeVideoDeep,
  detectTranscriptLanguage,
  translateTranscriptToEnglish,
  detectFillerWords,
  analyzeTranscriptSemantics,
  generateAiImage,
  generateAiImagesForVideo,
  type GeneratedAiImage,
  validateAndFixBrollActions,
  generateEditPlan,
  generateSmartEditPlan,
  performPreRenderReview,
  recordEditFeedback,
  getFeedbackSummary,
  getFeedbackContextForPlanning,
  clearFeedbackCache,
  type PreRenderReviewResult,
  type EditFeedback,
  type FeedbackSummary,
} from "./ai";
