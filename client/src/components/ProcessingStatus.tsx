import { Check, Loader2, Clock, AlertCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { ProcessingStatus as ProcessingStatusType } from "@shared/schema";

interface ProcessingStatusProps {
  status: ProcessingStatusType;
  currentStep?: string;
  progress?: number;
  error?: string;
}

const PROCESSING_STEPS = [
  { id: "uploading", label: "Uploading video", description: "Transferring file to server" },
  { id: "analyzing", label: "Analyzing video", description: "Extracting frames and detecting scenes" },
  { id: "transcribing", label: "Transcribing audio", description: "Converting speech to text" },
  { id: "planning", label: "Creating edit plan", description: "AI generating editing instructions" },
  { id: "fetching_stock", label: "Finding stock media", description: "Searching for relevant images and videos" },
  { id: "editing", label: "Applying edits", description: "Processing video with effects" },
  { id: "rendering", label: "Rendering output", description: "Generating final video file" },
];

export function ProcessingStatus({
  status,
  currentStep,
  progress = 0,
  error,
}: ProcessingStatusProps) {
  const getStepStatus = (stepId: string) => {
    const stepOrder = PROCESSING_STEPS.findIndex((s) => s.id === stepId);
    const currentOrder = PROCESSING_STEPS.findIndex((s) => s.id === status);

    if (status === "failed") {
      if (stepId === currentStep) return "error";
      if (stepOrder < currentOrder) return "completed";
      return "pending";
    }

    if (status === "completed") return "completed";
    if (stepOrder < currentOrder) return "completed";
    if (stepOrder === currentOrder) return "current";
    return "pending";
  };

  const overallProgress = (() => {
    if (status === "completed") return 100;
    if (status === "failed") return 0;
    const currentIndex = PROCESSING_STEPS.findIndex((s) => s.id === status);
    if (currentIndex === -1) return 0;
    const stepProgress = (currentIndex / PROCESSING_STEPS.length) * 100;
    const withinStepProgress = (progress / 100) * (100 / PROCESSING_STEPS.length);
    return Math.min(stepProgress + withinStepProgress, 100);
  })();

  if (status === "pending") {
    return null;
  }

  return (
    <Card className={cn(status === "failed" && "border-destructive")}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <span>Processing Progress</span>
          <span className="text-sm font-normal text-muted-foreground">
            {overallProgress.toFixed(0)}%
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Progress value={overallProgress} className="h-2" />

        <div className="space-y-3">
          {PROCESSING_STEPS.map((step) => {
            const stepStatus = getStepStatus(step.id);

            return (
              <div
                key={step.id}
                className={cn(
                  "flex items-start gap-3 p-2 rounded-md transition-colors",
                  stepStatus === "current" && "bg-primary/5",
                  stepStatus === "error" && "bg-destructive/5"
                )}
                data-testid={`status-step-${step.id}`}
              >
                <div className="mt-0.5">
                  {stepStatus === "completed" && (
                    <div className="h-5 w-5 rounded-full bg-secondary flex items-center justify-center">
                      <Check className="h-3 w-3 text-secondary-foreground" />
                    </div>
                  )}
                  {stepStatus === "current" && (
                    <div className="h-5 w-5 rounded-full bg-primary flex items-center justify-center processing-glow">
                      <Loader2 className="h-3 w-3 text-primary-foreground animate-spin" />
                    </div>
                  )}
                  {stepStatus === "pending" && (
                    <div className="h-5 w-5 rounded-full bg-muted flex items-center justify-center">
                      <Clock className="h-3 w-3 text-muted-foreground" />
                    </div>
                  )}
                  {stepStatus === "error" && (
                    <div className="h-5 w-5 rounded-full bg-destructive flex items-center justify-center">
                      <AlertCircle className="h-3 w-3 text-destructive-foreground" />
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p
                    className={cn(
                      "text-sm font-medium",
                      stepStatus === "pending" && "text-muted-foreground",
                      stepStatus === "error" && "text-destructive"
                    )}
                  >
                    {step.label}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {step.description}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        {error && (
          <div className="p-3 rounded-md bg-destructive/10 border border-destructive/20">
            <p className="text-sm text-destructive flex items-center gap-2">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              {error}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
