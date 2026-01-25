import { useRef, useCallback, useEffect } from "react";

interface SSEOptions {
  maxRetries?: number;
  retryDelay?: number;
  onOpen?: () => void;
  onMessage?: (data: unknown) => void;
  onError?: (error: Event) => void;
  onReconnect?: (attempt: number) => void;
  onMaxRetriesReached?: () => void;
}

interface SSEController {
  connect: (url: string) => void;
  close: () => void;
  isConnected: () => boolean;
}

export function useSSE(options: SSEOptions = {}): SSEController {
  const {
    maxRetries = 3,
    retryDelay = 2000,
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

  const connect = useCallback((url: string) => {
    close();
    isClosedManuallyRef.current = false;
    urlRef.current = url;
    retryCountRef.current = 0;

    const createConnection = () => {
      if (isClosedManuallyRef.current) return;

      const eventSource = new EventSource(url);
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        retryCountRef.current = 0;
        onOpen?.();
      };

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          onMessage?.(data);
        } catch {
          onMessage?.(event.data);
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
          
          const delay = retryDelay * Math.pow(1.5, retryCountRef.current - 1);
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

  useEffect(() => {
    return () => {
      isClosedManuallyRef.current = true;
      clearRetryTimeout();
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, [clearRetryTimeout]);

  return { connect, close, isConnected };
}
