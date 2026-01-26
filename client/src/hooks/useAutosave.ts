import { useState, useEffect, useRef, useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { ReviewData } from "@shared/schema";

interface UseAutosaveOptions {
  projectId: number;
  data: ReviewData | null;
  debounceMs?: number;
  enabled?: boolean;
}

interface UseAutosaveReturn {
  isSaving: boolean;
  lastSaved: Date | null;
  error: Error | null;
  saveNow: () => void;
}

export function useAutosave({
  projectId,
  data,
  debounceMs = 2000,
  enabled = true,
}: UseAutosaveOptions): UseAutosaveReturn {
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastDataRef = useRef<string>("");

  const mutation = useMutation({
    mutationFn: async (reviewData: ReviewData) => {
      await apiRequest("POST", `/api/videos/${projectId}/autosave`, {
        reviewData,
      });
    },
    onSuccess: () => {
      setLastSaved(new Date());
      setError(null);
    },
    onError: (err: Error) => {
      setError(err);
    },
  });

  const saveNow = useCallback(() => {
    if (data && enabled) {
      mutation.mutate(data);
    }
  }, [data, enabled, mutation]);

  useEffect(() => {
    if (!enabled || !data) return;

    const dataString = JSON.stringify(data);
    if (dataString === lastDataRef.current) return;
    lastDataRef.current = dataString;

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      mutation.mutate(data);
    }, debounceMs);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [data, debounceMs, enabled, mutation, projectId]);

  return {
    isSaving: mutation.isPending,
    lastSaved,
    error,
    saveNow,
  };
}
