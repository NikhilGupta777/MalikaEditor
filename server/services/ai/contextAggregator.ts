import { createLogger } from "../../utils/logger";
import type {
  VideoAnalysis,
  TranscriptSegment,
  SemanticAnalysis,
  SceneSegment,
  EmotionFlowPoint,
  SpeakerSegment,
  KeyMoment,
  TranscriptEnhancedType,
  ChapterInfoType,
  SentimentInfoType,
  EntityInfoType,
} from "@shared/schema";

const contextLogger = createLogger("context-aggregator");

export interface SpeakerAtTimestamp {
  speakerId: string | null;
  speakerLabel?: string;
  isSpeakerChange: boolean;
  speakerDuration: number;
}

export interface EmotionAtTimestamp {
  emotion: string;
  intensity: number;
  isEmotionalPeak: boolean;
  trend: "rising" | "falling" | "stable";
}

export interface SceneAtTimestamp {
  sceneType: string;
  visualDescription: string;
  emotionalTone: string;
  visualImportance: "low" | "medium" | "high";
  isSceneBoundary: boolean;
  motionLevel: "low" | "medium" | "high";
}

export interface EntityContext {
  entities: string[];
  entityTypes: Record<string, string[]>;
}

export interface ChapterContext {
  chapterTitle: string;
  chapterSummary: string;
  chapterGist: string;
  isNearChapterBoundary: boolean;
}

export interface SentimentContext {
  sentiment: "positive" | "negative" | "neutral";
  confidence: number;
  speaker?: string;
}

export interface ContextAtTimestamp {
  timestamp: number;
  speaker: SpeakerAtTimestamp | null;
  emotion: EmotionAtTimestamp | null;
  scene: SceneAtTimestamp | null;
  entities: EntityContext;
  chapter: ChapterContext | null;
  sentiment: SentimentContext | null;
  transcript: {
    text: string;
    keywords: string[];
    isFiller: boolean;
    isKeyMoment: boolean;
    hookScore?: number;
  } | null;
  motion: {
    motionIntensity: "low" | "medium" | "high";
    isInActionSequence: boolean;
    actionDescription?: string;
  } | null;
  silentSegment: boolean;
  keyMoment: KeyMoment | null;
}

export interface UnifiedContext {
  hasData: {
    speakers: boolean;
    scenes: boolean;
    emotionFlow: boolean;
    entities: boolean;
    sentiment: boolean;
    chapters: boolean;
    motionAnalysis: boolean;
    silentSegments: boolean;
    keyMoments: boolean;
  };
  summary: {
    totalSpeakers: number;
    totalScenes: number;
    totalChapters: number;
    totalEntities: number;
    dominantEmotion: string | null;
    overallSentiment: "positive" | "negative" | "neutral" | "mixed" | null;
    avgMotionIntensity: "low" | "medium" | "high" | null;
    silentDuration: number;
  };
  dataQuality: {
    speakerConfidence: number;
    sceneConfidence: number;
    emotionConfidence: number;
  };
}

export class ContextAggregator {
  private analysis: VideoAnalysis;
  private transcript: TranscriptSegment[];
  private semanticAnalysis?: SemanticAnalysis;
  private enhancedTranscript?: TranscriptEnhancedType;
  
  private speakers: SpeakerSegment[] = [];
  private scenes: SceneSegment[] = [];
  private emotionFlow: EmotionFlowPoint[] = [];
  private keyMoments: KeyMoment[] = [];
  private chapters: ChapterInfoType[] = [];
  private sentiments: SentimentInfoType[] = [];
  private entities: EntityInfoType[] = [];
  private silentSegments: { start: number; end: number }[] = [];
  
