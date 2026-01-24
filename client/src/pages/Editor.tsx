import { useState, useCallback } from "react";
import { Film, Sparkles, Upload, CheckCircle2, ArrowRight } from "lucide-react";
import { VideoUploader } from "@/components/VideoUploader";
import { PromptInput } from "@/components/PromptInput";
import { ProcessingStatus } from "@/components/ProcessingStatus";
import { VideoPreview } from "@/components/VideoPreview";
import { Timeline } from "@/components/Timeline";
import { EditPlanPreview } from "@/components/EditPlanPreview";
import { StockMediaPreview } from "@/components/StockMediaPreview";
import { DownloadButton } from "@/components/DownloadButton";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import type {
  ProcessingStatus as ProcessingStatusType,
  EditPlan,
  StockMediaItem,
} from "@shared/schema";

interface VideoProject {
  id: number;
  fileName: string;
  originalPath: string;
  outputPath?: string;
  status: ProcessingStatusType;
  duration?: number;
  editPlan?: EditPlan;
  stockMedia?: StockMediaItem[];
  errorMessage?: string;
}

const WORKFLOW_STEPS = [
  { id: 1, label: "Upload", status: "pending" },
  { id: 2, label: "Describe", status: "pending" },
  { id: 3, label: "Process", status: "pending" },
  { id: 4, label: "Download", status: "pending" },
];

