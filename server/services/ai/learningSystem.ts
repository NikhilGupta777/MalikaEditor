import { createLogger } from "../../utils/logger";
import type { ReviewData, EditAction, VideoAnalysis, EditPlan } from "@shared/schema";
import type { SelfReviewResult } from "./postRenderReview";

const learningLogger = createLogger("ai-learning");

export type PatternType = "cut" | "transition" | "broll" | "ai_image" | "caption" | "pacing" | "general";

export interface EditingPattern {
  id: string;
  type: PatternType;
  genre?: string;
  tone?: string;
  prompt?: string;
  actionDetails: {
    start?: number;
    end?: number;
    duration?: number;
    reason?: string;
    query?: string;
    transitionType?: string;
  };
  successScore: number;
  userApproved: boolean;
  selfReviewScore?: number;
  timestamp: Date;
  context?: {
    videoGenre?: string;
    videoTone?: string;
    videoDuration?: number;
    promptKeywords?: string[];
    // Enhanced analysis data for better pattern matching
    motionIntensity?: "low" | "medium" | "high";
    overallPacing?: "slow" | "moderate" | "fast" | "dynamic";
    hasActionSequences?: boolean;
    syncQuality?: "excellent" | "good" | "fair" | "poor";
  };
}

export interface FeedbackLearning {
  patternId: string;
  feedbackType: "positive" | "negative" | "neutral";
  adjustmentMade?: string;
  effectivenessScore: number;
  timestamp: Date;
}

export interface LearningStats {
  totalPatterns: number;
  patternsByType: Record<PatternType, number>;
  averageSuccessScore: number;
  topGenres: string[];
  recentLearnings: number;
}

export interface PatternSuggestion {
  pattern: EditingPattern;
  relevanceScore: number;
  reason: string;
}

export interface LearnedPreferences {
  preferredTransitionTypes: string[];
  avgBrollDuration: number;
  preferredPacing: "slow" | "moderate" | "fast";
  cutPatterns: {
    avgCutDuration: number;
    commonReasons: string[];
  };
  genrePreferences: Record<string, {
    brollFrequency: "low" | "medium" | "high";
    transitionStyle: string;
    avgCutsPerMinute: number;
  }>;
}

const patternStore = new Map<PatternType, EditingPattern[]>();
const feedbackStore: FeedbackLearning[] = [];

const MAX_PATTERNS_PER_TYPE = 100;
const PATTERN_DECAY_DAYS = 30;

