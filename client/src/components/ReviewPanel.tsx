import { useState, useCallback, useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { 
  Check, 
  X, 
  Play, 
  Clock, 
  Scissors, 
  Image, 
  Video, 
  Sparkles,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Timer,
  Cloud,
  Loader2
} from "lucide-react";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";
import { useAutosave } from "@/hooks/useAutosave";
import { useLoadAutosave } from "@/hooks/useLoadAutosave";
import type { ReviewData, ReviewMediaItem, ReviewEditAction, ReviewTranscriptSegment } from "@shared/schema";

interface ReviewPanelProps {
  projectId: number;
  reviewData: ReviewData;
  onApprove: (updatedReviewData: ReviewData) => void;
  onCancel: () => void;
  isLoading?: boolean;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function getActionIcon(type: string) {
  switch (type) {
    case 'cut': return <Scissors className="h-4 w-4 text-destructive" />;
    case 'keep': return <Check className="h-4 w-4 text-green-500" />;
    case 'insert_stock': return <Video className="h-4 w-4 text-blue-500" />;
    case 'insert_ai_image': return <Sparkles className="h-4 w-4 text-purple-500" />;
    default: return <Play className="h-4 w-4" />;
  }
}

function getActionLabel(type: string) {
  switch (type) {
    case 'cut': return 'Cut';
    case 'keep': return 'Keep';
    case 'insert_stock': return 'B-Roll';
    case 'insert_ai_image': return 'AI Image';
    case 'add_caption': return 'Caption';
    case 'transition': return 'Transition';
    default: return type;
  }
}

const AUTO_ACCEPT_SECONDS = 120; // 2 minutes

function formatLastSaved(date: Date): string {
  const now = new Date();
  const diffSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (diffSeconds < 5) return "Just now";
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ReviewPanel({ projectId, reviewData, onApprove, onCancel, isLoading }: ReviewPanelProps) {
  const [localReviewData, setLocalReviewData] = useState<ReviewData>(reviewData);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    transcript: true,
    editPlan: true,
    media: true,
  });
  const [timeRemaining, setTimeRemaining] = useState(AUTO_ACCEPT_SECONDS);
  const [userHasInteracted, setUserHasInteracted] = useState(false);
  const [hasHydratedAutosave, setHasHydratedAutosave] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const hasAutoApprovedRef = useRef(false);
  
  // Keep a ref to the latest reviewData to avoid stale closure in timer
  const latestReviewDataRef = useRef<ReviewData>(localReviewData);
  useEffect(() => {
    latestReviewDataRef.current = localReviewData;
  }, [localReviewData]);

  // Load autosave data on mount
  const { autosaveData, hasAutosave, isLoading: isLoadingAutosave } = useLoadAutosave({
    projectId,
    enabled: !hasHydratedAutosave,
  });

  // Hydrate local state from autosave if available (only if user hasn't started interacting)
  useEffect(() => {
    if (!hasHydratedAutosave && hasAutosave && autosaveData && !userHasInteracted) {
      setLocalReviewData(autosaveData);
      setHasHydratedAutosave(true);
    } else if (!hasHydratedAutosave && !isLoadingAutosave) {
      setHasHydratedAutosave(true);
    }
  }, [hasAutosave, autosaveData, hasHydratedAutosave, isLoadingAutosave, userHasInteracted]);

  // Autosave when localReviewData changes (only after initial hydration)
  const { isSaving, lastSaved, error: autosaveError } = useAutosave({
    projectId,
    data: localReviewData,
    debounceMs: 2000,
    enabled: hasHydratedAutosave && userHasInteracted,
  });

  // Mutation to delete autosave after approval
  const deleteAutosaveMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/videos/${projectId}/autosave`);
    },
  });

  // Auto-accept timer countdown
  useEffect(() => {
    if (isLoading || hasAutoApprovedRef.current) return;

    timerRef.current = setInterval(() => {
      setTimeRemaining(prev => {
        if (prev <= 1) {
          // Timer expired - auto-approve with latest data from ref
          if (!hasAutoApprovedRef.current) {
            hasAutoApprovedRef.current = true;
            // Delete autosave before auto-approving (same as manual approve)
            apiRequest("DELETE", `/api/videos/${projectId}/autosave`).catch(() => {
              // Ignore autosave deletion errors during auto-approve
            });
            onApprove({ ...latestReviewDataRef.current, userApproved: true });
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [isLoading, onApprove]);

  // Reset timer when user interacts (any checkbox toggle or text edit)
  // This gives user another 2 minutes from their last action
  const resetTimer = useCallback(() => {
    setUserHasInteracted(true);
    setTimeRemaining(AUTO_ACCEPT_SECONDS);
  }, []);

  const formatCountdown = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const timerProgress = (timeRemaining / AUTO_ACCEPT_SECONDS) * 100;

  const toggleSection = (section: string) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const toggleActionApproval = useCallback((actionId: string) => {
    resetTimer();
    setLocalReviewData(prev => ({
      ...prev,
      editPlan: {
        ...prev.editPlan,
        actions: prev.editPlan.actions.map(action =>
          action.id === actionId ? { ...action, approved: !action.approved } : action
        ),
      },
    }));
  }, [resetTimer]);

  const toggleMediaApproval = useCallback((mediaId: string, isAiImage: boolean) => {
    resetTimer();
    setLocalReviewData(prev => ({
      ...prev,
      [isAiImage ? 'aiImages' : 'stockMedia']: (isAiImage ? prev.aiImages : prev.stockMedia).map(media =>
        media.id === mediaId ? { ...media, approved: !media.approved } : media
      ),
    }));
  }, [resetTimer]);

  const toggleTranscriptApproval = useCallback((segmentId: string) => {
    resetTimer();
    setLocalReviewData(prev => ({
      ...prev,
      transcript: prev.transcript.map(seg =>
        seg.id === segmentId ? { ...seg, approved: !seg.approved } : seg
      ),
    }));
  }, [resetTimer]);

  const updateTranscriptText = useCallback((segmentId: string, newText: string) => {
    resetTimer();
    setLocalReviewData(prev => ({
      ...prev,
      transcript: prev.transcript.map(seg =>
        seg.id === segmentId ? { ...seg, text: newText, edited: true } : seg
      ),
    }));
  }, [resetTimer]);

  const handleApprove = () => {
    // Prevent auto-approve from firing after manual approval
    hasAutoApprovedRef.current = true;
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    deleteAutosaveMutation.mutate();
    onApprove({ ...localReviewData, userApproved: true });
  };

  // Convenience function to disable all cuts at once
  const disableAllCuts = useCallback(() => {
    resetTimer();
    setLocalReviewData(prev => ({
      ...prev,
      editPlan: {
        ...prev.editPlan,
        actions: prev.editPlan.actions.map(action =>
          action.type === 'cut' ? { ...action, approved: false } : action
        ),
      },
    }));
  }, [resetTimer]);

  // Convenience function to enable all cuts
  const enableAllCuts = useCallback(() => {
    resetTimer();
    setLocalReviewData(prev => ({
      ...prev,
      editPlan: {
        ...prev.editPlan,
        actions: prev.editPlan.actions.map(action =>
          action.type === 'cut' ? { ...action, approved: true } : action
        ),
      },
    }));
  }, [resetTimer]);

  const approvedActions = localReviewData.editPlan.actions.filter(a => a.approved);
  const approvedCuts = approvedActions.filter(a => a.type === 'cut');
  const approvedKeeps = approvedActions.filter(a => a.type === 'keep');
  const allCutActions = localReviewData.editPlan.actions.filter(a => a.type === 'cut');
  const totalCutDuration = approvedCuts.reduce((sum, c) => sum + ((c.end || 0) - (c.start || 0)), 0);
  const estimatedDuration = (localReviewData.summary.originalDuration - totalCutDuration);

  return (
    <Card className="border-2 border-primary/20">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-primary" />
              Review Your Edit Plan
            </CardTitle>
            <CardDescription className="mt-1">
              Review and approve the AI-generated edit plan before rendering
            </CardDescription>
          </div>
          <div className="flex items-center gap-3">
            {(isSaving || lastSaved) && (
              <div 
                className="flex items-center gap-1.5 text-xs text-muted-foreground"
                data-testid="autosave-status"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" />
                    <span>Saving...</span>
                  </>
                ) : lastSaved ? (
                  <>
                    <Cloud className="h-3 w-3 text-green-500" />
                    <span>Saved {formatLastSaved(lastSaved)}</span>
                  </>
                ) : null}
              </div>
            )}
            <Badge variant="outline" className="gap-1">
              <Clock className="h-3 w-3" />
              {formatTime(localReviewData.summary.originalDuration)} original
            </Badge>
            <Badge variant="secondary" className="gap-1">
              <Clock className="h-3 w-3" />
              ~{formatTime(Math.max(0, estimatedDuration))} final
            </Badge>
          </div>
        </div>

        {/* Auto-accept timer */}
        {!isLoading && (
          <div className={cn(
            "mt-4 p-3 rounded-lg border",
            timeRemaining <= 30 ? "bg-orange-500/10 border-orange-500/30" : "bg-blue-500/10 border-blue-500/30"
          )}>
            <div className="flex items-center justify-between gap-4 flex-wrap mb-2">
              <div className="flex items-center gap-2">
                <Timer className={cn("h-4 w-4", timeRemaining <= 30 ? "text-orange-500" : "text-blue-500")} />
                <span className="text-sm font-medium">
                  {timeRemaining <= 0 ? (
                    "Auto-approving..."
                  ) : (
                    <>Auto-accept in <span className="font-bold">{formatCountdown(timeRemaining)}</span></>
                  )}
                </span>
              </div>
              {userHasInteracted && (
                <Badge variant="outline" className="text-xs">
                  Timer reset on your last change
                </Badge>
              )}
            </div>
            {timeRemaining > 0 && (
              <Progress value={timerProgress} className="h-1" />
            )}
            <p className="text-xs text-muted-foreground mt-2">
              The video will auto-approve with your current settings when the timer ends. Making changes resets the 2-minute timer.
            </p>
          </div>
        )}

        {/* PROMINENT WARNING when cuts are approved */}
        {approvedCuts.length > 0 && (
          <div className="mt-4 p-3 rounded-lg bg-destructive/10 border border-destructive/30" data-testid="warning-cuts-approved">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-destructive mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-destructive" data-testid="text-cuts-warning-title">
                    {approvedCuts.length} cuts will shorten your video
                  </p>
                  <p className="text-xs text-muted-foreground mt-1" data-testid="text-cuts-warning-details">
                    These cuts will remove {formatTime(totalCutDuration)} from your {formatTime(localReviewData.summary.originalDuration)} video, 
                    resulting in a ~{formatTime(Math.max(0, estimatedDuration))} final video.
                  </p>
                  <ul className="text-xs text-muted-foreground mt-2 space-y-0.5 max-h-20 overflow-y-auto" data-testid="list-approved-cuts">
                    {approvedCuts.slice(0, 5).map((cut, i) => (
                      <li key={cut.id} data-testid={`text-cut-item-${cut.id}`}>
                        Cut #{i+1}: {formatTime(cut.start || 0)} - {formatTime(cut.end || 0)} 
                        <span className="opacity-70"> ({((cut.end || 0) - (cut.start || 0)).toFixed(1)}s{cut.reason ? ` - ${cut.reason}` : ''})</span>
                      </li>
                    ))}
                    {approvedCuts.length > 5 && (
                      <li className="opacity-70">...and {approvedCuts.length - 5} more cuts</li>
                    )}
                  </ul>
                </div>
              </div>
              <Button 
                variant="outline" 
                size="sm" 
                onClick={disableAllCuts}
                data-testid="button-disable-all-cuts"
              >
                <X className="h-3 w-3 mr-1" />
                Keep Full Video
              </Button>
            </div>
          </div>
        )}

        {/* Summary of what will happen */}
        <div className="mt-4 p-3 rounded-lg bg-muted/30 border">
          <h4 className="text-sm font-medium mb-2">What will happen:</h4>
          <ul className="text-xs text-muted-foreground space-y-1">
            {approvedCuts.length > 0 ? (
              <li className="flex items-center gap-2">
                <Scissors className="h-3 w-3 text-destructive" />
                <span><strong>{approvedCuts.length} cuts</strong> will remove ~{formatTime(totalCutDuration)} from the video (final: ~{formatTime(Math.max(0, estimatedDuration))})</span>
              </li>
            ) : (
              <li className="flex items-center gap-2">
                <Check className="h-3 w-3 text-green-500" />
                <span><strong>No cuts approved</strong> - the full video will be kept ({formatTime(localReviewData.summary.originalDuration)})</span>
              </li>
            )}
            {approvedKeeps.length > 0 && (
              <li className="flex items-center gap-2">
                <Check className="h-3 w-3 text-green-500" />
                <span><strong>{approvedKeeps.length} keep segments</strong> will be preserved</span>
              </li>
            )}
            {localReviewData.stockMedia.filter(m => m.approved).length > 0 && (
              <li className="flex items-center gap-2">
                <Video className="h-3 w-3 text-blue-500" />
                <span><strong>{localReviewData.stockMedia.filter(m => m.approved).length} B-roll clips</strong> will be overlaid on video</span>
              </li>
            )}
            {localReviewData.aiImages.filter(m => m.approved).length > 0 && (
              <li className="flex items-center gap-2">
                <Sparkles className="h-3 w-3 text-purple-500" />
                <span><strong>{localReviewData.aiImages.filter(m => m.approved).length} AI images</strong> will be overlaid on video</span>
              </li>
            )}
            {localReviewData.transcript.filter(t => t.approved).length > 0 && (
              <li className="flex items-center gap-2">
                <CheckCircle2 className="h-3 w-3 text-primary" />
                <span><strong>Captions</strong> will be burned in from {localReviewData.transcript.filter(t => t.approved).length} transcript segments</span>
              </li>
            )}
            {localReviewData.transcript.filter(t => !t.approved).length > 0 && (
              <li className="flex items-center gap-2">
                <X className="h-3 w-3 text-muted-foreground" />
                <span><strong>{localReviewData.transcript.filter(t => !t.approved).length} transcript segments</strong> will be excluded from captions</span>
              </li>
            )}
          </ul>
          {approvedCuts.length === 0 && localReviewData.editPlan.actions.filter(a => a.type === 'cut').length > 0 && (
            <p className="text-xs text-green-600 dark:text-green-400 mt-2 flex items-center gap-1">
              <Check className="h-3 w-3" />
              You unchecked all cuts - your video will remain at its original length.
            </p>
          )}
        </div>
      </CardHeader>

      <CardContent>
        <Tabs defaultValue="editPlan" className="w-full">
          <TabsList className="grid w-full grid-cols-3 mb-4">
            <TabsTrigger value="transcript" data-testid="tab-transcript">
              Transcript ({localReviewData.transcript.filter(t => t.approved).length}/{localReviewData.transcript.length})
            </TabsTrigger>
            <TabsTrigger value="editPlan" data-testid="tab-editplan">
              Edit Plan ({approvedActions.length}/{localReviewData.editPlan.actions.length})
            </TabsTrigger>
            <TabsTrigger value="media" data-testid="tab-media">
              Media ({localReviewData.stockMedia.filter(m => m.approved).length + localReviewData.aiImages.filter(m => m.approved).length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="transcript" className="mt-0">
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="text-sm font-medium">Transcript Segments</CardTitle>
                <CardDescription className="text-xs">
                  Review the transcribed speech. Uncheck segments to exclude them from captions.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <ScrollArea className="h-[300px]">
                  <div className="space-y-2 p-4">
                    {localReviewData.transcript.map((segment) => (
                      <div
                        key={segment.id}
                        className={cn(
                          "flex items-start gap-3 p-3 rounded-lg border transition-colors",
                          segment.approved 
                            ? "bg-background border-border" 
                            : "bg-muted/50 border-muted opacity-60"
                        )}
                      >
                        <Checkbox
                          checked={segment.approved}
                          onCheckedChange={() => toggleTranscriptApproval(segment.id)}
                          data-testid={`checkbox-transcript-${segment.id}`}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <Badge variant="outline" className="text-xs">
                              {formatTime(segment.start)} - {formatTime(segment.end)}
                            </Badge>
                            {segment.edited && (
                              <Badge variant="secondary" className="text-xs">
                                Edited
                              </Badge>
                            )}
                          </div>
                          <Textarea
                            value={segment.text}
                            onChange={(e) => updateTranscriptText(segment.id, e.target.value)}
                            className="min-h-[40px] text-sm resize-none"
                            disabled={!segment.approved}
                            data-testid={`textarea-transcript-${segment.id}`}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="editPlan" className="mt-0">
            <Card>
              <CardHeader className="py-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div>
                    <CardTitle className="text-sm font-medium">Edit Actions</CardTitle>
                    <CardDescription className="text-xs">
                      Review what the AI plans to do. Uncheck cuts to keep full video.
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="outline" className="gap-1">
                      <Scissors className="h-3 w-3" />
                      {approvedCuts.length}/{allCutActions.length} cuts
                    </Badge>
                    <Badge variant="outline" className="gap-1">
                      <Check className="h-3 w-3" />
                      {approvedKeeps.length} keeps
                    </Badge>
                    {allCutActions.length > 0 && (
                      approvedCuts.length > 0 ? (
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          onClick={disableAllCuts}
                          data-testid="button-uncheck-all-cuts"
                        >
                          Uncheck All Cuts
                        </Button>
                      ) : (
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          onClick={enableAllCuts}
                          data-testid="button-check-all-cuts"
                        >
                          Check All Cuts
                        </Button>
                      )
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <ScrollArea className="h-[300px]">
                  <div className="space-y-2 p-4">
                    {localReviewData.editPlan.actions.map((action) => (
                      <div
                        key={action.id}
                        className={cn(
                          "flex items-start gap-3 p-3 rounded-lg border transition-colors",
                          action.approved 
                            ? action.type === 'cut' 
                              ? "bg-destructive/5 border-destructive/20" 
                              : "bg-background border-border"
                            : "bg-muted/50 border-muted opacity-60"
                        )}
                      >
                        <Checkbox
                          checked={action.approved}
                          onCheckedChange={() => toggleActionApproval(action.id)}
                          data-testid={`checkbox-action-${action.id}`}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            {getActionIcon(action.type)}
                            <Badge 
                              variant={action.type === 'cut' ? 'destructive' : 'secondary'}
                              className="text-xs"
                            >
                              {getActionLabel(action.type)}
                            </Badge>
                            {action.start !== undefined && action.end !== undefined && (
                              <span className="text-xs text-muted-foreground">
                                {formatTime(action.start)} - {formatTime(action.end)}
                                <span className="ml-1">
                                  ({((action.end - action.start)).toFixed(1)}s)
                                </span>
                              </span>
                            )}
                          </div>
                          {action.reason && (
                            <p className="text-xs text-muted-foreground">{action.reason}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="media" className="mt-0">
            <div className="space-y-4">
              {localReviewData.stockMedia.length > 0 && (
                <Card>
                  <CardHeader className="py-3">
                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                      <Video className="h-4 w-4" />
                      Stock Media ({localReviewData.stockMedia.filter(m => m.approved).length}/{localReviewData.stockMedia.length})
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <ScrollArea className="h-[200px]">
                      <div className="grid grid-cols-2 gap-2 p-4">
                        {localReviewData.stockMedia.map((media) => (
                          <div
                            key={media.id}
                            className={cn(
                              "flex items-start gap-2 p-2 rounded-lg border transition-colors",
                              media.approved ? "bg-background" : "bg-muted/50 opacity-60"
                            )}
                          >
                            <Checkbox
                              checked={media.approved}
                              onCheckedChange={() => toggleMediaApproval(media.id, false)}
                              data-testid={`checkbox-stock-${media.id}`}
                            />
                            <div className="flex-1 min-w-0">
                              {media.thumbnailUrl && (
                                <img 
                                  src={media.thumbnailUrl} 
                                  alt={media.query}
                                  className="w-full h-16 object-cover rounded mb-1"
                                />
                              )}
                              <p className="text-xs truncate">{media.query}</p>
                              {media.startTime !== undefined && (
                                <span className="text-xs text-muted-foreground">
                                  at {formatTime(media.startTime)}
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  </CardContent>
                </Card>
              )}

              {localReviewData.aiImages.length > 0 && (
                <Card>
                  <CardHeader className="py-3">
                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                      <Sparkles className="h-4 w-4" />
                      AI Generated Images ({localReviewData.aiImages.filter(m => m.approved).length}/{localReviewData.aiImages.length})
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <ScrollArea className="h-[200px]">
                      <div className="grid grid-cols-2 gap-2 p-4">
                        {localReviewData.aiImages.map((media) => (
                          <div
                            key={media.id}
                            className={cn(
                              "flex items-start gap-2 p-2 rounded-lg border transition-colors",
                              media.approved ? "bg-background" : "bg-muted/50 opacity-60"
                            )}
                          >
                            <Checkbox
                              checked={media.approved}
                              onCheckedChange={() => toggleMediaApproval(media.id, true)}
                              data-testid={`checkbox-ai-${media.id}`}
                            />
                            <div className="flex-1 min-w-0">
                              <p className="text-xs line-clamp-2">{media.query}</p>
                              {media.startTime !== undefined && (
                                <span className="text-xs text-muted-foreground">
                                  at {formatTime(media.startTime)}
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  </CardContent>
                </Card>
              )}

              {localReviewData.stockMedia.length === 0 && localReviewData.aiImages.length === 0 && (
                <div className="text-center py-8 text-muted-foreground">
                  <Image className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">No B-roll media selected</p>
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>

        <div className="mt-6 pt-4 border-t">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="text-sm text-muted-foreground">
              <AlertTriangle className="h-4 w-4 inline mr-1" />
              Unchecked items will be excluded from the final video
            </div>
            <div className="flex gap-3">
              <Button
                variant="outline"
                onClick={onCancel}
                disabled={isLoading}
                data-testid="button-cancel-review"
              >
                <X className="h-4 w-4 mr-2" />
                Cancel
              </Button>
              <Button
                onClick={handleApprove}
                disabled={isLoading}
                data-testid="button-approve-render"
              >
                {isLoading ? (
                  <>Processing...</>
                ) : (
                  <>
                    <Check className="h-4 w-4 mr-2" />
                    Approve & Render Video
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
