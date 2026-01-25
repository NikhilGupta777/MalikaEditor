import { Check, Loader2, AlertCircle, RotateCcw, XCircle, Video, Brain, Mic, Wand2, Image, Film, Sparkles, PlayCircle, Upload, FileX, Wifi, Clock, Lock, Database, HelpCircle, Lightbulb } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ProcessingStatus as ProcessingStatusType } from "@shared/schema";

interface AiImageStats {
  applied: number;
  skipped: number;
  stockApplied?: number;
  totalOverlays?: number;
}

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
  | "unknown";

interface ProcessingStatusProps {
  status: ProcessingStatusType;
  error?: string;
  errorSuggestion?: string;
  errorType?: ErrorType;
  onRetry?: () => void;
  aiImageStats?: AiImageStats;
  transcriptSegments?: number;
  scenesDetected?: number;
  stockMediaCount?: number;
  editActionsCount?: number;
}

function getErrorIcon(errorType?: ErrorType) {
  switch (errorType) {
    case "upload_failed":
      return Upload;
    case "file_not_found":
      return FileX;
    case "video_processing":
      return Video;
    case "transcription":
      return Mic;
    case "ai_api":
      return Brain;
    case "rate_limit":
      return Clock;
    case "network":
      return Wifi;
    case "timeout":
      return Clock;
    case "permission":
      return Lock;
    case "storage":
      return Database;
    default:
      return AlertCircle;
  }
}

function getDefaultSuggestion(errorType?: ErrorType): string {
  switch (errorType) {
    case "upload_failed":
      return "Check your file size and format, then try again";
    case "file_not_found":
      return "Please upload your video again";
    case "video_processing":
      return "Try uploading a different video format (MP4 works best)";
    case "transcription":
      return "Make sure your video has clear audio";
    case "ai_api":
      return "Wait a moment and try again, or disable AI features";
    case "rate_limit":
      return "Please wait a few minutes before trying again";
    case "network":
      return "Check your internet connection and try again";
    case "timeout":
      return "Try a shorter video or check your connection";
    case "permission":
      return "Please try uploading again";
    case "storage":
      return "Try again later or contact support";
    default:
      return "Please try again. If the problem persists, try a different video";
  }
}

const STEPS = [
  { 
    id: "uploading", 
    label: "Uploading video",
    description: "Transferring your video to our servers...",
    icon: Video,
  },
  { 
    id: "analyzing", 
    label: "Analyzing video",
    description: "AI is watching your video to understand scenes, emotions, and key moments...",
    icon: Brain,
  },
  { 
    id: "transcribing", 
    label: "Transcribing speech",
    description: "Converting speech to text with precise timestamps...",
    icon: Mic,
  },
  { 
    id: "planning", 
    label: "Creating edit plan",
    description: "AI is deciding the best cuts, transitions, and B-roll placements...",
    icon: Wand2,
  },
  { 
    id: "fetching_stock", 
    label: "Finding stock media",
    description: "Searching for relevant B-roll footage to enhance your video...",
    icon: Image,
  },
  { 
    id: "generating_ai_images", 
    label: "Generating AI images",
    description: "Creating custom AI-generated images based on your content...",
    icon: Sparkles,
  },
  { 
    id: "editing", 
    label: "Applying edits",
    description: "Cutting, splicing, and adding overlays to your video...",
    icon: Film,
  },
  { 
    id: "rendering", 
    label: "Rendering video",
    description: "Encoding your final video with all effects applied...",
    icon: PlayCircle,
  },
];

