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
  analyzeVideoDeep 
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
  recordEditFeedback,
  getFeedbackSummary,
  getFeedbackContextForPlanning,
  clearFeedbackCache,
  type PreRenderReviewResult,
  type EditFeedback,
  type FeedbackSummary
} from "./preRenderReview";
