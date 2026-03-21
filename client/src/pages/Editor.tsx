import { useState, useCallback, useRef, useEffect, lazy, Suspense } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRoute, useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { Film, Sparkles, CheckCircle2, RotateCcw, Wand2, Edit3, Zap, AlertCircle, TrendingUp, Loader2, Trash2, Clock } from "lucide-react";
import { VideoUploader } from "@/components/VideoUploader";
import { PromptInput } from "@/components/PromptInput";
import { ProcessingStatus } from "@/components/ProcessingStatus";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { VideoPreview } from "@/components/VideoPreview";
import { EditPlanPreview } from "@/components/EditPlanPreview";
import { StockMediaPreview } from "@/components/StockMediaPreview";
import { DownloadButton } from "@/components/DownloadButton";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ActivityLog } from "@/components/ActivityLog";
import { HistoryPanel } from "@/components/HistoryPanel";

// Lazy-load heavy panels to reduce initial bundle size
const ReviewPanel = lazy(() => import("@/components/ReviewPanel").then(m => ({ default: m.ReviewPanel })));
const TranscriptEditor = lazy(() => import("@/components/TranscriptEditor").then(m => ({ default: m.TranscriptEditor })));
const ChatCompanion = lazy(() => import("@/components/ChatCompanion").then(m => ({ default: m.ChatCompanion })));