  constructor(
    analysis: VideoAnalysis,
    transcript: TranscriptSegment[],
    semanticAnalysis?: SemanticAnalysis,
    enhancedTranscript?: TranscriptEnhancedType
  ) {
    this.analysis = analysis;
    this.transcript = transcript;
    this.semanticAnalysis = semanticAnalysis;
    this.enhancedTranscript = enhancedTranscript;
    
    this.speakers = analysis.speakers || [];
    this.scenes = analysis.scenes || [];
    this.emotionFlow = analysis.emotionFlow || [];
    this.keyMoments = analysis.keyMoments || [];
    this.silentSegments = analysis.silentSegments || [];
    
    if (enhancedTranscript) {
      this.chapters = enhancedTranscript.chapters || [];
      this.sentiments = enhancedTranscript.sentiments || [];
      this.entities = enhancedTranscript.entities || [];
    }
    
    contextLogger.debug(`Context aggregator initialized: ${this.speakers.length} speakers, ${this.scenes.length} scenes, ${this.emotionFlow.length} emotion points, ${this.chapters.length} chapters, ${this.entities.length} entities`);
  }
  
  getUnifiedContext(): UnifiedContext {
    const dominantEmotion = this.getDominantEmotion();
    const overallSentiment = this.getOverallSentiment();
    const avgMotion = this.getAverageMotionIntensity();
    
    return {
      hasData: {
        speakers: this.speakers.length > 0,
        scenes: this.scenes.length > 0,
        emotionFlow: this.emotionFlow.length > 0,
        entities: this.entities.length > 0,
        sentiment: this.sentiments.length > 0,
        chapters: this.chapters.length > 0,
        motionAnalysis: !!this.analysis.enhancedAnalysis?.motionAnalysis,
        silentSegments: this.silentSegments.length > 0,
        keyMoments: this.keyMoments.length > 0,
      },
      summary: {
        totalSpeakers: new Set(this.speakers.map(s => s.speakerId)).size,
        totalScenes: this.scenes.length,
        totalChapters: this.chapters.length,
        totalEntities: this.entities.length,
        dominantEmotion,
        overallSentiment,
        avgMotionIntensity: avgMotion,
        silentDuration: this.silentSegments.reduce((sum, s) => sum + (s.end - s.start), 0),
      },
      dataQuality: {
        speakerConfidence: this.speakers.length > 0 ? 80 : 0,
        sceneConfidence: this.scenes.length > 0 ? 75 : 0,
        emotionConfidence: this.emotionFlow.length > 0 ? 70 : 0,
      },
    };
  }
  
  getContextAtTimestamp(timestamp: number): ContextAtTimestamp {
    return {
      timestamp,
      speaker: this.getSpeakerAt(timestamp),
      emotion: this.getEmotionAt(timestamp),
      scene: this.getSceneAt(timestamp),
      entities: this.getEntitiesNear(timestamp, 5),
      chapter: this.getChapterAt(timestamp),
      sentiment: this.getSentimentNear(timestamp, 3),
      transcript: this.getTranscriptAt(timestamp),
      motion: this.getMotionAt(timestamp),
      silentSegment: this.isInSilentSegment(timestamp),
      keyMoment: this.getKeyMomentNear(timestamp, 2),
    };
  }
  
  getSpeakerAt(timestamp: number): SpeakerAtTimestamp | null {
    if (this.speakers.length === 0) return null;
    
    const current = this.speakers.find(s => 
      timestamp >= s.start && timestamp <= s.end
    );
    
    if (!current) return null;
    
    const speakerStartTime = this.speakers
      .filter(s => s.speakerId === current.speakerId && s.end <= timestamp)
      .reduce((earliest, s) => Math.min(earliest, s.start), current.start);
    
    const previousSpeaker = this.speakers
      .filter(s => s.end < current.start)
      .sort((a, b) => b.end - a.end)[0];
    
    const isSpeakerChange = previousSpeaker && previousSpeaker.speakerId !== current.speakerId;
    const speakerDuration = timestamp - speakerStartTime;
    
    return {
      speakerId: current.speakerId,
      speakerLabel: current.speakerLabel,
      isSpeakerChange: !!isSpeakerChange,
      speakerDuration,
    };
  }
  
