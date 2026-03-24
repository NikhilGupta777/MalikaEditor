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
  transcribeAudioEnhanced,
  analyzeVideoFrames,
  analyzeVideoDeep,
  watchFullVideo,
  type DeepAnalysisResult,
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
  correctTranscriptBeforeRender,
  recordEditFeedback,
  getFeedbackSummary,
  getFeedbackContextForPlanning,
  clearFeedbackCache,
  type PreRenderReviewResult,
  type TranscriptCorrection,
  type EditFeedback,
  type FeedbackSummary,
  performPostRenderSelfReview,
  shouldAutoCorrect,
  generateCorrectionPlan,
  applyCorrectionPlan,
  shouldTriggerReRender,
  type SelfReviewResult,
  type SelfReviewIssue,
  type CorrectionPlan,
  type AppliedCorrections,
  storePattern,
  retrievePatterns,
  applyLearnedPreferences,
  recordFeedback,
  getPatternStats,
  clearOldPatterns,
  getLearningContext,
  type PatternType,
  type EditingPattern,
  type FeedbackLearning,
  type LearningStats,
  type PatternSuggestion,
  type LearnedPreferences,
} from "./ai";
