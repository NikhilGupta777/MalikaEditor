import { Check, Loader2, AlertCircle } from "lucide-react";
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
  { id: "uploading", label: "Uploading", icon: "📤" },
  { id: "analyzing", label: "Analyzing Video", icon: "🔍" },
  { id: "transcribing", label: "Transcribing Speech", icon: "🎤" },
  { id: "planning", label: "Creating Edit Plan", icon: "📋" },
  { id: "fetching_stock", label: "Finding Stock Media", icon: "🎬" },
  { id: "editing", label: "Applying Edits", icon: "✂️" },
  { id: "rendering", label: "Rendering Video", icon: "🎥" },
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
    const stepProgress = ((currentIndex + 0.5) / PROCESSING_STEPS.length) * 100;
    return Math.min(stepProgress, 100);
  })();

  const currentStepInfo = PROCESSING_STEPS.find((s) => s.id === status);

  if (status === "pending") {
    return null;
  }

  return (
    <Card className={cn(status === "failed" && "border-destructive")}>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="text-2xl">{currentStepInfo?.icon || "⚙️"}</div>
            <div>
              <span className="block text-base">
                {currentStepInfo?.label || "Processing"}
              </span>
              <span className="text-sm font-normal text-muted-foreground">
                {Math.round(overallProgress)}% complete
              </span>
            </div>
          </div>
          <div className="w-12 h-12 rounded-full border-4 border-muted flex items-center justify-center relative">
            <div
              className="absolute inset-0 rounded-full"
              style={{
                background: `conic-gradient(hsl(var(--primary)) ${overallProgress}%, transparent ${overallProgress}%)`,
              }}
            />
            <div className="absolute inset-1 rounded-full bg-card flex items-center justify-center">
              <span className="text-xs font-bold">{Math.round(overallProgress)}%</span>
            </div>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Progress value={overallProgress} className="h-2" />

        <div className="grid grid-cols-7 gap-1">
          {PROCESSING_STEPS.map((step) => {
            const stepStatus = getStepStatus(step.id);

            return (
              <div
                key={step.id}
                className="flex flex-col items-center"
                title={step.label}
                data-testid={`status-step-${step.id}`}
              >
                <div
                  className={cn(
                    "w-8 h-8 rounded-full flex items-center justify-center text-sm transition-all",
                    stepStatus === "completed" && "bg-secondary",
                    stepStatus === "current" && "bg-primary animate-pulse",
                    stepStatus === "pending" && "bg-muted",
                    stepStatus === "error" && "bg-destructive"
                  )}
                >
                  {stepStatus === "completed" ? (
                    <Check className="h-4 w-4 text-secondary-foreground" />
                  ) : stepStatus === "current" ? (
                    <Loader2 className="h-4 w-4 text-primary-foreground animate-spin" />
                  ) : stepStatus === "error" ? (
                    <AlertCircle className="h-4 w-4 text-destructive-foreground" />
                  ) : (
                    <span className="opacity-50">{step.icon}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {error && (
          <div className="p-4 rounded-lg bg-destructive/10 border border-destructive/20">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-destructive">Processing Failed</p>
                <p className="text-sm text-destructive/80 mt-1">{error}</p>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
