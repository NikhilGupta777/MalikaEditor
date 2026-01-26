import { useQuery } from "@tanstack/react-query";
import type { ReviewData } from "@shared/schema";

interface AutosaveResponse {
  hasAutosave: boolean;
  reviewData?: ReviewData;
}

interface UseLoadAutosaveOptions {
  projectId: number;
  enabled?: boolean;
}

interface UseLoadAutosaveReturn {
  autosaveData: ReviewData | null;
  hasAutosave: boolean;
  isLoading: boolean;
  error: Error | null;
}

export function useLoadAutosave({
  projectId,
  enabled = true,
}: UseLoadAutosaveOptions): UseLoadAutosaveReturn {
  const query = useQuery<AutosaveResponse>({
    queryKey: ["/api/videos", projectId, "autosave"],
    enabled: enabled && projectId > 0,
    staleTime: 0,
    refetchOnMount: true,
  });

  return {
    autosaveData: query.data?.reviewData ?? null,
    hasAutosave: query.data?.hasAutosave ?? false,
    isLoading: query.isLoading,
    error: query.error as Error | null,
  };
}