export function ProcessingStatus({ 
  status, 
  error, 
  errorSuggestion,
  errorType,
  onRetry, 
  aiImageStats,
  transcriptSegments,
  scenesDetected,
  stockMediaCount,
  editActionsCount,
}: ProcessingStatusProps) {
  if (status === "pending" || status === "completed") return null;

  if (status === "cancelled") {
    return (
      <Card className="border-muted">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <XCircle className="h-5 w-5 text-muted-foreground flex-shrink-0" />
            <div className="flex-1">
              <p className="font-medium text-muted-foreground">Processing cancelled</p>
              <p className="text-sm text-muted-foreground mt-1">
                The video processing was cancelled. You can start a new processing request.
              </p>
              {onRetry && (
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={onRetry}
                  className="mt-3"
                  data-testid="button-retry-cancelled"
                >
                  <RotateCcw className="h-4 w-4 mr-2" />
                  Start Again
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const currentIndex = STEPS.findIndex(s => s.id === status);
  const progress = currentIndex >= 0 
    ? Math.round(((currentIndex + 0.5) / STEPS.length) * 100)
    : 0;

  const currentStep = STEPS.find(s => s.id === status);
  const CurrentIcon = currentStep?.icon || Loader2;

  if (status === "failed") {
    const ErrorIcon = getErrorIcon(errorType);
    const suggestion = errorSuggestion || getDefaultSuggestion(errorType);
    
    return (
      <Card className="border-destructive" data-testid="error-card">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-full bg-destructive/10 flex items-center justify-center flex-shrink-0">
              <ErrorIcon className="h-5 w-5 text-destructive" />
            </div>
            <div className="flex-1">
              <p className="font-medium text-destructive" data-testid="error-message">
                {error || "Processing failed"}
              </p>
              {suggestion && (
                <div className="flex items-start gap-2 mt-2 p-2 rounded-md bg-muted/50">
                  <Lightbulb className="h-4 w-4 text-primary flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-muted-foreground" data-testid="error-suggestion">
                    {suggestion}
                  </p>
                </div>
              )}
              {onRetry && (
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={onRetry}
                  className="mt-3"
                  data-testid="button-retry-processing"
                >
                  <RotateCcw className="h-4 w-4 mr-2" />
                  Try Again
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="processing-status">
      <CardContent className="p-4 space-y-4">
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
              <CurrentIcon className="h-5 w-5 text-primary animate-pulse" />
            </div>
            <div className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-background flex items-center justify-center">
              <Loader2 className="h-3 w-3 animate-spin text-primary" />
            </div>
          </div>
          <div className="flex-1">
            <div className="flex items-center justify-between">
              <span className="font-medium">
                {currentStep?.label || "Processing..."}
              </span>
              <span className="text-xs text-muted-foreground">{progress}%</span>
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">
              {currentStep?.description}
            </p>
          </div>
        </div>
        
        <Progress value={progress} className="h-2" />
        
        <div className="grid grid-cols-4 gap-2 text-xs">
          {scenesDetected !== undefined && scenesDetected > 0 && (
            <div className="bg-muted/50 rounded p-2 text-center" data-testid="stat-scenes">
              <div className="font-medium text-foreground">{scenesDetected}</div>
              <div className="text-muted-foreground">Scenes</div>
            </div>
          )}
          {transcriptSegments !== undefined && transcriptSegments > 0 && (
            <div className="bg-muted/50 rounded p-2 text-center" data-testid="stat-segments">
              <div className="font-medium text-foreground">{transcriptSegments}</div>
              <div className="text-muted-foreground">Segments</div>
            </div>
          )}
          {stockMediaCount !== undefined && stockMediaCount > 0 && (
            <div className="bg-muted/50 rounded p-2 text-center" data-testid="stat-stock">
              <div className="font-medium text-foreground">{stockMediaCount}</div>
              <div className="text-muted-foreground">B-roll</div>
            </div>
          )}
          {editActionsCount !== undefined && editActionsCount > 0 && (
            <div className="bg-muted/50 rounded p-2 text-center" data-testid="stat-actions">
              <div className="font-medium text-foreground">{editActionsCount}</div>
              <div className="text-muted-foreground">Edits</div>
            </div>
          )}
        </div>
        
        {aiImageStats && (
          <div className="text-xs text-muted-foreground bg-muted/50 rounded p-2 flex items-center gap-2">
            <Sparkles className="h-3 w-3" />
            <span>
              AI Images: {aiImageStats.applied} applied
              {aiImageStats.skipped > 0 && `, ${aiImageStats.skipped} skipped`}
              {aiImageStats.stockApplied !== undefined && `, ${aiImageStats.stockApplied} stock clips`}
            </span>
          </div>
        )}
        
        <div className="flex gap-1">
          {STEPS.map((step, i) => {
            const isCompleted = i < currentIndex;
            const isCurrent = i === currentIndex;
            const StepIcon = step.icon;
            
            return (
              <div
                key={step.id}
                className="flex-1 group relative"
                data-testid={`step-${step.id}`}
              >
                <div
                  className={cn(
                    "h-1.5 rounded-full transition-colors",
                    isCompleted && "bg-primary",
                    isCurrent && "bg-primary/50",
                    !isCompleted && !isCurrent && "bg-muted"
                  )}
                />
                <div className="absolute -top-8 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                  <div className="bg-popover border rounded px-2 py-1 text-xs whitespace-nowrap shadow-md">
                    <div className="flex items-center gap-1">
                      <StepIcon className="h-3 w-3" />
                      {step.label}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
