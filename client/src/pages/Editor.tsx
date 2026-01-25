import { useState, useCallback, useRef, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Film, Sparkles, CheckCircle2, RotateCcw, Wand2, Edit3, Zap, AlertCircle, TrendingUp } from "lucide-react";
import { VideoUploader } from "@/components/VideoUploader";
import { PromptInput } from "@/components/PromptInput";
import { ProcessingStatus } from "@/components/ProcessingStatus";
import { VideoPreview } from "@/components/VideoPreview";
import { EditPlanPreview } from "@/components/EditPlanPreview";
import { StockMediaPreview } from "@/components/StockMediaPreview";
import { DownloadButton } from "@/components/DownloadButton";
import { ThemeToggle } from "@/components/ThemeToggle";
import { TranscriptEditor } from "@/components/TranscriptEditor";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import type {
  ProcessingStatus as ProcessingStatusType,
  EditPlan,
  StockMediaItem,
  TranscriptSegment,
  SemanticAnalysis,
} from "@shared/schema";

interface AiImageStats {
  applied: number;
  skipped: number;
  stockApplied?: number;
  totalOverlays?: number;
}

interface QualityInsights {
  hookStrength: number;
  pacingScore: number;
  engagementPrediction: number;
  recommendations: string[];
}

interface FillerSegment {
  start: number;
  end: number;
  word: string;
}

interface StructureAnalysis {
  introEnd?: number;
  mainStart?: number;
  mainEnd?: number;
  outroStart?: number;
}

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
  aiImageStats?: AiImageStats;
  transcript?: TranscriptSegment[];
  semanticAnalysis?: SemanticAnalysis;
  fillerSegments?: FillerSegment[];
  qualityInsights?: QualityInsights;
  structureAnalysis?: StructureAnalysis;
}

export interface EditOptions {
  addCaptions: boolean;
  addBroll: boolean;
  removeSilence: boolean;
  generateAiImages: boolean;
  addTransitions: boolean;
}

type EditMode = "ai" | "manual";