function generatePatternId(): string {
  return `pattern_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function extractKeywords(prompt: string): string[] {
  const stopWords = new Set(["the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by", "from", "as", "is", "was", "are", "were", "been", "be", "have", "has", "had", "do", "does", "did", "will", "would", "could", "should", "may", "might", "must", "shall", "can", "need", "dare", "ought", "used", "i", "you", "he", "she", "it", "we", "they", "my", "your", "his", "her", "its", "our", "their", "this", "that", "these", "those", "what", "which", "who", "whom", "whose", "where", "when", "why", "how", "make", "video", "edit", "create", "remove", "add"]);
  
  return prompt
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word))
    .slice(0, 10);
}

function calculatePatternAge(pattern: EditingPattern): number {
  const now = new Date();
  const patternDate = new Date(pattern.timestamp);
  return (now.getTime() - patternDate.getTime()) / (1000 * 60 * 60 * 24);
}

function calculateRelevanceScore(
  pattern: EditingPattern,
  targetGenre?: string,
  targetTone?: string,
  targetPrompt?: string
): number {
  let score = 0;
  
  score += pattern.successScore * 0.4;
  
  if (targetGenre && pattern.context?.videoGenre) {
    if (pattern.context.videoGenre.toLowerCase() === targetGenre.toLowerCase()) {
      score += 25;
    }
  }
  
  if (targetTone && pattern.context?.videoTone) {
    if (pattern.context.videoTone.toLowerCase() === targetTone.toLowerCase()) {
      score += 15;
    }
  }
  
  if (targetPrompt && pattern.context?.promptKeywords) {
    const targetKeywords = extractKeywords(targetPrompt);
    const matchingKeywords = targetKeywords.filter(kw => 
      pattern.context!.promptKeywords!.some(pk => 
        pk.includes(kw) || kw.includes(pk)
      )
    );
    score += (matchingKeywords.length / Math.max(targetKeywords.length, 1)) * 20;
  }
  
  const ageInDays = calculatePatternAge(pattern);
  const recencyBonus = Math.max(0, 10 - (ageInDays / PATTERN_DECAY_DAYS) * 10);
  score += recencyBonus;
  
  if (pattern.userApproved) {
    score += 10;
  }
  
  return Math.min(100, Math.max(0, score));
}

export function storePattern(
  reviewData: ReviewData,
  selfReviewResult: SelfReviewResult,
  videoAnalysis: VideoAnalysis | undefined,
  userPrompt: string
): EditingPattern[] {
  learningLogger.info("═══════════════════════════════════════════════════════");
  learningLogger.info("AI LEARNING SYSTEM: Storing successful patterns...");
  learningLogger.info("═══════════════════════════════════════════════════════");
  
  const storedPatterns: EditingPattern[] = [];
  const promptKeywords = extractKeywords(userPrompt);
  
  // Extract enhancedAnalysis for pattern context (now properly typed in VideoAnalysis)
  const enhancedAnalysis = videoAnalysis?.enhancedAnalysis;
  const motionAnalysis = enhancedAnalysis?.motionAnalysis;
  const pacingAnalysis = enhancedAnalysis?.pacingAnalysis;
  const audioVisualSync = enhancedAnalysis?.audioVisualSync;
  
  const context = {
    videoGenre: videoAnalysis?.context?.genre,
    videoTone: videoAnalysis?.context?.tone,
    videoDuration: videoAnalysis?.duration,
    promptKeywords,
    // Enhanced analysis for better pattern matching
    motionIntensity: motionAnalysis?.motionIntensity,
    overallPacing: pacingAnalysis?.overallPacing,
    hasActionSequences: (motionAnalysis?.actionSequences?.length || 0) > 0,
    syncQuality: audioVisualSync?.syncQuality,
  };
  
  if (reviewData.editPlan?.actions) {
    for (const action of reviewData.editPlan.actions) {
      if (!action.approved) continue;
      
      let patternType: PatternType = "general";
      const actionDetails: EditingPattern["actionDetails"] = {};
      
      switch (action.type) {
        case "cut":
          patternType = "cut";
          actionDetails.start = action.start;
          actionDetails.end = action.end;
          actionDetails.reason = action.reason;
          actionDetails.duration = (action.end || 0) - (action.start || 0);
          break;
        case "transition":
          patternType = "transition";
          actionDetails.transitionType = (action as any).transitionType;
          actionDetails.duration = action.duration;
          break;
        case "insert_stock":
          patternType = "broll";
          actionDetails.start = action.start;
          actionDetails.duration = action.duration;
          actionDetails.query = (action as any).stockQuery;
          actionDetails.reason = action.reason;
          break;
        case "insert_ai_image":
          patternType = "ai_image";
          actionDetails.start = action.start;
          actionDetails.duration = action.duration;
          actionDetails.reason = action.reason;
          break;
        case "add_caption":
          patternType = "caption";
          actionDetails.start = action.start;
          actionDetails.end = action.end;
          break;
        default:
          continue;
      }
      
      const successScore = calculateActionSuccessScore(action, selfReviewResult);
      
      if (successScore < 50) continue;
      
      const pattern: EditingPattern = {
        id: generatePatternId(),
        type: patternType,
        genre: context.videoGenre,
        tone: context.videoTone,
        prompt: userPrompt.slice(0, 200),
        actionDetails,
        successScore,
        userApproved: action.approved || false,
        selfReviewScore: selfReviewResult.overallScore,
        timestamp: new Date(),
        context,
      };
      
      addPatternToStore(pattern);
      storedPatterns.push(pattern);
    }
  }
  
  if (reviewData.stockMedia) {
    for (const media of reviewData.stockMedia) {
      if (!media.approved) continue;
      
      const pattern: EditingPattern = {
        id: generatePatternId(),
        type: "broll",
        genre: context.videoGenre,
        tone: context.videoTone,
        actionDetails: {
          query: media.query,
          start: media.startTime,
          duration: media.duration,
          reason: media.reason,
        },
        successScore: selfReviewResult.qualityMetrics.brollRelevance,
        userApproved: true,
        selfReviewScore: selfReviewResult.overallScore,
        timestamp: new Date(),
        context,
      };
      
      addPatternToStore(pattern);
      storedPatterns.push(pattern);
    }
  }
  
  const pacingPattern: EditingPattern = {
    id: generatePatternId(),
    type: "pacing",
    genre: context.videoGenre,
    tone: context.videoTone,
    actionDetails: {
      reason: `Pacing: ${selfReviewResult.qualityMetrics.pacingFlow}/100`,
    },
    successScore: selfReviewResult.qualityMetrics.pacingFlow,
    userApproved: reviewData.userApproved || false,
    selfReviewScore: selfReviewResult.overallScore,
    timestamp: new Date(),
    context,
  };
  
  if (pacingPattern.successScore >= 70) {
    addPatternToStore(pacingPattern);
    storedPatterns.push(pacingPattern);
  }
  
  learningLogger.info(`Stored ${storedPatterns.length} patterns from successful edit`);
  learningLogger.info(`Pattern breakdown: ${JSON.stringify(getPatternStats().patternsByType)}`);
  
  return storedPatterns;
}

function calculateActionSuccessScore(
  action: any,
  selfReviewResult: SelfReviewResult
): number {
  let baseScore = selfReviewResult.overallScore;
  
  switch (action.type) {
    case "cut":
      const cutIssues = selfReviewResult.issues.filter(i => i.type === "cuts" || i.type === "pacing");
      baseScore -= cutIssues.length * 10;
      break;
    case "transition":
      baseScore = (baseScore + selfReviewResult.qualityMetrics.transitionSmoothness) / 2;
      break;
    case "insert_stock":
    case "insert_ai_image":
      baseScore = (baseScore + selfReviewResult.qualityMetrics.brollRelevance) / 2;
      break;
    case "add_caption":
      baseScore = (baseScore + selfReviewResult.qualityMetrics.captionAccuracy) / 2;
      break;
  }
  
  return Math.max(0, Math.min(100, baseScore));
}

function addPatternToStore(pattern: EditingPattern): void {
  if (!patternStore.has(pattern.type)) {
    patternStore.set(pattern.type, []);
  }
  
  const patterns = patternStore.get(pattern.type)!;
  patterns.push(pattern);
  
  if (patterns.length > MAX_PATTERNS_PER_TYPE) {
    patterns.sort((a, b) => b.successScore - a.successScore);
    patterns.splice(MAX_PATTERNS_PER_TYPE);
  }
  
  patternStore.set(pattern.type, patterns);
}

export function retrievePatterns(
  patternTypes: PatternType[],
  videoAnalysis?: VideoAnalysis,
  userPrompt?: string,
  limit: number = 10
): PatternSuggestion[] {
  learningLogger.info("Retrieving relevant patterns from learning system...");
  
  const targetGenre = videoAnalysis?.context?.genre;
  const targetTone = videoAnalysis?.context?.tone;
  
  // Extract enhancedAnalysis for better pattern matching (now properly typed in VideoAnalysis)
  const enhancedAnalysis = videoAnalysis?.enhancedAnalysis;
  const targetMotion = enhancedAnalysis?.motionAnalysis?.motionIntensity;
  const targetPacing = enhancedAnalysis?.pacingAnalysis?.overallPacing;
  
  const suggestions: PatternSuggestion[] = [];
  
  for (const type of patternTypes) {
    const patterns = patternStore.get(type) || [];
    
    for (const pattern of patterns) {
      let relevanceScore = calculateRelevanceScore(
        pattern,
        targetGenre,
        targetTone,
        userPrompt
      );
      
      // Boost score for matching motion intensity
      if (targetMotion && pattern.context?.motionIntensity === targetMotion) {
        relevanceScore += 10;
      }
      
      // Boost score for matching pacing
      if (targetPacing && pattern.context?.overallPacing === targetPacing) {
        relevanceScore += 10;
      }
      
      if (relevanceScore >= 30) {
        suggestions.push({
          pattern,
          relevanceScore,
          reason: generateSuggestionReason(pattern, relevanceScore, targetGenre, targetTone),
        });
      }
    }
  }
  
  suggestions.sort((a, b) => b.relevanceScore - a.relevanceScore);
  
  const topSuggestions = suggestions.slice(0, limit);
  
  learningLogger.info(`Retrieved ${topSuggestions.length} relevant patterns`);
  
  return topSuggestions;
}

function generateSuggestionReason(
  pattern: EditingPattern,
  relevanceScore: number,
  targetGenre?: string,
  targetTone?: string
): string {
  const reasons: string[] = [];
  
  if (pattern.successScore >= 80) {
    reasons.push(`High success rate (${pattern.successScore}%)`);
  }
  
  if (targetGenre && pattern.context?.videoGenre === targetGenre) {
    reasons.push(`Matches genre: ${targetGenre}`);
  }
  
  if (targetTone && pattern.context?.videoTone === targetTone) {
    reasons.push(`Matches tone: ${targetTone}`);
  }
  
  if (pattern.userApproved) {
    reasons.push("User approved");
  }
  
  const ageInDays = calculatePatternAge(pattern);
  if (ageInDays < 7) {
    reasons.push("Recent success");
  }
  
  return reasons.length > 0 ? reasons.join(", ") : `Relevance score: ${relevanceScore.toFixed(0)}`;
}

export function applyLearnedPreferences(
  videoAnalysis?: VideoAnalysis,
  userPrompt?: string
): LearnedPreferences {
  learningLogger.info("Applying learned preferences to edit planning...");
  
  const preferences: LearnedPreferences = {
    preferredTransitionTypes: [],
    avgBrollDuration: 3,
    preferredPacing: "moderate",
    cutPatterns: {
      avgCutDuration: 2,
      commonReasons: [],
    },
    genrePreferences: {},
  };
  
  const transitionPatterns = patternStore.get("transition") || [];
  if (transitionPatterns.length > 0) {
    const transitionTypes = new Map<string, number>();
    for (const p of transitionPatterns) {
      if (p.actionDetails.transitionType) {
        const count = transitionTypes.get(p.actionDetails.transitionType) || 0;
        transitionTypes.set(p.actionDetails.transitionType, count + p.successScore);
      }
    }
    preferences.preferredTransitionTypes = Array.from(transitionTypes.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([type]) => type);
  }
  
  const brollPatterns = patternStore.get("broll") || [];
  if (brollPatterns.length > 0) {
    const totalDuration = brollPatterns.reduce((sum, p) => sum + (p.actionDetails.duration || 3), 0);
    preferences.avgBrollDuration = totalDuration / brollPatterns.length;
  }
  
  const pacingPatterns = patternStore.get("pacing") || [];
  if (pacingPatterns.length > 0) {
    const avgPacingScore = pacingPatterns.reduce((sum, p) => sum + p.successScore, 0) / pacingPatterns.length;
    if (avgPacingScore >= 80) {
      preferences.preferredPacing = "fast";
    } else if (avgPacingScore <= 60) {
      preferences.preferredPacing = "slow";
    }
  }
  
  const cutPatterns = patternStore.get("cut") || [];
  if (cutPatterns.length > 0) {
    const totalDuration = cutPatterns.reduce((sum, p) => sum + (p.actionDetails.duration || 2), 0);
    preferences.cutPatterns.avgCutDuration = totalDuration / cutPatterns.length;
    
    const reasonCounts = new Map<string, number>();
    for (const p of cutPatterns) {
      if (p.actionDetails.reason) {
        const count = reasonCounts.get(p.actionDetails.reason) || 0;
        reasonCounts.set(p.actionDetails.reason, count + 1);
      }
    }
    preferences.cutPatterns.commonReasons = Array.from(reasonCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([reason]) => reason);
  }
  
  const targetGenre = videoAnalysis?.context?.genre;
  if (targetGenre) {
    const genrePatterns = [...brollPatterns, ...cutPatterns].filter(
      p => p.context?.videoGenre === targetGenre
    );
    
    if (genrePatterns.length >= 3) {
      const brollCount = genrePatterns.filter(p => p.type === "broll").length;
      const avgDuration = genrePatterns[0]?.context?.videoDuration || 60;
      const brollFrequency = brollCount / (avgDuration / 60);
      
      preferences.genrePreferences[targetGenre] = {
        brollFrequency: brollFrequency > 2 ? "high" : brollFrequency > 1 ? "medium" : "low",
        transitionStyle: preferences.preferredTransitionTypes[0] || "crossfade",
        avgCutsPerMinute: cutPatterns.filter(p => p.context?.videoGenre === targetGenre).length / 
          (avgDuration / 60),
      };
    }
  }
  
  learningLogger.info(`Applied preferences: ${JSON.stringify({
    transitionTypes: preferences.preferredTransitionTypes,
    avgBrollDuration: preferences.avgBrollDuration.toFixed(1),
    pacing: preferences.preferredPacing,
  })}`);
  
  return preferences;
}

export function recordFeedback(
  patternId: string,
  feedbackType: "positive" | "negative" | "neutral",
  adjustmentMade?: string
): void {
  const feedback: FeedbackLearning = {
    patternId,
    feedbackType,
    adjustmentMade,
    effectivenessScore: feedbackType === "positive" ? 100 : feedbackType === "neutral" ? 50 : 0,
    timestamp: new Date(),
  };
  
  feedbackStore.push(feedback);
  
  for (const [, patterns] of Array.from(patternStore.entries())) {
    const pattern = patterns.find((p: EditingPattern) => p.id === patternId);
    if (pattern) {
      if (feedbackType === "positive") {
        pattern.successScore = Math.min(100, pattern.successScore + 5);
      } else if (feedbackType === "negative") {
        pattern.successScore = Math.max(0, pattern.successScore - 10);
      }
      break;
    }
  }
  
  learningLogger.debug(`Recorded ${feedbackType} feedback for pattern ${patternId}`);
}

export function getPatternStats(): LearningStats {
  const patternsByType: Record<PatternType, number> = {
    cut: 0,
    transition: 0,
    broll: 0,
    ai_image: 0,
    caption: 0,
    pacing: 0,
    general: 0,
  };
  
  let totalPatterns = 0;
  let totalSuccessScore = 0;
  const genreCounts = new Map<string, number>();
  let recentLearnings = 0;
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  
  for (const [type, patterns] of Array.from(patternStore.entries())) {
    patternsByType[type as PatternType] = patterns.length;
    totalPatterns += patterns.length;
    
    for (const pattern of patterns) {
      totalSuccessScore += pattern.successScore;
      
      if (pattern.context?.videoGenre) {
        const count = genreCounts.get(pattern.context.videoGenre) || 0;
        genreCounts.set(pattern.context.videoGenre, count + 1);
      }
      
      if (new Date(pattern.timestamp) > sevenDaysAgo) {
        recentLearnings++;
      }
    }
  }
  
  const topGenres = Array.from(genreCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([genre]) => genre);
  
  return {
    totalPatterns,
    patternsByType,
    averageSuccessScore: totalPatterns > 0 ? totalSuccessScore / totalPatterns : 0,
    topGenres,
    recentLearnings,
  };
}

export function clearOldPatterns(maxAgeDays: number = PATTERN_DECAY_DAYS * 2): number {
  const cutoffDate = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
  let removedCount = 0;
  
  for (const [type, patterns] of Array.from(patternStore.entries())) {
    const filtered = patterns.filter((p: EditingPattern) => new Date(p.timestamp) > cutoffDate);
    removedCount += patterns.length - filtered.length;
    patternStore.set(type, filtered);
  }
  
  if (removedCount > 0) {
    learningLogger.info(`Cleared ${removedCount} old patterns (older than ${maxAgeDays} days)`);
  }
  
  return removedCount;
}

export function getLearningContext(
  videoAnalysis?: VideoAnalysis,
  userPrompt?: string
): string {
  const suggestions = retrievePatterns(
    ["cut", "transition", "broll", "pacing"],
    videoAnalysis,
    userPrompt,
    5
  );
  
  if (suggestions.length === 0) {
    return "";
  }
  
  const preferences = applyLearnedPreferences(videoAnalysis, userPrompt);
  
  let context = "\n\n--- LEARNED PREFERENCES FROM PAST SUCCESSFUL EDITS ---\n";
  
  if (preferences.preferredTransitionTypes.length > 0) {
    context += `- Preferred transition types: ${preferences.preferredTransitionTypes.join(", ")}\n`;
  }
  
  context += `- Suggested B-roll duration: ~${preferences.avgBrollDuration.toFixed(1)} seconds\n`;
  context += `- Recommended pacing style: ${preferences.preferredPacing}\n`;
  
  if (suggestions.length > 0) {
    context += "\nRelevant successful patterns from similar videos:\n";
    for (const s of suggestions.slice(0, 3)) {
      context += `- ${s.pattern.type}: ${s.reason} (success: ${s.pattern.successScore}%)\n`;
    }
  }
  
  context += "--- END LEARNED PREFERENCES ---\n";
  
  return context;
}
