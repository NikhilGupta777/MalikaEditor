export { getGeminiClient, getOpenAIClient } from "./clients";

export { 
  logTranscriptionConfig, 
  transcribeAudio,
  transcribeAudioEnhanced,
  type TranscriptEnhancedResult,
  type SpeakerInfo,
  type ChapterInfo,
  type SentimentInfo,
  type EntityInfo
} from "./transcription";

export { 
  analyzeVideoFrames,
  analyzeVideoDeep,
  watchFullVideo,
  type DeepAnalysisResult
} from "./videoAnalysis";

export { 
  detectTranscriptLanguage,
  translateTranscriptToEnglish,
  detectFillerWords,
  analyzeTranscriptSemantics 
} from "./semanticAnalysis";

export { 
  generateAiImage,
  generateAiImagesForVideo,
  type GeneratedAiImage 
} from "./imageGeneration";

export { 
  validateAndFixBrollActions,
  generateEditPlan,
  generateSmartEditPlan 
} from "./editPlanning";

export {
  performPreRenderReview,
  correctTranscriptBeforeRender,
  recordEditFeedback,
  getFeedbackSummary,
  getFeedbackContextForPlanning,
  clearFeedbackCache,
  type PreRenderReviewResult,
  type TranscriptCorrection,
  type EditFeedback,
  type FeedbackSummary
} from "./preRenderReview";

export {
  performPostRenderSelfReview,
  shouldAutoCorrect,
  generateCorrectionPlan,
  applyCorrectionPlan,
  shouldTriggerReRender,
  type SelfReviewResult,
  type SelfReviewIssue,
  type CorrectionPlan,
  type AppliedCorrections
} from "./postRenderReview";

export {
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
  type LearnedPreferences
} from "./learningSystem";
