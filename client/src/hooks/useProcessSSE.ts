import { useCallback, useRef } from "react";
import { useSSE } from "./useSSE";
import { CLIENT_CONFIG } from "@/lib/config";
import type { ReviewData, SemanticAnalysis, EditPlan, StockMediaItem, TranscriptSegment } from "@shared/schema";

interface AiImageStats {
  applied: number;
  skipped: number;
  stockApplied?: number;
  totalOverlays?: number;
}

interface Activity {
  message: string;
  timestamp: number;
  details?: Record<string, unknown>;
}

interface EnhancedAnalysisData {
  fillerSegments?: unknown[];
  qualityInsights?: unknown;
  structureAnalysis?: unknown;
  hookMoments?: unknown[];
  topicFlow?: unknown[];
  keyMoments?: unknown[];
}

interface StaleRecoveryData {
  interrupted: boolean;
  lastStatus: string;
  hasTranscript: boolean;
  hasEditPlan: boolean;
  hasStockMedia: boolean;
  message: string;
}

interface ProcessSSECallbacks {
  onStatusUpdate: (status: string) => void;
  onActivity: (activity: Activity) => void;
  onEditPlan: (editPlan: EditPlan) => void;
  onStockMedia: (stockMedia: StockMediaItem[]) => void;
  onTranscript: (transcript: TranscriptSegment[]) => void;
  onAiImageStats: (stats: AiImageStats) => void;
  onEnhancedAnalysis: (data: EnhancedAnalysisData) => void;
  onReviewReady: (reviewData: ReviewData) => void;
  onComplete: (data: { outputPath: string; duration?: number; aiImageStats?: AiImageStats }) => void;
  onError: (error: string, suggestion?: string, errorType?: string) => void;
  onStaleRecovery: (data: StaleRecoveryData) => void;
  onConnectionLost: () => void;
  onAiImages?: (count: number) => void;
  onAiImagesError?: (error: string) => void;
}

interface ProcessOptions {
  prompt: string;
  addCaptions: boolean;
  addBroll: boolean;
  removeSilence: boolean;
  generateAiImages: boolean;
  addTransitions: boolean;
}

interface ProcessSSEController {
  startProcess: (projectId: number, options: ProcessOptions, isReconnect?: boolean) => void;
  close: () => void;
  isConnected: () => boolean;
  clearStoredEventId: (projectId: number) => void;
}

export function useProcessSSE(callbacks: ProcessSSECallbacks): ProcessSSEController {
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const currentProjectIdRef = useRef<number | null>(null);
  // Ref to hold the close function to avoid closure issues
  const closeRef = useRef<(() => void) | null>(null);

  const handleMessage = useCallback((data: unknown) => {
    const message = data as Record<string, unknown>;
    
    // Helper to close connection after terminal events
    const closeConnection = () => {
      if (closeRef.current) {
        closeRef.current();
      }
    };
    
    switch (message.type) {
      case "status":
        callbacksRef.current.onStatusUpdate(message.status as string);
        break;
        
      case "activity":
        callbacksRef.current.onActivity({
          message: message.message as string,
          timestamp: message.timestamp as number,
          details: message.details as Record<string, unknown> | undefined,
        });
        break;
        
      case "editPlan":
        callbacksRef.current.onEditPlan(message.editPlan as EditPlan);
        break;
        
      case "stockMedia":
        callbacksRef.current.onStockMedia(message.stockMedia as StockMediaItem[]);
        break;
        
      case "transcript":
        callbacksRef.current.onTranscript(message.transcript as TranscriptSegment[]);
        break;
        
      case "aiImageStats":
        callbacksRef.current.onAiImageStats(message as unknown as AiImageStats);
        break;
        
      case "enhancedAnalysis":
        callbacksRef.current.onEnhancedAnalysis({
          fillerSegments: message.fillerSegments as unknown[] | undefined,
          qualityInsights: message.qualityInsights,
          structureAnalysis: message.structureAnalysis,
          hookMoments: message.hookMoments as unknown[] | undefined,
          topicFlow: message.topicFlow as unknown[] | undefined,
          keyMoments: message.keyMoments as unknown[] | undefined,
        });
        break;
        
      case "reviewReady":
        callbacksRef.current.onReviewReady(message.reviewData as ReviewData);
        closeConnection();
        break;
        
      case "complete":
        callbacksRef.current.onComplete({
          outputPath: message.outputPath as string,
          duration: message.duration as number | undefined,
          aiImageStats: message.aiImageStats as AiImageStats | undefined,
        });
        closeConnection();
        break;
        
      case "error":
        callbacksRef.current.onError(
          message.error as string,
          message.suggestion as string | undefined,
          message.errorType as string | undefined
        );
        closeConnection();
        break;
        
      case "staleRecovery":
        callbacksRef.current.onStaleRecovery({
          interrupted: message.interrupted as boolean,
          lastStatus: message.lastStatus as string,
          hasTranscript: message.hasTranscript as boolean,
          hasEditPlan: message.hasEditPlan as boolean,
          hasStockMedia: message.hasStockMedia as boolean,
          message: message.message as string,
        });
        closeConnection();
        break;
        
      case "aiImages":
        callbacksRef.current.onAiImages?.(message.count as number);
        break;
        
      case "aiImagesError":
        callbacksRef.current.onAiImagesError?.(message.error as string);
        break;
    }
  }, []);

  const handleError = useCallback(() => {
    callbacksRef.current.onConnectionLost();
  }, []);

  const handleMaxRetriesReached = useCallback(() => {
    callbacksRef.current.onConnectionLost();
  }, []);

  const getSessionKey = (projectId: number) => `process_${projectId}`;

  const sse = useSSE({
    maxRetries: CLIENT_CONFIG.sse.maxReconnectAttempts,
    retryDelay: CLIENT_CONFIG.sse.baseReconnectDelayMs,
    sessionKey: currentProjectIdRef.current ? getSessionKey(currentProjectIdRef.current) : undefined,
    onMessage: handleMessage,
    onError: handleError,
    onMaxRetriesReached: handleMaxRetriesReached,
    onReconnect: (attempt) => {
      if (process.env.NODE_ENV === "development") {
        console.log(`Process SSE reconnecting (attempt ${attempt})`);
      }
    },
  });

  // Assign close function to ref so handleMessage can access it
  closeRef.current = sse.close;

  const startProcess = useCallback((
    projectId: number, 
    options: ProcessOptions, 
    isReconnect = false
  ) => {
    currentProjectIdRef.current = projectId;
    const sessionKeyForProject = getSessionKey(projectId);

    const params = new URLSearchParams({
      prompt: options.prompt,
      addCaptions: String(options.addCaptions),
      addBroll: String(options.addBroll),
      removeSilence: String(options.removeSilence),
      generateAiImages: String(options.generateAiImages),
      addTransitions: String(options.addTransitions),
    });

    if (isReconnect) {
      params.append("reconnect", "true");
    }

    sse.connect(`/api/videos/${projectId}/process?${params.toString()}`, {
      sessionKey: sessionKeyForProject,
    });
  }, [sse]);

  const clearStoredEventId = useCallback((projectId: number) => {
    sse.clearStoredEventId(getSessionKey(projectId));
  }, [sse]);

  return {
    startProcess,
    close: sse.close,
    isConnected: sse.isConnected,
    clearStoredEventId,
  };
}