  getEmotionAt(timestamp: number): EmotionAtTimestamp | null {
    if (this.emotionFlow.length === 0) return null;
    
    const sorted = [...this.emotionFlow].sort((a, b) => 
      Math.abs(a.timestamp - timestamp) - Math.abs(b.timestamp - timestamp)
    );
    
    const closest = sorted[0];
    if (!closest || Math.abs(closest.timestamp - timestamp) > 10) return null;
    
    const maxIntensity = Math.max(...this.emotionFlow.map(e => e.intensity));
    const isEmotionalPeak = closest.intensity >= maxIntensity * 0.85;
    
    let trend: "rising" | "falling" | "stable" = "stable";
    const prev = this.emotionFlow.find(e => e.timestamp < timestamp && e.timestamp >= timestamp - 5);
    if (prev) {
      if (closest.intensity - prev.intensity > 10) trend = "rising";
      else if (prev.intensity - closest.intensity > 10) trend = "falling";
    }
    
    return {
      emotion: closest.emotion,
      intensity: closest.intensity,
      isEmotionalPeak,
      trend,
    };
  }
  
  getSceneAt(timestamp: number): SceneAtTimestamp | null {
    if (this.scenes.length === 0) return null;
    
    const current = this.scenes.find(s => 
      timestamp >= s.start && timestamp <= s.end
    );
    
    if (!current) return null;
    
    const isNearStart = timestamp - current.start < 1;
    const isNearEnd = current.end - timestamp < 1;
    const isSceneBoundary = isNearStart || isNearEnd;
    
    const motionAnalysis = this.analysis.enhancedAnalysis?.motionAnalysis;
    let motionLevel: "low" | "medium" | "high" = "medium";
    
    if (motionAnalysis) {
      const inActionSequence = (motionAnalysis.actionSequences || []).some(
        a => timestamp >= a.start && timestamp <= a.end
      );
      if (inActionSequence) {
        motionLevel = "high";
      } else {
        motionLevel = motionAnalysis.motionIntensity || "medium";
      }
    }
    
    return {
      sceneType: current.sceneType,
      visualDescription: current.visualDescription,
      emotionalTone: current.emotionalTone,
      visualImportance: current.visualImportance as "low" | "medium" | "high",
      isSceneBoundary,
      motionLevel,
    };
  }
  
  getEntitiesNear(timestamp: number, windowSeconds: number): EntityContext {
    const nearbyEntities = this.entities.filter(e => 
      e.start >= timestamp - windowSeconds && e.end <= timestamp + windowSeconds
    );
    
    const entityTypes: Record<string, string[]> = {};
    for (const entity of nearbyEntities) {
      if (!entityTypes[entity.type]) {
        entityTypes[entity.type] = [];
      }
      if (!entityTypes[entity.type].includes(entity.text)) {
        entityTypes[entity.type].push(entity.text);
      }
    }
    
    return {
      entities: nearbyEntities.map(e => e.text),
      entityTypes,
    };
  }
  
  getChapterAt(timestamp: number): ChapterContext | null {
    if (this.chapters.length === 0) return null;
    
    const current = this.chapters.find(c => 
      timestamp >= c.start && timestamp <= c.end
    );
    
    if (!current) return null;
    
    const isNearStart = timestamp - current.start < 3;
    const isNearEnd = current.end - timestamp < 3;
    
    return {
      chapterTitle: current.title,
      chapterSummary: current.summary,
      chapterGist: current.gist,
      isNearChapterBoundary: isNearStart || isNearEnd,
    };
  }
  
  getSentimentNear(timestamp: number, windowSeconds: number): SentimentContext | null {
    if (this.sentiments.length === 0) return null;
    
    const nearby = this.sentiments.filter(s => 
      s.start >= timestamp - windowSeconds && s.end <= timestamp + windowSeconds
    );
    
    if (nearby.length === 0) return null;
    
    const avgConfidence = nearby.reduce((sum, s) => sum + s.confidence, 0) / nearby.length;
    
    const sentimentCounts = { positive: 0, negative: 0, neutral: 0 };
    for (const s of nearby) {
      sentimentCounts[s.sentiment]++;
    }
    
    const dominantSentiment = Object.entries(sentimentCounts)
      .sort((a, b) => b[1] - a[1])[0][0] as "positive" | "negative" | "neutral";
    
    return {
      sentiment: dominantSentiment,
      confidence: avgConfidence,
      speaker: nearby[0]?.speaker,
    };
  }
  
