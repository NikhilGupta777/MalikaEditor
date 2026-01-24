import { Check, Loader2, AlertCircle, RotateCcw } from "lucide-react";
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

interface ProcessingStatusProps {
  status: ProcessingStatusType;
  error?: string;
  onRetry?: () => void;
  aiImageStats?: AiImageStats;
}

const STEPS = [
  { id: "analyzing", label: "Analyzing video" },
  { id: "transcribing", label: "Transcribing speech" },
  { id: "planning", label: "Creating edit plan" },
  { id: "fetching_stock", label: "Finding stock media" },
  { id: "generating_ai_images", label: "Generating AI images" },
  { id: "editing", label: "Applying edits" },
  { id: "rendering", label: "Rendering video" },
];

export function ProcessingStatus({ status, error, onRetry, aiImageStats }: ProcessingStatusProps) {
  if (status === "pending" || status === "completed") return null;

  const currentIndex = STEPS.findIndex(s => s.id === status);
  const progress = currentIndex >= 0 
    ? Math.round(((currentIndex + 0.5) / STEPS.length) * 100)
    : 0;

  const currentStep = STEPS.find(s => s.id === status);

  if (status === "failed") {
    return (
      <Card className="border-destructive">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-destructive flex-shrink-0" />
            <div className="flex-1">
              <p className="font-medium text-destructive">Processing failed</p>
              {error && (
                <p className="text-sm text-muted-foreground mt-1">{error}</p>
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
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            <span className="text-sm font-medium">
              {currentStep?.label || "Processing..."}
            </span>
          </div>
          <span className="text-xs text-muted-foreground">{progress}%</span>
        </div>
        
        <Progress value={progress} className="h-2" />
        
        {aiImageStats && (
          <div className="text-xs text-muted-foreground bg-muted/50 rounded p-2">
            AI Images: {aiImageStats.applied} applied
            {aiImageStats.skipped > 0 && `, ${aiImageStats.skipped} skipped`}
            {aiImageStats.stockApplied !== undefined && `, ${aiImageStats.stockApplied} stock clips`}
          </div>
        )}
        
        <div className="flex justify-between">
          {STEPS.map((step, i) => {
            const isCompleted = i < currentIndex;
            const isCurrent = i === currentIndex;
            
            return (
              <div
                key={step.id}
                className={cn(
                  "w-6 h-6 rounded-full flex items-center justify-center text-xs",
                  isCompleted && "bg-secondary text-secondary-foreground",
                  isCurrent && "bg-primary text-primary-foreground",
                  !isCompleted && !isCurrent && "bg-muted text-muted-foreground"
                )}
                title={step.label}
              >
                {isCompleted ? (
                  <Check className="h-3 w-3" />
                ) : (
                  i + 1
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
