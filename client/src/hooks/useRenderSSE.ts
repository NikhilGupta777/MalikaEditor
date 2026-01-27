import { useCallback, useRef } from "react";
import { useSSE } from "./useSSE";
import { CLIENT_CONFIG } from "@/lib/config";

interface RenderSSECallbacks {
  onStatusUpdate: (status: string) => void;
  onActivity: (activity: { message: string; timestamp: number; details?: Record<string, unknown> }) => void;
  onComplete: (data: { outputPath: string; duration?: number; aiImageStats?: unknown }) => void;
  onError: (error: string, suggestion?: string) => void;
  onConnectionLost: () => void;
}

interface RenderSSEController {
  startRender: (projectId: number, qualityMode: string, isReconnect?: boolean) => void;
  close: () => void;
  isConnected: () => boolean;
}

export function useRenderSSE(callbacks: RenderSSECallbacks): RenderSSEController {
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const handleMessage = useCallback((data: unknown) => {
    const message = data as Record<string, unknown>;
    
    if (message.type === "status") {
      callbacksRef.current.onStatusUpdate(message.status as string);
    } else if (message.type === "activity") {
      callbacksRef.current.onActivity({
        message: message.message as string,
        timestamp: message.timestamp as number,
        details: message.details as Record<string, unknown> | undefined,
      });
    } else if (message.type === "complete") {
      callbacksRef.current.onComplete({
        outputPath: message.outputPath as string,
        duration: message.duration as number | undefined,
        aiImageStats: message.aiImageStats,
      });
      sse.close();
    } else if (message.type === "error") {
      callbacksRef.current.onError(
        message.error as string,
        message.suggestion as string | undefined
      );
      sse.close();
    }
  }, []);

  const handleError = useCallback(() => {
    callbacksRef.current.onConnectionLost();
  }, []);

  const handleMaxRetriesReached = useCallback(() => {
    callbacksRef.current.onConnectionLost();
  }, []);

  const sse = useSSE({
    maxRetries: CLIENT_CONFIG.sse.maxReconnectAttempts,
    retryDelay: CLIENT_CONFIG.sse.baseReconnectDelayMs,
    onMessage: handleMessage,
    onError: handleError,
    onMaxRetriesReached: handleMaxRetriesReached,
    onReconnect: (attempt) => {
      console.log(`Render SSE reconnecting (attempt ${attempt})`);
    },
  });

  const startRender = useCallback((projectId: number, qualityMode: string, isReconnect = false) => {
    const params = new URLSearchParams();
    params.append("qualityMode", qualityMode);
    if (isReconnect) {
      params.append("reconnect", "true");
    }
    sse.connect(`/api/videos/${projectId}/render?${params.toString()}`);
  }, [sse]);

  return {
    startRender,
    close: sse.close,
    isConnected: sse.isConnected,
  };
}
