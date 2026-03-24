import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import {
  Plus, Trash2, Clock, Film, Loader2,
  CheckCircle, AlertCircle, Sparkles, Video,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface HistoryItem {
  id: number;
  title: string;
  status: string;
  duration?: number;
  createdAt: string;
  expiresAt: string;
  outputPath?: string;
}

interface ProjectSidebarProps {
  isOpen: boolean;
  activeProjectId: number | null;
  onViewProject: (projectId: number) => void;
  onNewProject: () => void;
  onClose: () => void;
}

function getStatusIcon(status: string) {
  switch (status) {
    case "completed":
      return <CheckCircle className="h-3.5 w-3.5 text-green-500" />;
    case "failed":
    case "cancelled":
      return <AlertCircle className="h-3.5 w-3.5 text-destructive" />;
    case "awaiting_review":
      return <Sparkles className="h-3.5 w-3.5 text-amber-500" />;
    case "rendering":
    case "processing":
    case "analyzing":
    case "transcribing":
    case "planning":
    case "fetching_stock":
    case "generating_ai_images":
      return <Loader2 className="h-3.5 w-3.5 text-primary animate-spin" />;
    default:
      return <Video className="h-3.5 w-3.5 text-muted-foreground" />;
  }
}

function getStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: "Pending",
    uploading: "Uploading",
    analyzing: "Analyzing",
    transcribing: "Transcribing",
    planning: "Planning",
    fetching_stock: "Fetching Media",
    selecting_media: "Selecting Media",
    generating_ai_images: "Generating Images",
    awaiting_review: "Awaiting Review",
    editing: "Editing",
    rendering: "Rendering",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
  };
  return labels[status] || status.replace(/_/g, " ");
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function formatTimeUntilExpiry(expiresAt: string): { text: string; isExpired: boolean } {
  const expiryDate = new Date(expiresAt);
  const now = new Date();
  const diffMs = expiryDate.getTime() - now.getTime();
  if (diffMs <= 0) return { text: "Expired", isExpired: true };
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  if (diffHours > 0) return { text: `${diffHours}h ${diffMinutes % 60}m left`, isExpired: false };
  return { text: `${diffMinutes}m left`, isExpired: false };
}

function truncateTitle(title: string, maxLen = 28): string {
  if (title.length <= maxLen) return title;
  const ext = title.lastIndexOf(".");
  if (ext > 0 && title.length - ext <= 5) {
    const name = title.substring(0, ext);
    const extension = title.substring(ext);
    if (name.length > maxLen - extension.length - 3) {
      return name.substring(0, maxLen - extension.length - 3) + "..." + extension;
    }
  }
  return title.substring(0, maxLen - 3) + "...";
}

export function ProjectSidebar({ isOpen, activeProjectId, onViewProject, onNewProject, onClose }: ProjectSidebarProps) {
  const { toast } = useToast();
  const [deleteProjectId, setDeleteProjectId] = useState<number | null>(null);

  const { data: history, isLoading } = useQuery<HistoryItem[]>({
    queryKey: ["/api/videos/history"],
    refetchInterval: 15000,
  });

  const deleteMutation = useMutation({
    mutationFn: async (projectId: number) => {
      await apiRequest("DELETE", `/api/videos/${projectId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/videos/history"] });
      toast({ title: "Project deleted" });
      setDeleteProjectId(null);
    },
    onError: (error) => {
      toast({
        title: "Delete failed",
        description: error instanceof Error ? error.message : "Could not delete project",
        variant: "destructive",
      });
    },
  });

  return (
    <>
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-40 lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={cn(
          "fixed top-0 left-0 z-50 h-full w-[280px] bg-card border-r flex flex-col",
          "transition-all duration-300 ease-in-out",
          "lg:relative lg:z-auto lg:translate-x-0 lg:shrink-0",
          isOpen
            ? "translate-x-0 lg:ml-0"
            : "-translate-x-full lg:ml-[-280px]"
        )}
      >
        <div className="flex items-center gap-2 p-4 border-b min-h-[57px]">
          <Film className="h-5 w-5 text-primary shrink-0" />
          <span className="font-bold text-sm whitespace-nowrap">MalikaEditor</span>
        </div>

        <div className="p-3">
          <Button
            onClick={() => { onNewProject(); onClose(); }}
            className="w-full gap-2"
            size="sm"
          >
            <Plus className="h-4 w-4" />
            New Project
          </Button>
        </div>

        <div className="px-3 pb-1">
          <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
            Recent Projects
          </span>
        </div>

        <ScrollArea className="flex-1 px-2">
          <div className="space-y-1 pb-4">
            {isLoading && (
              <>
                {[1, 2, 3].map(i => (
                  <div key={i} className="p-3 rounded-lg animate-pulse">
                    <div className="h-4 bg-muted rounded w-3/4 mb-2" />
                    <div className="h-3 bg-muted rounded w-1/2" />
                  </div>
                ))}
              </>
            )}

            {!isLoading && (!history || history.length === 0) && (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <Film className="h-8 w-8 mb-2 opacity-30" />
                <p className="text-xs">No projects yet</p>
              </div>
            )}

            {history?.map((item) => {
              const isActive = activeProjectId === item.id;
              const expiry = formatTimeUntilExpiry(item.expiresAt);

              return (
                <div
                  key={item.id}
                  className={cn(
                    "group relative rounded-lg px-3 py-2.5 cursor-pointer transition-colors",
                    isActive
                      ? "bg-primary/10 border border-primary/20"
                      : "hover:bg-muted/60"
                  )}
                  onClick={() => { if (!expiry.isExpired) { onViewProject(item.id); onClose(); } }}
                  data-testid={`sidebar-project-${item.id}`}
                >
                  <div className="flex items-start gap-2.5">
                    <div className="mt-0.5 shrink-0">
                      {getStatusIcon(item.status)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className={cn(
                        "text-sm font-medium truncate leading-tight",
                        expiry.isExpired && "text-muted-foreground line-through"
                      )} title={item.title}>
                        {truncateTitle(item.title)}
                      </p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-[11px] text-muted-foreground">
                          {formatRelativeTime(item.createdAt)}
                        </span>
                        {item.status !== "completed" && item.status !== "failed" && (
                          <Badge variant="outline" className="text-[9px] h-[18px] px-1.5 font-normal">
                            {getStatusLabel(item.status)}
                          </Badge>
                        )}
                      </div>
                      {expiry.isExpired && (
                        <span className="text-[10px] text-destructive">Expired</span>
                      )}
                      {!expiry.isExpired && item.status === "completed" && (
                        <div className="flex items-center gap-1 mt-0.5">
                          <Clock className="h-2.5 w-2.5 text-muted-foreground" />
                          <span className="text-[10px] text-muted-foreground">{expiry.text}</span>
                        </div>
                      )}
                    </div>

                    <button
                      className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-destructive/10 shrink-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteProjectId(item.id);
                      }}
                      title="Delete project"
                    >
                      <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>

        <AlertDialog
          open={deleteProjectId !== null}
          onOpenChange={(open) => !open && setDeleteProjectId(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Project?</AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently delete this project and all associated data. This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => { if (deleteProjectId !== null) deleteMutation.mutate(deleteProjectId); }}
                className="bg-destructive text-destructive-foreground"
              >
                {deleteMutation.isPending ? "Deleting..." : "Delete"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </aside>
    </>
  );
}