  getTranscriptAt(timestamp: number): ContextAtTimestamp["transcript"] | null {
    const segment = this.transcript.find(t => 
      timestamp >= t.start && timestamp <= t.end
    );
    
    if (!segment) return null;
    
    return {
      text: segment.text,
      keywords: segment.keywords || [],
      isFiller: segment.isFiller || false,
      isKeyMoment: segment.isKeyMoment || false,
      hookScore: segment.hookScore,
    };
  }
  
  getMotionAt(timestamp: number): ContextAtTimestamp["motion"] | null {
    const motionAnalysis = this.analysis.enhancedAnalysis?.motionAnalysis;
    if (!motionAnalysis) return null;
    
    const actionSequences = motionAnalysis.actionSequences || [];
    const inAction = actionSequences.find(a => 
      timestamp >= a.start && timestamp <= a.end
    );
    
    return {
      motionIntensity: motionAnalysis.motionIntensity,
      isInActionSequence: !!inAction,
      actionDescription: inAction?.description,
    };
  }
  
  isInSilentSegment(timestamp: number): boolean {
    return this.silentSegments.some(s => 
      timestamp >= s.start && timestamp <= s.end
    );
  }
  
  getKeyMomentNear(timestamp: number, windowSeconds: number): KeyMoment | null {
    const nearby = this.keyMoments.find(k => 
      Math.abs(k.timestamp - timestamp) <= windowSeconds
    );
    return nearby || null;
  }
  
  private getDominantEmotion(): string | null {
    if (this.emotionFlow.length === 0) return null;
    
    const emotionCounts: Record<string, number> = {};
    for (const e of this.emotionFlow) {
      emotionCounts[e.emotion] = (emotionCounts[e.emotion] || 0) + 1;
    }
    
    const sorted = Object.entries(emotionCounts).sort((a, b) => b[1] - a[1]);
    return sorted[0]?.[0] || null;
  }
  
  private getOverallSentiment(): "positive" | "negative" | "neutral" | "mixed" | null {
    if (this.sentiments.length === 0) return null;
    
    const counts = { positive: 0, negative: 0, neutral: 0 };
    for (const s of this.sentiments) {
      counts[s.sentiment]++;
    }
    
    const total = counts.positive + counts.negative + counts.neutral;
    const positiveRatio = counts.positive / total;
    const negativeRatio = counts.negative / total;
    
    if (positiveRatio > 0.6) return "positive";
    if (negativeRatio > 0.6) return "negative";
    if (positiveRatio > 0.3 && negativeRatio > 0.3) return "mixed";
    return "neutral";
  }
  
  private getAverageMotionIntensity(): "low" | "medium" | "high" | null {
    const motionAnalysis = this.analysis.enhancedAnalysis?.motionAnalysis;
    if (!motionAnalysis) return null;
    return motionAnalysis.motionIntensity;
  }
  
