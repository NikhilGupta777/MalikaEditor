import { RotateCcw, Upload, Mic, AlertCircle, Lightbulb, Loader2, Copy, Check } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useState, useCallback } from "react";

type ErrorType = 
  | "upload_failed"
  | "file_not_found"
  | "video_processing"
  | "transcription"
  | "ai_api"
  | "rate_limit"
  | "network"
  | "timeout"
  | "permission"
  | "storage"
  | "interrupted"
  | "unknown";

interface ErrorDisplayProps {
  projectId: number;
  errorMessage?: string;
  errorSuggestion?: string;
  errorType?: ErrorType;
  onRetrySuccess: () => void;
  onTranscriptionRetryStart: () => void;
  onUploadNew: () => void;
}

export function ErrorDisplay({
  projectId,
  errorMessage,
  errorSuggestion,
  errorType,
  onRetrySuccess,
  onTranscriptionRetryStart,
  onUploadNew,
}: ErrorDisplayProps) {
  const [copied, setCopied] = useState(false);
  
  // Copy a safe, non-sensitive error message for support
  const copyErrorForSupport = useCallback(() => {
    const safeErrorMessage = [
      `Error Type: ${errorType || "unknown"}`,
      `Message: ${errorMessage || "Processing failed"}`,
      `Suggestion: ${errorSuggestion || "Please try again"}`,
      `Project ID: ${projectId}`,
      `Timestamp: ${new Date().toISOString()}`,
    ].join("\n");
    
    navigator.clipboard.writeText(safeErrorMessage).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [errorType, errorMessage, errorSuggestion, projectId]);
  
  const retryMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", `/api/videos/${projectId}/retry`);
      return response.json();
    },
    onSuccess: () => {
      onRetrySuccess();
    },
  });

  const retryTranscriptionMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", `/api/videos/${projectId}/retry-transcription`);
      return response.json();
    },
    onSuccess: () => {
      onTranscriptionRetryStart();
    },
  });

  const isTranscriptionError = errorType === "transcription" || 
    errorMessage?.toLowerCase().includes("transcri") ||
    errorMessage?.toLowerCase().includes("speech") ||
    errorMessage?.toLowerCase().includes("audio");

  const isRetrying = retryMutation.isPending || retryTranscriptionMutation.isPending;

  return (
    <Card 
      className="border-destructive" 
      data-testid="error-display"
      role="alert"
      aria-live="polite"
      aria-labelledby="error-title"
    >
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div 
            className="w-10 h-10 rounded-full bg-destructive/10 flex items-center justify-center flex-shrink-0"
            aria-hidden="true"
          >
            <AlertCircle className="h-5 w-5 text-destructive" />
          </div>
          <div className="flex-1">
            <p className="font-medium text-destructive" data-testid="error-message">
              {errorMessage || "Processing failed"}
            </p>
            {errorSuggestion && (
              <div className="flex items-start gap-2 mt-2 p-2 rounded-md bg-muted/50">
                <Lightbulb className="h-4 w-4 text-primary flex-shrink-0 mt-0.5" />
                <p className="text-sm text-muted-foreground" data-testid="error-suggestion">
                  {errorSuggestion}
                </p>
              </div>
            )}
            
            <div className="flex flex-wrap items-center gap-2 mt-4">
              <Button
                onClick={() => retryMutation.mutate()}
                disabled={isRetrying}
                data-testid="button-retry-processing"
              >
                {retryMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <RotateCcw className="h-4 w-4 mr-2" />
                )}
                Retry Processing
              </Button>

              {isTranscriptionError && (
                <Button
                  variant="outline"
                  onClick={() => retryTranscriptionMutation.mutate()}
                  disabled={isRetrying}
                  data-testid="button-retry-transcription"
                >
                  {retryTranscriptionMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Mic className="h-4 w-4 mr-2" />
                  )}
                  Re-run Transcription
                </Button>
              )}

              <Button
                variant="outline"
                onClick={onUploadNew}
                disabled={isRetrying}
                data-testid="button-upload-new"
              >
                <Upload className="h-4 w-4 mr-2" />
                Upload New Video
              </Button>
              
              <Button
                variant="ghost"
                size="sm"
                onClick={copyErrorForSupport}
                className="ml-auto"
                data-testid="button-copy-error"
                aria-label="Copy error details for support"
              >
                {copied ? (
                  <>
                    <Check className="h-4 w-4 mr-1" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4 mr-1" />
                    Copy for Support
                  </>
                )}
              </Button>
            </div>

            {(retryMutation.isError || retryTranscriptionMutation.isError) && (
              <p className="text-sm text-destructive mt-2" data-testid="retry-error">
                {retryMutation.error?.message || retryTranscriptionMutation.error?.message || "Retry failed. Please try again."}
              </p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