export default function Editor() {
  const { toast } = useToast();
  const [project, setProject] = useState<VideoProject | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [editMode, setEditMode] = useState<EditMode>("ai");
  const [editOptions, setEditOptions] = useState<EditOptions>({
    addCaptions: true,
    addBroll: true,
    removeSilence: true,
    generateAiImages: false,
    addTransitions: false,
  });
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      if (xhrRef.current) {
        xhrRef.current.abort();
      }
    };
  }, []);

  const xhrRef = useRef<XMLHttpRequest | null>(null);

  const handleUpload = useCallback(
    async (file: File) => {
      setIsUploading(true);
      setUploadProgress(0);

      try {
        const formData = new FormData();
        formData.append("video", file);

        const xhr = new XMLHttpRequest();
        xhrRef.current = xhr;

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
          xhr.onabort = () => reject(new Error("Upload cancelled"));
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
        xhrRef.current = null;
      }
    },
    [toast]
  );

  const handleCancelUpload = useCallback(() => {
    if (xhrRef.current) {
      xhrRef.current.abort();
      setIsUploading(false);
      setUploadProgress(0);
      xhrRef.current = null;
      toast({
        title: "Upload cancelled",
        description: "Your video upload has been stopped.",
      });
    }
  }, [toast]);

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
          generateAiImages: String(editOptions.generateAiImages),
          addTransitions: String(editOptions.addTransitions),
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
          } else if (data.type === "aiImageStats") {
            setProject((prev) =>
              prev ? { ...prev, aiImageStats: data } : null
            );
          } else if (data.type === "enhancedAnalysis") {
            setProject((prev) =>
              prev
                ? {
                    ...prev,
                    fillerSegments: data.fillerSegments,
                    qualityInsights: data.qualityInsights,
                    structureAnalysis: data.structureAnalysis,
                    semanticAnalysis: {
                      ...(prev.semanticAnalysis || {}),
                      hookMoments: data.hookMoments,
                      topicFlow: data.topicFlow,
                      structureAnalysis: data.structureAnalysis,
                      keyMoments: data.keyMoments,
                    } as SemanticAnalysis,
                  }
                : null
            );
          } else if (data.type === "transcript") {
            setProject((prev) =>
              prev ? { ...prev, transcript: data.transcript } : null
            );
          } else if (data.type === "complete") {
            setProject((prev) =>
              prev
                ? {
                    ...prev,
                    status: "completed",
                    outputPath: data.outputPath,
                    duration: data.duration,
                    aiImageStats: data.aiImageStats || prev.aiImageStats,
                  }
                : null
            );
            setPreviewUrl(data.outputPath);
            setIsProcessing(false);
            eventSource.close();
            eventSourceRef.current = null;

            toast({
              title: "Your video is ready!",
              description: data.aiImageStats 
                ? `Applied ${data.aiImageStats.applied} AI images to your video`
                : "Download your edited video below",
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

  const handleNewProject = useCallback(() => {
    setProject(null);
    setPreviewUrl(null);
    setCurrentTime(0);
    setEditMode("ai");
  }, []);

  const updateEditPlanMutation = useMutation({
    mutationFn: async ({ projectId, editPlan }: { projectId: number; editPlan: EditPlan }) => {
      const response = await apiRequest("PUT", `/api/videos/${projectId}/editplan`, { editPlan });
      return response.json();
    },
    onError: (error) => {
      toast({
        title: "Failed to save changes",
        description: error instanceof Error ? error.message : "Please try again",
        variant: "destructive",
      });
    },
  });

  const handleEditPlanChange = useCallback((updatedPlan: EditPlan) => {
    setProject((prev) => prev ? { ...prev, editPlan: updatedPlan } : null);
    if (project?.id) {
      updateEditPlanMutation.mutate({ projectId: project.id, editPlan: updatedPlan });
    }
  }, [project?.id, updateEditPlanMutation]);

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
          <div className="flex-1 rounded-lg overflow-hidden bg-black relative">
            <VideoPreview
              src={previewUrl || undefined}
              className="h-full"
              currentTime={currentTime}
              onTimeUpdate={handleTimeUpdate}
              onDurationChange={handleDurationChange}
            />
            {isProcessing && project?.status !== "pending" && project?.status !== "completed" && (
              <div className="absolute top-4 right-4 z-50">
                <Badge variant="secondary" className="bg-background/80 backdrop-blur-sm animate-pulse flex items-center gap-2 py-1.5 px-3">
                  <Sparkles className="h-3.5 w-3.5 text-primary" />
                  <span className="text-xs font-semibold">Processing...</span>
                </Badge>
              </div>
            )}
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
        <div className="w-full lg:w-[480px] border-t lg:border-t-0 lg:border-l bg-card/50 overflow-y-auto h-[50vh] lg:h-[calc(100vh-56px)]">
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
                    onCancel={handleCancelUpload}
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
                  aiImageStats={project.aiImageStats}
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

              {/* Quality Insights Card */}
              {project?.qualityInsights && (
                <Card data-testid="quality-insights-card">
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <TrendingUp className="h-4 w-4" />
                      Quality Insights
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Hook Strength</span>
                        <span className="font-medium">{project.qualityInsights.hookStrength}%</span>
                      </div>
                      <Progress 
                        value={project.qualityInsights.hookStrength} 
                        className="h-2"
                        data-testid="progress-hook-strength"
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Pacing Score</span>
                        <span className="font-medium">{project.qualityInsights.pacingScore}%</span>
                      </div>
                      <Progress 
                        value={project.qualityInsights.pacingScore} 
                        className="h-2"
                        data-testid="progress-pacing-score"
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Engagement Prediction</span>
                        <span className="font-medium">{project.qualityInsights.engagementPrediction}%</span>
                      </div>
                      <Progress 
                        value={project.qualityInsights.engagementPrediction} 
                        className="h-2"
                        data-testid="progress-engagement"
                      />
                    </div>
                    {project.fillerSegments && project.fillerSegments.length > 0 && (
                      <div className="flex items-center gap-2 pt-2">
                        <Badge variant="outline" className="border-yellow-500/60 text-yellow-700 dark:text-yellow-400">
                          <AlertCircle className="h-3 w-3 mr-1" />
                          {project.fillerSegments.length} filler words detected
                        </Badge>
                      </div>
                    )}
                    {project.qualityInsights.recommendations.length > 0 && (
                      <div className="pt-2 space-y-1">
                        <span className="text-xs text-muted-foreground">Recommendations:</span>
                        {project.qualityInsights.recommendations.slice(0, 3).map((rec, idx) => (
                          <p key={idx} className="text-xs text-muted-foreground flex items-start gap-1">
                            <Zap className="h-3 w-3 text-primary shrink-0 mt-0.5" />
                            {rec}
                          </p>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* Edit Mode Tabs */}
              {project?.editPlan && (
                <Tabs value={editMode} onValueChange={(v) => setEditMode(v as EditMode)}>
                  <TabsList className="grid w-full grid-cols-2" data-testid="edit-mode-tabs">
                    <TabsTrigger value="ai" className="gap-2" data-testid="tab-ai-mode">
                      <Wand2 className="h-3.5 w-3.5" />
                      AI Edit
                    </TabsTrigger>
                    <TabsTrigger value="manual" className="gap-2" data-testid="tab-manual-mode">
                      <Edit3 className="h-3.5 w-3.5" />
                      Manual Edit
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="ai" className="space-y-4 mt-4">
                    <EditPlanPreview
                      editPlan={project.editPlan}
                      isLoading={project.status === "planning"}
                    />
                    {project.stockMedia && project.stockMedia.length > 0 && (
                      <StockMediaPreview
                        stockMedia={project.stockMedia}
                        isLoading={project.status === "fetching_stock"}
                      />
                    )}
                  </TabsContent>
                  <TabsContent value="manual" className="mt-4">
                    <TranscriptEditor
                      transcript={project.transcript || []}
                      editPlan={project.editPlan}
                      onEditPlanChange={handleEditPlanChange}
                      semanticAnalysis={project.semanticAnalysis}
                      isLoading={project.status === "analyzing"}
                    />
                  </TabsContent>
                </Tabs>
              )}


              {/* Stock Media (when no tabs visible) */}
              {!project?.editPlan && project?.stockMedia && project.stockMedia.length > 0 && (
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