  generateEditPlanningContext(): string {
    const context = this.getUnifiedContext();
    const parts: string[] = [];
    
    parts.push("=== RICH CONTEXT DATA FOR INTELLIGENT EDITING ===");
    parts.push("");
    
    if (context.hasData.speakers && this.speakers.length > 0) {
      parts.push("SPEAKER ANALYSIS (use for smart cuts and B-roll placement):");
      const uniqueSpeakers = new Map<string | null, number>();
      for (const s of this.speakers) {
        uniqueSpeakers.set(s.speakerId, (uniqueSpeakers.get(s.speakerId) || 0) + (s.end - s.start));
      }
      for (const [speakerId, duration] of Array.from(uniqueSpeakers.entries())) {
        parts.push(`  - ${speakerId || "Unknown"}: ${duration.toFixed(1)}s total speaking time`);
      }
      parts.push("  GUIDANCE: Prefer cuts during speaker transitions. Add B-roll when same speaker talks >15s.");
      parts.push("");
    }
    
    if (context.hasData.scenes && this.scenes.length > 0) {
      parts.push("SCENE ANALYSIS (use for transition placement):");
      for (const scene of this.scenes.slice(0, 8)) {
        parts.push(`  [${scene.start.toFixed(1)}s-${scene.end.toFixed(1)}s] ${scene.sceneType}: ${scene.visualDescription} (importance: ${scene.visualImportance})`);
      }
      if (this.scenes.length > 8) {
        parts.push(`  ... and ${this.scenes.length - 8} more scenes`);
      }
      parts.push("  GUIDANCE: Use scene boundaries as natural transition points. Match B-roll to scene mood.");
      parts.push("");
    }
    
    if (context.hasData.emotionFlow && this.emotionFlow.length > 0) {
      parts.push("EMOTION FLOW (use for pacing decisions):");
      const peaks = this.emotionFlow.filter(e => e.intensity >= 70).slice(0, 5);
      for (const peak of peaks) {
        parts.push(`  [${peak.timestamp.toFixed(1)}s] ${peak.emotion} (intensity: ${peak.intensity}%)`);
      }
      parts.push(`  Dominant emotion: ${context.summary.dominantEmotion || "neutral"}`);
      parts.push("  GUIDANCE: Slow down during high-emotion moments. Add emphasis text/captions at emotional peaks.");
      parts.push("");
    }
    
    if (context.hasData.chapters && this.chapters.length > 0) {
      parts.push("AUTO-DETECTED CHAPTERS (use for structure):");
      for (const chapter of this.chapters) {
        parts.push(`  [${chapter.start.toFixed(1)}s-${chapter.end.toFixed(1)}s] "${chapter.title}"`);
        parts.push(`    Summary: ${chapter.gist}`);
      }
      parts.push("  GUIDANCE: Use chapter boundaries for natural section breaks. Consider chapter titles for text overlays.");
      parts.push("");
    }
    
    if (context.hasData.entities && this.entities.length > 0) {
      parts.push("DETECTED ENTITIES (use for smart B-roll queries):");
      const entityTypes: Record<string, string[]> = {};
      for (const e of this.entities) {
        if (!entityTypes[e.type]) entityTypes[e.type] = [];
        if (!entityTypes[e.type].includes(e.text) && entityTypes[e.type].length < 5) {
          entityTypes[e.type].push(e.text);
        }
      }
      for (const [type, entities] of Object.entries(entityTypes)) {
        parts.push(`  ${type}: ${entities.join(", ")}`);
      }
      parts.push("  GUIDANCE: Search for B-roll using these specific entity names (e.g., 'Eiffel Tower' not 'building').");
      parts.push("");
    }
    
    if (context.hasData.sentiment) {
      parts.push("SENTIMENT ANALYSIS (use for tone-matching):");
      parts.push(`  Overall: ${context.summary.overallSentiment}`);
      const sentimentSummary = this.sentiments.slice(0, 5).map(s => 
        `[${s.start.toFixed(1)}s] ${s.sentiment}`
      ).join(", ");
      if (sentimentSummary) parts.push(`  Flow: ${sentimentSummary}`);
      parts.push("  GUIDANCE: Match B-roll mood to sentiment. Positive segments = upbeat imagery. Negative = more subdued.");
      parts.push("");
    }
    
    if (context.hasData.silentSegments && this.silentSegments.length > 0) {
      parts.push("SILENT SEGMENTS (candidates for cutting):");
      for (const s of this.silentSegments.slice(0, 10)) {
        const duration = s.end - s.start;
        parts.push(`  [${s.start.toFixed(1)}s-${s.end.toFixed(1)}s] ${duration.toFixed(1)}s silence`);
      }
      parts.push(`  Total silent time: ${context.summary.silentDuration.toFixed(1)}s`);
      parts.push("  GUIDANCE: Consider cutting silences >1s, especially outside intro/outro sections.");
      parts.push("");
    }
    
    if (context.hasData.keyMoments && this.keyMoments.length > 0) {
      parts.push("KEY MOMENTS (protect these, consider emphasis):");
      for (const k of this.keyMoments.slice(0, 10)) {
        parts.push(`  [${k.timestamp.toFixed(1)}s] ${k.type}: ${k.description} (importance: ${k.importance})`);
      }
      parts.push("  GUIDANCE: NEVER cut key moments. Consider adding captions/text overlays at these points.");
      parts.push("");
    }
    
    parts.push("=== DATA SOURCES AVAILABLE ===");
    const available = Object.entries(context.hasData).filter(([_, v]) => v).map(([k]) => k);
    const unavailable = Object.entries(context.hasData).filter(([_, v]) => !v).map(([k]) => k);
    parts.push(`  Available: ${available.join(", ") || "none"}`);
    if (unavailable.length > 0) {
      parts.push(`  Not available: ${unavailable.join(", ")}`);
    }
    parts.push("");
    
    return parts.join("\n");
  }
  
