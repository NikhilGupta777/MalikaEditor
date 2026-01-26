import { useRef, useCallback, useEffect } from "react";

interface SSEOptions {
  maxRetries?: number;
  retryDelay?: number;
  sessionKey?: string; // Key for persisting lastEventId in sessionStorage (survives page refresh)
  onOpen?: () => void;
  onMessage?: (data: unknown, eventId?: string) => void;
  onError?: (error: Event) => void;
  onReconnect?: (attempt: number) => void;
  onMaxRetriesReached?: () => void;
}

interface SSEController {
  connect: (url: string) => void;
  close: () => void;
  isConnected: () => boolean;
  getLastEventId: () => string | null;
  clearStoredEventId: () => void;
}

export function useSSE(options: SSEOptions = {}): SSEController {
  const {
    maxRetries = 5,
    retryDelay = 2000,
    sessionKey,
    onOpen,
    onMessage,
    onError,
    onReconnect,
    onMaxRetriesReached,
  } = options;

  const eventSourceRef = useRef<EventSource | null>(null);
  const retryCountRef = useRef(0);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const urlRef = useRef<string | null>(null);
  const isClosedManuallyRef = useRef(false);
  
  // Initialize lastEventId from sessionStorage if sessionKey provided
  const getStoredEventId = () => {
    if (sessionKey) {
      try {
        return sessionStorage.getItem(`sse_lastEventId_${sessionKey}`);
      } catch { return null; }
    }
    return null;
  };
  const lastEventIdRef = useRef<string | null>(getStoredEventId());

  const clearRetryTimeout = useCallback(() => {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
  }, []);

  const close = useCallback(() => {
    isClosedManuallyRef.current = true;
    clearRetryTimeout();
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    retryCountRef.current = 0;
  }, [clearRetryTimeout]);

  const getLastEventId = useCallback(() => {
    return lastEventIdRef.current;
  }, []);

  const connect = useCallback((url: string) => {
    close();
    isClosedManuallyRef.current = false;
    urlRef.current = url;
    retryCountRef.current = 0;

    const createConnection = () => {
      if (isClosedManuallyRef.current) return;

      // Add lastEventId to URL for reconnection replay support
      // On retry (retryCount > 0) or if we have a stored lastEventId (page refresh)
      let connectionUrl = url;
      const hasStoredEventId = lastEventIdRef.current !== null;
      if (retryCountRef.current > 0 || hasStoredEventId) {
        const separator = url.includes("?") ? "&" : "?";
        const reconnectParam = retryCountRef.current > 0 || hasStoredEventId ? "reconnect=true" : "";
        const lastEventParam = lastEventIdRef.current ? `&lastEventId=${lastEventIdRef.current}` : "";
        connectionUrl = `${url}${separator}${reconnectParam}${lastEventParam}`;
      }

      const eventSource = new EventSource(connectionUrl);
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        retryCountRef.current = 0;
        onOpen?.();
      };

      eventSource.onmessage = (event) => {
        // Track the last event ID for replay on reconnection
        if (event.lastEventId) {
          lastEventIdRef.current = event.lastEventId;
          // Persist to sessionStorage if sessionKey provided (survives page refresh)
          if (sessionKey) {
            try {
              sessionStorage.setItem(`sse_lastEventId_${sessionKey}`, event.lastEventId);
            } catch { /* sessionStorage not available */ }
          }
        }
        
        try {
          const data = JSON.parse(event.data);
          onMessage?.(data, event.lastEventId);
        } catch {
          onMessage?.(event.data, event.lastEventId);
        }
      };

      eventSource.onerror = (error) => {
        if (isClosedManuallyRef.current) return;

        eventSource.close();
        eventSourceRef.current = null;
        onError?.(error);

        if (retryCountRef.current < maxRetries) {
          retryCountRef.current++;
          onReconnect?.(retryCountRef.current);
          
          // Exponential backoff with max of 30 seconds
          const delay = Math.min(retryDelay * Math.pow(1.5, retryCountRef.current - 1), 30000);
          retryTimeoutRef.current = setTimeout(createConnection, delay);
        } else {
          onMaxRetriesReached?.();
        }
      };
    };

    createConnection();
  }, [close, maxRetries, retryDelay, onOpen, onMessage, onError, onReconnect, onMaxRetriesReached]);

  const isConnected = useCallback(() => {
    return eventSourceRef.current?.readyState === EventSource.OPEN;
  }, []);

  // Clear stored event ID (useful when starting a fresh processing session)
  const clearStoredEventId = useCallback(() => {
    lastEventIdRef.current = null;
    if (sessionKey) {
      try {
        sessionStorage.removeItem(`sse_lastEventId_${sessionKey}`);
      } catch { /* sessionStorage not available */ }
    }
  }, [sessionKey]);

  useEffect(() => {
    return () => {
      isClosedManuallyRef.current = true;
      clearRetryTimeout();
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, [clearRetryTimeout]);

  return { connect, close, isConnected, getLastEventId, clearStoredEventId };
}
