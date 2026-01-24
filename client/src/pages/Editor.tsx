import { useState, useCallback, useEffect } from "react";
import { Film, Sparkles, Upload } from "lucide-react";
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
import { useToast } from "@/hooks/use-toast";
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

export default function Editor() {
  const { toast } = useToast();
  const [project, setProject] = useState<VideoProject | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

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
          title: "Video uploaded successfully",
          description: "Now add your editing instructions",
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
              title: "Video processed successfully!",
              description: "Your edited video is ready to download",
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

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex items-center justify-between h-14 px-4 gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Film className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h1 className="font-semibold text-lg leading-tight">AI Video Editor</h1>
              <p className="text-xs text-muted-foreground hidden sm:block">
                Intelligent video processing
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {project && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleNewProject}
                className="gap-2"
                data-testid="button-new-project"
              >
                <Upload className="h-4 w-4" />
                New Video
              </Button>
            )}
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Video preview area - main content */}
        <div className="flex-1 flex flex-col p-4 gap-4 overflow-hidden">
          {/* Video preview */}
          <div className="flex-1 min-h-0">
            <VideoPreview
              src={previewUrl || undefined}
              className="h-full"
            />
          </div>

          {/* Timeline */}
          <Timeline
            duration={project?.duration || 0}
            editPlan={project?.editPlan}
            currentTime={currentTime}
            onSeek={setCurrentTime}
          />
        </div>

        {/* Side panel */}
        <aside className="w-80 lg:w-96 border-l bg-card/50 flex flex-col overflow-hidden">
          <ScrollArea className="flex-1">
            <div className="p-4 space-y-4">
              {!project ? (
                <>
                  <div className="text-center py-4">
                    <div className="p-4 rounded-full bg-primary/10 inline-block mb-4">
                      <Sparkles className="h-8 w-8 text-primary" />
                    </div>
                    <h2 className="text-lg font-semibold mb-2">
                      AI-Powered Video Editing
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      Upload your video and let AI transform it based on your
                      instructions
                    </p>
                  </div>
                  <VideoUploader
                    onUpload={handleUpload}
                    isUploading={isUploading}
                    uploadProgress={uploadProgress}
                  />
                </>
              ) : (
                <>
                  {/* File info */}
                  <Card>
                    <CardContent className="p-4">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-primary/10">
                          <Film className="h-5 w-5 text-primary" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate text-sm">
                            {project.fileName}
                          </p>
                          {project.duration && (
                            <p className="text-xs text-muted-foreground">
                              Duration: {Math.floor(project.duration / 60)}:
                              {String(Math.floor(project.duration % 60)).padStart(2, "0")}
                            </p>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>

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
                  <EditPlanPreview
                    editPlan={project.editPlan || null}
                    isLoading={project.status === "planning"}
                  />

                  {/* Stock media preview */}
                  <StockMediaPreview
                    stockMedia={project.stockMedia || null}
                    isLoading={project.status === "fetching_stock"}
                  />

                  {/* Download button */}
                  <DownloadButton
                    outputPath={project.outputPath}
                    isProcessing={isProcessing}
                    isComplete={project.status === "completed"}
                  />
                </>
              )}
            </div>
          </ScrollArea>
        </aside>
      </div>
    </div>
  );
}