export default function Editor() {
  const { toast } = useToast();
  const [project, setProject] = useState<VideoProject | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const getCurrentStep = () => {
    if (!project) return 1;
    if (project.status === "pending") return 2;
    if (project.status === "completed") return 4;
    return 3;
  };

  const handleUpload = useCallback(
    async (file: File) => {
      setIsUploading(true);
      setUploadProgress(0);

      try {
        const formData = new FormData();
        formData.append("video", file);

        const xhr = new XMLHttpRequest();

        xhr.upload.addEventListener("progress", (e) => {
          if (e.lengthComputable) {
            const progress = (e.loaded / e.total) * 100;
            setUploadProgress(progress);
          }
        });

        const response = await new Promise<Response>((resolve, reject) => {
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve(new Response(xhr.responseText));
            } else {
              reject(new Error(xhr.statusText));
            }
          };
          xhr.onerror = () => reject(new Error("Upload failed"));
          xhr.open("POST", "/api/videos/upload");
          xhr.send(formData);
        });

        const data = await response.json();

        setProject({
          id: data.id,
          fileName: file.name,
          originalPath: data.originalPath,
          status: "pending",
          duration: data.duration,
        });

        setPreviewUrl(data.originalPath);

        toast({
          title: "Video uploaded!",
          description: "Now tell the AI how you want it edited",
        });
      } catch (error) {
        toast({
          title: "Upload failed",
          description: error instanceof Error ? error.message : "Please try again",
          variant: "destructive",
        });
      } finally {
        setIsUploading(false);
        setUploadProgress(0);
      }
    },
    [toast]
  );

  const handleProcessVideo = useCallback(
    async (prompt: string) => {
      if (!project) return;

      setIsProcessing(true);

      try {
        const eventSource = new EventSource(
          `/api/videos/${project.id}/process?prompt=${encodeURIComponent(prompt)}`
        );

        eventSource.onmessage = (event) => {
          const data = JSON.parse(event.data);

          if (data.type === "status") {
            setProject((prev) =>
              prev ? { ...prev, status: data.status } : null
            );
          } else if (data.type === "editPlan") {
            setProject((prev) =>
              prev ? { ...prev, editPlan: data.editPlan } : null
            );
          } else if (data.type === "stockMedia") {
            setProject((prev) =>
              prev ? { ...prev, stockMedia: data.stockMedia } : null
            );
          } else if (data.type === "complete") {
            setProject((prev) =>
              prev
                ? {
                    ...prev,
                    status: "completed",
                    outputPath: data.outputPath,
                    duration: data.duration,
                  }
                : null
            );
            setPreviewUrl(data.outputPath);
            setIsProcessing(false);
            eventSource.close();

            toast({
              title: "Your video is ready!",
              description: "Download your professionally edited video",
            });
          } else if (data.type === "error") {
            setProject((prev) =>
              prev
                ? { ...prev, status: "failed", errorMessage: data.error }
                : null
            );
            setIsProcessing(false);
            eventSource.close();

            toast({
              title: "Processing failed",
              description: data.error,
              variant: "destructive",
            });
          }
        };

        eventSource.onerror = () => {
          eventSource.close();
          setIsProcessing(false);
          toast({
            title: "Connection lost",
            description: "Please try again",
            variant: "destructive",
          });
        };
      } catch (error) {
        setIsProcessing(false);
        toast({
          title: "Processing failed",
          description:
            error instanceof Error ? error.message : "Please try again",
          variant: "destructive",
        });
      }
    },
    [project, toast]
  );

  const handleNewProject = () => {
    setProject(null);
    setPreviewUrl(null);
    setCurrentTime(0);
  };

  const handleTimeUpdate = useCallback((time: number) => {
    setCurrentTime(time);
  }, []);

  const handleSeek = useCallback((time: number) => {
    setCurrentTime(time);
  }, []);

  const handleDurationChange = useCallback((duration: number) => {
    setProject((prev) =>
      prev ? { ...prev, duration: Math.round(duration) } : null
    );
  }, []);

  const currentStep = getCurrentStep();

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex items-center justify-between h-16 px-6 gap-4">
          <div className="flex items-center gap-4">
            <div className="p-2.5 rounded-xl bg-gradient-to-br from-primary/20 to-accent/20 border border-primary/20">
              <Film className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h1 className="font-bold text-xl tracking-tight">AI Video Editor</h1>
              <p className="text-xs text-muted-foreground">
                Transform videos with AI magic
              </p>
            </div>
          </div>

          {/* Workflow Steps Indicator */}
          <div className="hidden md:flex items-center gap-2">
            {WORKFLOW_STEPS.map((step, index) => (
              <div key={step.id} className="flex items-center">
                <div
                  className={cn(
                    "flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-all",
                    currentStep === step.id
                      ? "bg-primary text-primary-foreground"
                      : currentStep > step.id
                      ? "bg-secondary text-secondary-foreground"
                      : "bg-muted text-muted-foreground"
                  )}
                >
                  {currentStep > step.id ? (
                    <CheckCircle2 className="h-4 w-4" />
                  ) : (
                    <span className="w-5 h-5 rounded-full bg-background/20 flex items-center justify-center text-xs">
                      {step.id}
                    </span>
                  )}
                  <span className="hidden lg:inline">{step.label}</span>
                </div>
                {index < WORKFLOW_STEPS.length - 1 && (
                  <ArrowRight className="h-4 w-4 mx-2 text-muted-foreground/50" />
                )}
              </div>
            ))}
          </div>

          <div className="flex items-center gap-3">
            {project && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleNewProject}
                className="gap-2"
                data-testid="button-new-project"
              >
                <Upload className="h-4 w-4" />
                <span className="hidden sm:inline">New Video</span>
              </Button>
            )}
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Video preview area - main content */}
        <div className="flex-1 flex flex-col p-6 gap-4 overflow-hidden">
          {/* Video preview */}
          <div className="flex-1 min-h-0 rounded-xl overflow-hidden bg-black/5 dark:bg-white/5">
            <VideoPreview
              src={previewUrl || undefined}
              className="h-full"
              currentTime={currentTime}
              onTimeUpdate={handleTimeUpdate}
              onDurationChange={handleDurationChange}
            />
          </div>

          {/* Timeline */}
          <Timeline
            duration={project?.duration || 0}
            editPlan={project?.editPlan}
            currentTime={currentTime}
            onSeek={handleSeek}
          />
        </div>

        {/* Side panel */}
        <aside className="w-96 lg:w-[420px] border-l bg-card/30 flex flex-col overflow-hidden">
          <ScrollArea className="flex-1">
            <div className="p-6 space-y-6">
              {!project ? (
                <>
                  {/* Welcome state */}
                  <div className="text-center py-6">
                    <div className="relative inline-block mb-6">
                      <div className="absolute inset-0 bg-primary/20 blur-xl rounded-full" />
                      <div className="relative p-5 rounded-2xl bg-gradient-to-br from-primary/10 to-accent/10 border border-primary/20">
                        <Sparkles className="h-10 w-10 text-primary" />
                      </div>
                    </div>
                    <h2 className="text-2xl font-bold mb-3">
                      AI-Powered Editing
                    </h2>
                    <p className="text-muted-foreground leading-relaxed">
                      Upload your video and describe how you want it edited.
                      Our AI will handle the rest automatically.
                    </p>
                  </div>

                  {/* Feature highlights */}
                  <div className="grid grid-cols-2 gap-3 mb-6">
                    {[
                      { icon: "✂️", label: "Smart Cuts" },
                      { icon: "📝", label: "Auto Captions" },
                      { icon: "🎬", label: "Stock B-Roll" },
                      { icon: "✨", label: "Transitions" },
                    ].map((feature) => (
                      <div
                        key={feature.label}
                        className="flex items-center gap-2 p-3 rounded-lg bg-muted/50 text-sm"
                      >
                        <span className="text-lg">{feature.icon}</span>
                        <span className="text-muted-foreground">{feature.label}</span>
                      </div>
                    ))}
                  </div>

                  <VideoUploader
                    onUpload={handleUpload}
                    isUploading={isUploading}
                    uploadProgress={uploadProgress}
                  />
                </>
              ) : (
                <>
                  {/* File info card */}
                  <Card className="overflow-hidden">
                    <div className="h-1 bg-gradient-to-r from-primary to-accent" />
                    <CardContent className="p-4">
                      <div className="flex items-center gap-4">
                        <div className="p-3 rounded-xl bg-primary/10">
                          <Film className="h-6 w-6 text-primary" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold truncate">
                            {project.fileName}
                          </p>
                          <div className="flex items-center gap-3 mt-1">
                            {project.duration && (
                              <Badge variant="secondary" className="text-xs">
                                {Math.floor(project.duration / 60)}:
                                {String(Math.floor(project.duration % 60)).padStart(2, "0")}
                              </Badge>
                            )}
                            <Badge
                              variant={
                                project.status === "completed"
                                  ? "default"
                                  : project.status === "failed"
                                  ? "destructive"
                                  : "outline"
                              }
                              className="text-xs capitalize"
                            >
                              {project.status === "pending"
                                ? "Ready"
                                : project.status.replace("_", " ")}
                            </Badge>
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  {/* Success state */}
                  {project.status === "completed" && (
                    <Card className="border-secondary/50 bg-secondary/5">
                      <CardContent className="p-6 text-center">
                        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-secondary/20 mb-4">
                          <CheckCircle2 className="h-8 w-8 text-secondary" />
                        </div>
                        <h3 className="text-xl font-bold mb-2">Video Ready!</h3>
                        <p className="text-muted-foreground text-sm mb-4">
                          Your edited video has been processed successfully
                        </p>
                        <DownloadButton
                          outputPath={project.outputPath}
                          isProcessing={isProcessing}
                          isComplete={project.status === "completed"}
                        />
                      </CardContent>
                    </Card>
                  )}

                  {/* Prompt input - only show when pending */}
                  {project.status === "pending" && (
                    <PromptInput
                      onSubmit={handleProcessVideo}
                      isProcessing={isProcessing}
                    />
                  )}

                  {/* Processing status */}
                  {project.status !== "pending" &&
                    project.status !== "completed" && (
                      <ProcessingStatus
                        status={project.status}
                        error={project.errorMessage}
                      />
                    )}

                  {/* Edit plan preview */}
                  {project.editPlan && (
                    <EditPlanPreview
                      editPlan={project.editPlan}
                      isLoading={project.status === "planning"}
                    />
                  )}

                  {/* Stock media preview */}
                  {project.stockMedia && project.stockMedia.length > 0 && (
                    <StockMediaPreview
                      stockMedia={project.stockMedia}
                      isLoading={project.status === "fetching_stock"}
                    />
                  )}

                  {/* Download button at bottom when not completed */}
                  {project.status !== "completed" && project.status !== "pending" && (
                    <DownloadButton
                      outputPath={project.outputPath}
                      isProcessing={isProcessing}
                      isComplete={false}
                    />
                  )}
                </>
              )}
            </div>
          </ScrollArea>
        </aside>
      </div>
    </div>
  );
}