  generateMediaSelectionContext(windowStart: number, windowEnd: number): string {
    const contextAtStart = this.getContextAtTimestamp(windowStart);
    const contextAtEnd = this.getContextAtTimestamp(windowEnd);
    
    const parts: string[] = [];
    
    parts.push(`=== CONTEXT FOR B-ROLL WINDOW [${windowStart.toFixed(1)}s - ${windowEnd.toFixed(1)}s] ===`);
    
    if (contextAtStart.speaker) {
      parts.push(`Speaker: ${contextAtStart.speaker.speakerId || "Unknown"} (${contextAtStart.speaker.isSpeakerChange ? "just changed" : `speaking for ${contextAtStart.speaker.speakerDuration.toFixed(0)}s`})`);
    }
    
    if (contextAtStart.scene) {
      parts.push(`Scene: ${contextAtStart.scene.sceneType} - ${contextAtStart.scene.visualDescription}`);
      parts.push(`Motion: ${contextAtStart.scene.motionLevel} | Importance: ${contextAtStart.scene.visualImportance}`);
      if (contextAtStart.scene.isSceneBoundary) {
        parts.push("** AT SCENE BOUNDARY - natural transition point **");
      }
    }
    
    if (contextAtStart.emotion) {
      parts.push(`Emotion: ${contextAtStart.emotion.emotion} (intensity: ${contextAtStart.emotion.intensity}%, trend: ${contextAtStart.emotion.trend})`);
      if (contextAtStart.emotion.isEmotionalPeak) {
        parts.push("** EMOTIONAL PEAK - consider preserving original footage **");
      }
    }
    
    if (contextAtStart.entities.entities.length > 0) {
      parts.push(`Entities mentioned: ${contextAtStart.entities.entities.join(", ")}`);
      parts.push("GUIDANCE: Search for these specific entities for relevant B-roll");
    }
    
    if (contextAtStart.sentiment) {
      parts.push(`Sentiment: ${contextAtStart.sentiment.sentiment} (confidence: ${(contextAtStart.sentiment.confidence * 100).toFixed(0)}%)`);
    }
    
    if (contextAtStart.chapter) {
      parts.push(`Chapter: "${contextAtStart.chapter.chapterTitle}"`);
      if (contextAtStart.chapter.isNearChapterBoundary) {
        parts.push("** NEAR CHAPTER BOUNDARY **");
      }
    }
    
    if (contextAtStart.motion) {
      parts.push(`Motion: ${contextAtStart.motion.motionIntensity}`);
      if (contextAtStart.motion.isInActionSequence) {
        parts.push(`** IN ACTION SEQUENCE: ${contextAtStart.motion.actionDescription} - prefer VIDEO over image **`);
      }
    }
    
    if (contextAtStart.keyMoment) {
      parts.push(`** KEY MOMENT NEARBY: ${contextAtStart.keyMoment.type} - ${contextAtStart.keyMoment.description} **`);
      parts.push("GUIDANCE: Consider if B-roll should even be used here, or if original footage is more important");
    }
    
    return parts.join("\n");
  }
}

export function createContextAggregator(
  analysis: VideoAnalysis,
  transcript: TranscriptSegment[],
  semanticAnalysis?: SemanticAnalysis,
  enhancedTranscript?: TranscriptEnhancedType
): ContextAggregator {
  return new ContextAggregator(analysis, transcript, semanticAnalysis, enhancedTranscript);
}