// Loading fallback for lazy-loaded components
function PanelLoadingFallback() {
  return (
    <div className="flex items-center justify-center p-8">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { useRenderSSE } from "@/hooks/useRenderSSE";
import { cn } from "@/lib/utils";
import { CLIENT_CONFIG } from "@/lib/config";
import { debugLog, debugError } from "@/lib/debug";
import type {
  ProcessingStatus as ProcessingStatusType,
  EditPlan,
  StockMediaItem,
  TranscriptSegment,
  SemanticAnalysis,
  ReviewData,
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

interface ActivityItem {
  message: string;
  timestamp: number;
  details?: Record<string, unknown>;
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
  | "interrupted"
  | "unknown";

interface VideoProject {
  id: number;
  fileName: string;
  originalPath: string;
  outputPath?: string | null;
  prompt?: string | null;
  status: ProcessingStatusType;
  duration?: number | null;
  editPlan?: EditPlan | null;
  transcript?: TranscriptSegment[] | null;
  stockMedia?: StockMediaItem[] | null;
  reviewData?: ReviewData | null;
  errorMessage?: string | null;
  errorSuggestion?: string | null;
  errorType?: ErrorType | null;
  aiImageStats?: AiImageStats;
  semanticAnalysis?: SemanticAnalysis;
  fillerSegments?: FillerSegment[];
  qualityInsights?: QualityInsights;
  structureAnalysis?: StructureAnalysis;
}

export type QualityMode = "preview" | "balanced" | "quality";

export interface EditOptions {
  addCaptions: boolean;
  addBroll: boolean;
  removeSilence: boolean;
  generateAiImages: boolean;
  addTransitions: boolean;
  qualityMode: QualityMode;
}

type EditMode = "ai" | "manual";

export default function Editor() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [matchProject, params] = useRoute("/project/:id");
  const projectIdFromUrl = matchProject && params?.id ? parseInt(params.id, 10) : null;

  const [project, setProject] = useState<VideoProject | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [currentTime, setCurrentTime] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [editMode, setEditMode] = useState<EditMode>("ai");
  const [editOptions, setEditOptions] = useState<EditOptions>({
    addCaptions: true,
    addBroll: true,
    removeSilence: true,
    generateAiImages: false,
    addTransitions: false,
    qualityMode: "balanced",
  });
  const [reviewData, setReviewData] = useState<ReviewData | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [markedReviewed, setMarkedReviewed] = useState(false);
  const [sourceFilesDeleted, setSourceFilesDeleted] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const xhrRef = useRef<XMLHttpRequest | null>(null);

  // SSE reconnection constants from centralized config
  const MAX_RECONNECT_ATTEMPTS = CLIENT_CONFIG.sse.maxReconnectAttempts;
  const SSE_BASE_DELAY = CLIENT_CONFIG.sse.baseReconnectDelayMs;
  const SSE_BACKOFF_MULTIPLIER = CLIENT_CONFIG.sse.reconnectBackoffMultiplier;

  // Render SSE hook for cleaner connection management
  const renderSSE = useRenderSSE({
    onStatusUpdate: (status: ProcessingStatusType) => {
      setProject((prev) => prev ? { ...prev, status } : null);
    },
    onActivity: (activity) => {
      setActivities((prev) => {
        const updated = [...prev, activity];
        return updated.length > 100 ? updated.slice(-100) : updated;
      });
    },
    onComplete: (data) => {
      setProject((prev) => prev ? {
        ...prev,
        status: "completed",
        outputPath: data.outputPath,
        duration: data.duration,
        aiImageStats: data.aiImageStats as AiImageStats | undefined,
      } : null);
      setPreviewUrl(data.outputPath);
      setIsRendering(false);
      setReviewData(null);
      setActivities([]);
      toast({
        title: "Your video is ready!",
        description: "Download your edited video below",
      });
    },
    onError: (error, suggestion) => {
      setProject((prev) => prev ? {
        ...prev,
        status: "failed",
        errorMessage: error,
        errorSuggestion: suggestion,
      } : null);
      setIsRendering(false);
      setActivities([]);
      toast({
        title: "Rendering failed",
        description: error || "Please try again",
        variant: "destructive",
      });
    },
    onConnectionLost: () => {
      setIsRendering(false);
      toast({
        title: "Connection lost",
        description: "The server connection was interrupted. Please try again.",
        variant: "destructive",
      });
    },
  });

  // Load project from URL if project ID is present
  const { data: loadedProject, isLoading: isLoadingProject } = useQuery<VideoProject>({
    queryKey: ["/api/videos", projectIdFromUrl],
    queryFn: async () => {
      const response = await fetch(`/api/videos/${projectIdFromUrl}`);
      if (!response.ok) {
        throw new Error("Failed to load project");
      }
      return response.json();
    },
    enabled: !!projectIdFromUrl && !project,
  });

  // Set project from loaded data
  useEffect(() => {
    if (loadedProject && !project) {
      setProject(loadedProject);
      if (loadedProject.originalPath) {
        setPreviewUrl(loadedProject.originalPath);
      }
      if ((loadedProject as any).reviewedAt) setMarkedReviewed(true);
      if ((loadedProject as any).sourceFilesDeletedAt) setSourceFilesDeleted(true);
      // Load review data if in awaiting_review status
      if (loadedProject.status === "awaiting_review") {
        fetch(`/api/videos/${loadedProject.id}/review`)
          .then(res => res.json())
          .then(data => {
            if (data.reviewData) {
              setReviewData(data.reviewData);
            }
          })
          .catch(err => debugError("Editor", "Failed to load review data:", err));
      }
      // Auto-reconnect to rendering if project is mid-render using renderSSE hook
      if (loadedProject.status === "rendering") {
        debugLog("Editor", "Reconnecting to in-progress rendering...");
        setIsRendering(true);
        renderSSE.startRender(loadedProject.id, editOptions.qualityMode, true);
      }

      // Auto-reconnect to processing if project is in a processing state
      const processingStates = ["analyzing", "transcribing", "planning", "fetching_stock", "generating_ai_images"];
      if (processingStates.includes(loadedProject.status)) {
        debugLog("Editor", "Reconnecting to in-progress processing...");
        setIsProcessing(true);
        reconnectAttemptsRef.current = 0;

        const storedOptions = loadedProject.reviewData?.editOptions;
        const sessionKey = `sse_lastEventId_process_${loadedProject.id}`;

        const connectProcessSSE = (projectId: number) => {
          // Clear any pending reconnect timeout
          if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
          }

          const params = new URLSearchParams({
            prompt: loadedProject.prompt || "",
            addCaptions: String(storedOptions?.addCaptions ?? true),
            addBroll: String(storedOptions?.addBroll ?? true),
            removeSilence: String(storedOptions?.removeSilence ?? true),
            generateAiImages: String(storedOptions?.generateAiImages ?? false),
            addTransitions: String(storedOptions?.addTransitions ?? false),
            reconnect: "true",
          });

          const storedLastEventId = sessionStorage.getItem(sessionKey);
          if (storedLastEventId) {
            params.append("lastEventId", storedLastEventId);
          }

          const eventSource = new EventSource(
            `/api/videos/${projectId}/process?${params.toString()}`
          );
          eventSourceRef.current = eventSource;

          eventSource.onmessage = (event) => {
            reconnectAttemptsRef.current = 0; // Reset on successful message
            if (event.lastEventId) {
              sessionStorage.setItem(sessionKey, event.lastEventId);
            }
            const data = JSON.parse(event.data);

            if (data.type === "status") {
              setProject((prev) => prev ? { ...prev, status: data.status } : null);
            } else if (data.type === "activity") {
              setActivities((prev) => {
                const newActivity = { message: data.message, timestamp: data.timestamp };
                const updated = [...prev, newActivity];
                return updated.length > 100 ? updated.slice(-100) : updated;
              });
            } else if (data.type === "reviewReady") {
              setReviewData(data.reviewData);
              setProject((prev) => prev ? { ...prev, status: "awaiting_review" } : null);
              setIsProcessing(false);
              eventSource.close();
              eventSourceRef.current = null;
            } else if (data.type === "error") {
              setProject((prev) =>
                prev
                  ? {
                    ...prev,
                    status: "failed",
                    errorMessage: data.error,
                    errorSuggestion: data.suggestion,
                    errorType: data.errorType,
                  }
                  : null
              );
              setIsProcessing(false);
              eventSource.close();
              eventSourceRef.current = null;
            } else if (data.type === "editPlan") {
              setProject((prev) => prev ? { ...prev, editPlan: data.editPlan } : null);
            } else if (data.type === "stockMedia") {
              setProject((prev) => prev ? { ...prev, stockMedia: data.stockMedia } : null);
            } else if (data.type === "transcript") {
              setProject((prev) => prev ? { ...prev, transcript: data.transcript } : null);
            } else if (data.type === "staleRecovery") {
              debugLog("Editor", "Processing was interrupted:", data.message);
              setIsProcessing(false);
              // Set status to a visible failure state so UI shows recovery options
              setProject((prev) => prev ? {
                ...prev,
                status: "failed" as ProcessingStatusType,
                errorMessage: data.message,
                errorType: "interrupted" as ErrorType,
                errorSuggestion: data.hasTranscript
                  ? "Some progress was saved (transcript ready). Click 'Retry Processing' to continue."
                  : "Click 'Retry Processing' to start again."
              } : null);
              eventSource.close();
              eventSourceRef.current = null;
            }
          };

          eventSource.onerror = () => {
            debugLog("Editor", "Processing SSE connection lost, fetching current status...");
            eventSource.close();
            eventSourceRef.current = null;

            fetch(`/api/videos/${projectId}`)
              .then(res => res.json())
              .then(data => {
                setProject(data);
                if (data.status === "awaiting_review") {
                  setIsProcessing(false);
                  if (data.reviewData) {
                    setReviewData(data.reviewData);
                  }
                } else if (data.status === "completed") {
                  setIsProcessing(false);
                  if (data.outputPath) {
                    setPreviewUrl(data.outputPath);
                  }
                } else if (data.status === "failed") {
                  setIsProcessing(false);
                } else if (processingStates.includes(data.status)) {
                  // Check retry limit
                  if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
                    debugLog("Editor", "Max reconnection attempts reached");
                    setIsProcessing(false);
                    return;
                  }
                  // Still processing - reconnect with exponential backoff
                  reconnectAttemptsRef.current++;
                  const delay = Math.min(2000 * Math.pow(1.5, reconnectAttemptsRef.current - 1), 10000);
                  debugLog("Editor", `Reconnecting in ${delay}ms (attempt ${reconnectAttemptsRef.current}/${MAX_RECONNECT_ATTEMPTS})`);
                  reconnectTimeoutRef.current = setTimeout(() => {
                    connectProcessSSE(projectId);
                  }, delay);
                }
              })
              .catch(err => {
                debugError("Editor", "Failed to fetch project status:", err);
                setIsProcessing(false);
              });
          };
        };

        connectProcessSSE(loadedProject.id);
      }
    }
  }, [loadedProject, project]);

  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      if (xhrRef.current) {
        xhrRef.current.abort();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
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
              reject(new Error(xhr.statusText || "Upload failed"));
            }
          };
          xhr.onerror = () => reject(new Error("Upload failed. Check your internet connection."));
          xhr.onabort = () => reject(new Error("Upload cancelled"));
          xhr.ontimeout = () => reject(new Error("Upload timed out. Please try again."));
          xhr.open("POST", "/api/videos/upload");
          xhr.timeout = 30 * 60 * 1000; // 30 minutes for large files
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
        let errorMessage = "Please try again";
        let suggestion = "Check your file and internet connection";

        if (error instanceof Error) {
          errorMessage = error.message;
          if (error.message.toLowerCase().includes("size") || error.message.toLowerCase().includes("large")) {
            suggestion = "Try uploading a smaller video (under 1GB)";
          } else if (error.message.toLowerCase().includes("format") || error.message.toLowerCase().includes("type")) {
            suggestion = "Use MP4, MOV, or WebM format";
          } else if (error.message.toLowerCase().includes("network") || error.message.toLowerCase().includes("connection")) {
            suggestion = "Check your internet connection and try again";
          }
        }

        toast({
          title: "Upload failed",
          description: `${errorMessage}. ${suggestion}`,
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
      setActivities([]);

      // Clear any stored lastEventId for this project (starting fresh)
      const sessionKey = `sse_lastEventId_process_${project.id}`;
      sessionStorage.removeItem(sessionKey);

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
          // Store lastEventId for reconnection support
          if (event.lastEventId) {
            sessionStorage.setItem(sessionKey, event.lastEventId);
          }
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
          } else if (data.type === "aiImages") {
            // AI images generated notification - aiImageStats will have the full data
            debugLog("Editor", `Generated ${data.count} AI images`);
          } else if (data.type === "aiImagesError") {
            // AI image generation failed, continuing with stock media
            toast({
              title: "AI Image Generation",
              description: data.error || "AI images unavailable, using stock media",
              variant: "default",
            });
          } else if (data.type === "activity") {
            setActivities((prev) => {
              const newActivity = {
                message: data.message,
                timestamp: data.timestamp,
                details: data.details,
              };
              const updated = [...prev, newActivity];
              return updated.length > 100 ? updated.slice(-100) : updated;
            });
          } else if (data.type === "reviewReady") {
            setReviewData(data.reviewData);
            setProject((prev) =>
              prev ? { ...prev, status: "awaiting_review" } : null
            );
            setIsProcessing(false);
            eventSource.close();
            eventSourceRef.current = null;

            toast({
              title: "Review Your Edit Plan",
              description: "Analysis complete! Review and approve before rendering.",
            });
          } else if (data.type === "complete") {
            setActivities((prev) => [...prev, {
              message: "Processing complete! Your video is ready.",
              timestamp: Date.now(),
            }]);
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
                ? {
                  ...prev,
                  status: "failed",
                  errorMessage: data.error,
                  errorSuggestion: data.suggestion,
                  errorType: data.errorType,
                }
                : null
            );
            setIsProcessing(false);
            eventSource.close();
            eventSourceRef.current = null;

            toast({
              title: data.error || "Processing failed",
              description: data.suggestion || "Please try again",
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
    setReviewData(null);
    setActivities([]);
    setLocation("/");
  }, [setLocation]);

  const handleReviewApprove = useCallback(async (updatedReviewData: ReviewData) => {
    if (!project) return;

    setIsRendering(true);
    setActivities([]); // Clear activities from processing phase

    try {
      // First, approve the review with any user modifications
      await apiRequest("POST", `/api/videos/${project.id}/approve-review`, {
        reviewData: updatedReviewData,
      });

      // Close any existing SSE connections
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }

      // Use the useRenderSSE hook for cleaner SSE management
      renderSSE.startRender(project.id, editOptions.qualityMode);
    } catch (error) {
      setIsRendering(false);
      toast({
        title: "Rendering failed",
        description: error instanceof Error ? error.message : "Please try again",
        variant: "destructive",
      });
    }
  }, [project, toast, editOptions.qualityMode, renderSSE]);

  const handleReviewCancel = useCallback(() => {
    setReviewData(null);
    setProject((prev) => prev ? { ...prev, status: "pending" } : null);
    toast({
      title: "Review cancelled",
      description: "You can re-process the video with different settings",
    });
  }, [toast]);

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

  const markReviewedMutation = useMutation({
    mutationFn: async (projectId: number) => {
      const response = await apiRequest("POST", `/api/videos/${projectId}/mark-reviewed`);
      return response.json();
    },
    onSuccess: () => {
      setMarkedReviewed(true);
      toast({
        title: "Marked as done",
        description: "Source files will be deleted in 10 minutes to free up space.",
      });
    },
    onError: (error) => {
      toast({
        title: "Could not mark as done",
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

  const handleRetryProcessing = useCallback(async () => {
    if (!project) return;

    try {
      // First, call backend to reset project status in database
      await apiRequest("POST", `/api/videos/${project.id}/retry`, { stage: "all" });

      // Reset local state
      setProject((prev) => prev ? {
        ...prev,
        status: "pending",
        errorMessage: undefined,
        errorSuggestion: undefined,
        errorType: undefined,
      } : null);
      setActivities([]);
      setIsProcessing(true);
      setIsRendering(false); // Reset rendering state in case we're retrying from a failed render

      // Get stored edit options from reviewData or use defaults
      const storedOptions = project.reviewData?.editOptions || editOptions;

      // Restart processing SSE connection with same prompt
      const params = new URLSearchParams({
        prompt: project.prompt || "Edit my video",
        addCaptions: String(storedOptions.addCaptions ?? true),
        addBroll: String(storedOptions.addBroll ?? true),
        removeSilence: String(storedOptions.removeSilence ?? true),
        generateAiImages: String(storedOptions.generateAiImages ?? true),
        addTransitions: String(storedOptions.addTransitions ?? true),
      });

      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      // Clear any stored lastEventId for this project (starting fresh retry)
      const sessionKey = `sse_lastEventId_process_${project.id}`;
      sessionStorage.removeItem(sessionKey);

      const eventSource = new EventSource(`/api/videos/${project.id}/process?${params.toString()}`);
      eventSourceRef.current = eventSource;

      eventSource.onmessage = (event) => {
        // Store lastEventId for reconnection support
        if (event.lastEventId) {
          sessionStorage.setItem(sessionKey, event.lastEventId);
        }
        const data = JSON.parse(event.data);

        if (data.type === "status") {
          setProject((prev) => prev ? { ...prev, status: data.status } : null);
        } else if (data.type === "editPlan") {
          setProject((prev) => prev ? { ...prev, editPlan: data.editPlan } : null);
        } else if (data.type === "stockMedia") {
          setProject((prev) => prev ? { ...prev, stockMedia: data.stockMedia } : null);
        } else if (data.type === "aiImageStats") {
          setProject((prev) => prev ? { ...prev, aiImageStats: data } : null);
        } else if (data.type === "transcript") {
          setProject((prev) => prev ? { ...prev, transcript: data.transcript } : null);
        } else if (data.type === "reviewReady") {
          setReviewData(data.reviewData);
          setProject((prev) => prev ? { ...prev, status: "awaiting_review", reviewData: data.reviewData } : null);
        } else if (data.type === "activity") {
          setActivities((prev) => [...prev, { message: data.message, timestamp: Date.now() }]);
        } else if (data.type === "error") {
          setProject((prev) => prev ? {
            ...prev,
            status: "failed",
            errorMessage: data.message,
            errorSuggestion: data.suggestion,
            errorType: data.errorType,
          } : null);
          toast({ title: "Processing failed", description: data.message, variant: "destructive" });
        } else if (data.type === "complete") {
          eventSource.close();
        }
      };

      eventSource.onerror = () => {
        eventSource.close();
        setIsProcessing(false);
      };

    } catch (error) {
      debugError("Editor", "Failed to retry processing:", error);
      toast({
        title: "Retry failed",
        description: "Could not restart processing. Please try uploading a new video.",
        variant: "destructive",
      });
    }
  }, [project, editOptions, toast]);

  const handleTranscriptionRetryStart = useCallback(() => {
    if (!project) return;

    setActivities([]);

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const eventSource = new EventSource(`/api/videos/${project.id}/retry-transcription`);
    eventSourceRef.current = eventSource;

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === "status") {
        setProject((prev) => prev ? { ...prev, status: data.status } : null);
      } else if (data.type === "activity") {
        setActivities((prev) => {
          const newActivity = {
            message: data.message,
            timestamp: data.timestamp,
            details: data.details,
          };
          const updated = [...prev, newActivity];
          return updated.length > 100 ? updated.slice(-100) : updated;
        });
      } else if (data.type === "transcript") {
        setProject((prev) => prev ? { ...prev, transcript: data.transcript } : null);
      } else if (data.type === "complete") {
        setProject((prev) => prev ? {
          ...prev,
          status: "pending",
          transcript: data.transcript,
          errorMessage: undefined,
          errorSuggestion: undefined,
          errorType: undefined,
        } : null);
        eventSource.close();
        eventSourceRef.current = null;

        toast({
          title: "Transcription complete",
          description: "You can now process your video again",
        });
      } else if (data.type === "error") {
        setProject((prev) => prev ? {
          ...prev,
          status: "failed",
          errorMessage: data.error,
          errorSuggestion: data.suggestion,
        } : null);
        eventSource.close();
        eventSourceRef.current = null;

        toast({
          title: "Transcription failed",
          description: data.error || "Please try again",
          variant: "destructive",
        });
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
      eventSourceRef.current = null;

      toast({
        title: "Connection lost",
        description: "The server connection was interrupted. Please try again.",
        variant: "destructive",
      });
    };
  }, [project, toast]);

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

                <HistoryPanel
                  onViewProject={(projectId) => {
                    setLocation(`/project/${projectId}`);
                  }}
                  className="mt-4"
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

            {/* Processing Status - for non-failed states */}
            {project && project.status !== "pending" && project.status !== "completed" && project.status !== "awaiting_review" && project.status !== "failed" && (
              <div className="space-y-4">
                <ProcessingStatus
                  status={project.status}
                  error={project.errorMessage ?? undefined}
                  errorSuggestion={project.errorSuggestion ?? undefined}
                  errorType={project.errorType ?? undefined}
                  aiImageStats={project.aiImageStats}
                  transcriptSegments={project.transcript?.length}
                  scenesDetected={project.semanticAnalysis?.keyMoments?.length}
                  stockMediaCount={project.stockMedia?.length}
                  editActionsCount={project.editPlan?.actions?.length}
                />

                {/* Actions for interrupted projects */}
                {!isProcessing && !isRendering && (
                  <Card className="border-amber-500/50 bg-amber-500/5">
                    <CardContent className="p-4">
                      <div className="flex items-center gap-2 mb-3">
                        <AlertCircle className="h-4 w-4 text-amber-500" />
                        <span className="text-sm font-medium">Processing was interrupted</span>
                      </div>
                      <p className="text-xs text-muted-foreground mb-3">
                        Click 'Retry processing' to continue from where we left off, or start a new project.
                      </p>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={handleRetryProcessing}
                          data-testid="button-retry-stuck"
                        >
                          <RotateCcw className="h-4 w-4 mr-1" />
                          Retry Processing
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={handleNewProject}
                          data-testid="button-new-project"
                        >
                          New Project
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                )}
              </div>
            )}

            {/* Error Display with recovery buttons - for failed state */}
            {project && project.status === "failed" && (
              <ErrorDisplay
                projectId={project.id}
                errorMessage={project.errorMessage ?? undefined}
                errorSuggestion={project.errorSuggestion ?? undefined}
                errorType={project.errorType ?? undefined}
                onRetrySuccess={handleRetryProcessing}
                onTranscriptionRetryStart={handleTranscriptionRetryStart}
                onUploadNew={handleNewProject}
              />
            )}

            {/* AI Activity Log */}
            {(isProcessing || isRendering || activities.length > 0) && project?.status !== "completed" && project?.status !== "awaiting_review" && (
              <ActivityLog activities={activities} isProcessing={isProcessing || isRendering} />
            )}

            {/* AI Chat Companion - Shows during processing */}
            {project?.id && project?.status !== "pending" && project?.status !== "uploading" && (
              <Suspense fallback={<PanelLoadingFallback />}>
                <ChatCompanion projectId={project.id} />
              </Suspense>
            )}

            {/* Review Panel - User approval step */}
            {project?.status === "awaiting_review" && reviewData && project.id && (
              <Suspense fallback={<PanelLoadingFallback />}>
                <ReviewPanel
                  projectId={project.id}
                  reviewData={reviewData}
                  onApprove={handleReviewApprove}
                  onCancel={handleReviewCancel}
                  isLoading={isRendering}
                />
              </Suspense>
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
                    outputPath={project.outputPath ?? undefined}
                    isProcessing={false}
                    isComplete={true}
                  />
                  <div className="mt-4 pt-4 border-t border-border">
                    {sourceFilesDeleted ? (
                      <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground" data-testid="status-source-files-deleted">
                        <Trash2 className="h-4 w-4" />
                        <span>Source files deleted — rendered video kept</span>
                      </div>
                    ) : markedReviewed ? (
                      <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground" data-testid="status-deletion-pending">
                        <Clock className="h-4 w-4 animate-pulse" />
                        <span>Source files deleting in 10 minutes...</span>
                      </div>
                    ) : (
                      <div>
                        <p className="text-xs text-muted-foreground mb-2">
                          Done reviewing? Delete the source upload, B-roll &amp; AI images to free up space. Your rendered video stays.
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          data-testid="button-mark-reviewed"
                          onClick={() => project.id && markReviewedMutation.mutate(project.id)}
                          disabled={markReviewedMutation.isPending}
                          className="w-full text-muted-foreground hover:text-destructive hover:border-destructive"
                        >
                          {markReviewedMutation.isPending ? (
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4 mr-2" />
                          )}
                          Done — Clean Up Source Files
                        </Button>
                      </div>
                    )}
                  </div>
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
                  <Suspense fallback={<PanelLoadingFallback />}>
                    <TranscriptEditor
                      transcript={project.transcript || []}
                      editPlan={project.editPlan}
                      onEditPlanChange={handleEditPlanChange}
                      semanticAnalysis={project.semanticAnalysis}
                      isLoading={project.status === "analyzing"}
                      currentTime={currentTime}
                      onSeekTo={setCurrentTime}
                    />
                  </Suspense>
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
