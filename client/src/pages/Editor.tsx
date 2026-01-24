import { useState, useCallback, useRef, useEffect } from "react";
import { Film, Sparkles, Upload, CheckCircle2, RotateCcw } from "lucide-react";
import { VideoUploader } from "@/components/VideoUploader";
import { PromptInput } from "@/components/PromptInput";
import { ProcessingStatus } from "@/components/ProcessingStatus";
import { VideoPreview } from "@/components/VideoPreview";
import { EditPlanPreview } from "@/components/EditPlanPreview";
import { StockMediaPreview } from "@/components/StockMediaPreview";
import { DownloadButton } from "@/components/DownloadButton";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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

export interface EditOptions {
  addCaptions: boolean;
  addBroll: boolean;
  removeSilence: boolean;
}

export default function Editor() {
  const { toast } = useToast();
  const [project, setProject] = useState<VideoProject | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [editOptions, setEditOptions] = useState<EditOptions>({
    addCaptions: true,
    addBroll: true,
    removeSilence: true,
  });
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

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
          description: "Now describe how you want it edited",
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
        const params = new URLSearchParams({
          prompt,
          addCaptions: String(editOptions.addCaptions),
          addBroll: String(editOptions.addBroll),
          removeSilence: String(editOptions.removeSilence),
        });

        if (eventSourceRef.current) {
          eventSourceRef.current.close();
        }

        const eventSource = new EventSource(
          `/api/videos/${project.id}/process?${params.toString()}`
        );
        eventSourceRef.current = eventSource;

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
            eventSourceRef.current = null;

            toast({
              title: "Your video is ready!",
              description: "Download your edited video below",
            });
          } else if (data.type === "error") {
            setProject((prev) =>
              prev
                ? { ...prev, status: "failed", errorMessage: data.error }
                : null
            );
            setIsProcessing(false);
            eventSource.close();
            eventSourceRef.current = null;

            toast({
              title: "Processing failed",
              description: data.error,
              variant: "destructive",
            });
          }
        };

        eventSource.onerror = (error) => {
          eventSource.close();
          eventSourceRef.current = null;
          setIsProcessing(false);
          setProject((prev) =>
            prev
              ? { ...prev, status: "failed", errorMessage: "Connection lost. Please try again." }
              : null
          );
          toast({
            title: "Connection lost",
            description: "The server connection was interrupted. Please try again.",
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
    [project, editOptions, toast]
  );

  const handleNewProject = () => {
    setProject(null);
    setPreviewUrl(null);
    setCurrentTime(0);
  };

  const handleRetryProcessing = useCallback(() => {
    if (project) {
      setProject((prev) => prev ? { ...prev, status: "pending", errorMessage: undefined } : null);
    }
  }, [project]);

  const handleTimeUpdate = useCallback((time: number) => {
    setCurrentTime(time);
  }, []);

  const handleDurationChange = useCallback((duration: number) => {
    setProject((prev) =>
      prev ? { ...prev, duration: Math.round(duration) } : null
    );
  }, []);

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = String(Math.floor(seconds % 60)).padStart(2, "0");
    return `${mins}:${secs}`;
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Simple Header */}
      <header className="border-b bg-card">
        <div className="flex items-center justify-between h-14 px-4">
          <div className="flex items-center gap-3">
            <Film className="h-6 w-6 text-primary" />
            <span className="font-bold text-lg">AI Video Editor</span>
          </div>
          <div className="flex items-center gap-2">
            {project && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleNewProject}
                data-testid="button-new-project"
              >
                <RotateCcw className="h-4 w-4 mr-2" />
                Start Over
              </Button>
            )}
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 flex flex-col lg:flex-row">
        {/* Video Preview - Left/Top */}
        <div className="flex-1 p-4 flex flex-col min-h-[300px] lg:min-h-0">
          <div className="flex-1 rounded-lg overflow-hidden bg-black">
            <VideoPreview
              src={previewUrl || undefined}
              className="h-full"
              currentTime={currentTime}
              onTimeUpdate={handleTimeUpdate}
              onDurationChange={handleDurationChange}
            />
          </div>
          
          {/* Video info bar */}
          {project && (
            <div className="flex items-center justify-between mt-3 px-1">
              <div className="flex items-center gap-2">
                <Badge variant="outline">{project.fileName}</Badge>
                {project.duration && (
                  <Badge variant="secondary">{formatDuration(project.duration)}</Badge>
                )}
              </div>
              <Badge 
                variant={project.status === "completed" ? "default" : "outline"}
                className="capitalize"
              >
                {project.status === "pending" ? "Ready" : project.status.replace("_", " ")}
              </Badge>
            </div>
          )}
        </div>

        {/* Control Panel - Right/Bottom */}
        <div className="w-full lg:w-[380px] border-t lg:border-t-0 lg:border-l bg-card/50 overflow-y-auto h-[50vh] lg:h-[calc(100vh-56px)]">
            <div className="p-4 space-y-4">
              
              {/* Step 1: Upload */}
              {!project && (
                <div className="space-y-4">
                  <div className="text-center py-4">
                    <Sparkles className="h-10 w-10 text-primary mx-auto mb-3" />
                    <h2 className="text-xl font-bold mb-1">AI Video Editing</h2>
                    <p className="text-sm text-muted-foreground">
                      Upload your video and let AI do the editing
                    </p>
                  </div>
                  
                  <VideoUploader
                    onUpload={handleUpload}
                    isUploading={isUploading}
                    uploadProgress={uploadProgress}
                  />
                </div>
              )}

              {/* Step 2: Configure & Process */}
              {project && project.status === "pending" && (
                <PromptInput
                  onSubmit={handleProcessVideo}
                  isProcessing={isProcessing}
                  editOptions={editOptions}
                  onEditOptionsChange={setEditOptions}
                />
              )}

              {/* Processing Status */}
              {project && project.status !== "pending" && project.status !== "completed" && (
                <ProcessingStatus
                  status={project.status}
                  error={project.errorMessage}
                  onRetry={project.status === "failed" ? handleRetryProcessing : undefined}
                />
              )}

              {/* Completed */}
              {project?.status === "completed" && (
                <Card className="border-secondary bg-secondary/5">
                  <CardContent className="p-4 text-center">
                    <CheckCircle2 className="h-12 w-12 text-secondary mx-auto mb-3" />
                    <h3 className="text-lg font-bold mb-1">Video Ready!</h3>
                    <p className="text-sm text-muted-foreground mb-4">
                      Your edited video is ready to download
                    </p>
                    <DownloadButton
                      outputPath={project.outputPath}
                      isProcessing={false}
                      isComplete={true}
                    />
                  </CardContent>
                </Card>
              )}

              {/* Edit Plan Summary */}
              {project?.editPlan && (
                <EditPlanPreview
                  editPlan={project.editPlan}
                  isLoading={project.status === "planning"}
                />
              )}

              {/* Stock Media */}
              {project?.stockMedia && project.stockMedia.length > 0 && (
                <StockMediaPreview
                  stockMedia={project.stockMedia}
                  isLoading={project.status === "fetching_stock"}
                />
              )}
            </div>
        </div>
      </div>
    </div>
  );
}
