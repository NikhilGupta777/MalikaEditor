import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { History, Trash2, Eye, Clock, AlertCircle, Film, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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

interface HistoryPanelProps {
  onViewProject?: (projectId: number) => void;
  className?: string;
}

function getStatusBadgeVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "completed":
      return "default";
    case "failed":
    case "cancelled":
      return "destructive";
    case "awaiting_review":
    case "processing":
    case "analyzing":
    case "transcribing":
    case "rendering":
      return "secondary";
    default:
      return "outline";
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

function formatTimeUntilExpiry(expiresAt: string): { text: string; isExpired: boolean } {
  const expiryDate = new Date(expiresAt);
  const now = new Date();
  const diffMs = expiryDate.getTime() - now.getTime();
  
  if (diffMs <= 0) {
    return { text: "Expired", isExpired: true };
  }
  
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  
  if (diffDays > 0) {
    return { text: `${diffDays}d ${diffHours % 24}h`, isExpired: false };
  } else if (diffHours > 0) {
    return { text: `${diffHours}h ${diffMinutes % 60}m`, isExpired: false };
  } else {
    return { text: `${diffMinutes}m`, isExpired: false };
  }
}

function formatCreatedDate(createdAt: string): string {
  const date = new Date(createdAt);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  
  if (diffDays === 0 && diffHours < 1) {
    return "Just now";
  } else if (diffDays === 0) {
    return `${diffHours}h ago`;
  } else if (diffDays === 1) {
    return "Yesterday";
  } else if (diffDays < 7) {
    return `${diffDays}d ago`;
  } else {
    return date.toLocaleDateString();
  }
}

function HistoryItemSkeleton() {
  return (
    <div className="p-3 rounded-lg border bg-card/50 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-5 w-16" />
      </div>
      <div className="flex items-center gap-3 text-xs">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-3 w-20" />
      </div>
      <div className="flex items-center gap-2 pt-1">
        <Skeleton className="h-8 w-16" />
        <Skeleton className="h-8 w-8" />
      </div>
    </div>
  );
}

export function HistoryPanel({ onViewProject, className }: HistoryPanelProps) {
  const { toast } = useToast();
  const [isOpen, setIsOpen] = useState(true);
  const [deleteProjectId, setDeleteProjectId] = useState<number | null>(null);

  const { data: history, isLoading, error } = useQuery<HistoryItem[]>({
    queryKey: ["/api/videos/history"],
    refetchInterval: 30000,
  });

  const deleteMutation = useMutation({
    mutationFn: async (projectId: number) => {
      await apiRequest("DELETE", `/api/videos/${projectId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/videos/history"] });
      toast({
        title: "Project deleted",
        description: "The video project has been removed",
      });
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

  const handleViewProject = (projectId: number) => {
    if (onViewProject) {
      onViewProject(projectId);
    }
  };

  const handleDeleteConfirm = () => {
    if (deleteProjectId !== null) {
      deleteMutation.mutate(deleteProjectId);
    }
  };

  if (error) {
    return (
      <Card className={cn("", className)}>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <History className="h-4 w-4" />
            Project History
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
            <AlertCircle className="h-8 w-8 mb-2" />
            <p className="text-sm">Failed to load history</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className={cn("", className)}>
      <Card>
        <CollapsibleTrigger asChild>
          <CardHeader className="pb-3 cursor-pointer hover-elevate rounded-t-xl" data-testid="button-history-toggle">
            <CardTitle className="text-sm font-medium flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <History className="h-4 w-4" />
                Project History
                {history && history.length > 0 && (
                  <Badge variant="secondary" className="ml-1 text-xs">
                    {history.length}
                  </Badge>
                )}
              </div>
              {isOpen ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
            </CardTitle>
          </CardHeader>
        </CollapsibleTrigger>
        
        <CollapsibleContent>
          <CardContent className="pt-0">
            {isLoading ? (
              <div className="space-y-3">
                <HistoryItemSkeleton />
                <HistoryItemSkeleton />
                <HistoryItemSkeleton />
              </div>
            ) : !history || history.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-muted-foreground" data-testid="text-empty-history">
                <Film className="h-10 w-10 mb-3 opacity-50" />
                <p className="text-sm font-medium">No projects yet</p>
                <p className="text-xs mt-1">Upload a video to get started</p>
              </div>
            ) : (
              <div className="space-y-3 max-h-[400px] overflow-y-auto pr-1">
                {history.map((item) => {
                  const expiry = formatTimeUntilExpiry(item.expiresAt);
                  return (
                    <div
                      key={item.id}
                      className="p-3 rounded-lg border bg-card/50 hover-elevate transition-all"
                      data-testid={`card-history-item-${item.id}`}
                    >
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <p 
                          className="text-sm font-medium truncate flex-1" 
                          title={item.title}
                          data-testid={`text-project-name-${item.id}`}
                        >
                          {item.title}
                        </p>
                        <Badge 
                          variant={getStatusBadgeVariant(item.status)}
                          className="shrink-0 text-xs"
                          data-testid={`badge-status-${item.id}`}
                        >
                          {getStatusLabel(item.status)}
                        </Badge>
                      </div>
                      
                      <div className="flex items-center gap-3 text-xs text-muted-foreground mb-2">
                        <span data-testid={`text-created-${item.id}`}>
                          {formatCreatedDate(item.createdAt)}
                        </span>
                        <span 
                          className={cn(
                            "flex items-center gap-1",
                            expiry.isExpired && "text-destructive"
                          )}
                          data-testid={`text-expiry-${item.id}`}
                        >
                          <Clock className="h-3 w-3" />
                          {expiry.text}
                        </span>
                      </div>
                      
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleViewProject(item.id)}
                          disabled={expiry.isExpired}
                          data-testid={`button-view-${item.id}`}
                        >
                          <Eye className="h-3.5 w-3.5 mr-1" />
                          View
                        </Button>
                        
                        <AlertDialog 
                          open={deleteProjectId === item.id} 
                          onOpenChange={(open) => !open && setDeleteProjectId(null)}
                        >
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => setDeleteProjectId(item.id)}
                              data-testid={`button-delete-${item.id}`}
                            >
                              <Trash2 className="h-4 w-4 text-muted-foreground" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete Project?</AlertDialogTitle>
                              <AlertDialogDescription>
                                This will permanently delete "{item.title}" and all associated data. 
                                This action cannot be undone.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel data-testid="button-delete-cancel">Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={handleDeleteConfirm}
                                className="bg-destructive text-destructive-foreground"
                                data-testid="button-delete-confirm"
                              >
                                {deleteMutation.isPending ? "Deleting..." : "Delete"}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
