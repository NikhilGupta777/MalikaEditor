import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
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
  ChevronUp
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReviewData, ReviewMediaItem, ReviewEditAction, ReviewTranscriptSegment } from "@shared/schema";

interface ReviewPanelProps {
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

export function ReviewPanel({ reviewData, onApprove, onCancel, isLoading }: ReviewPanelProps) {
  const [localReviewData, setLocalReviewData] = useState<ReviewData>(reviewData);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    transcript: true,
    editPlan: true,
    media: true,
  });

  const toggleSection = (section: string) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const toggleActionApproval = useCallback((actionId: string) => {
    setLocalReviewData(prev => ({
      ...prev,
      editPlan: {
        ...prev.editPlan,
        actions: prev.editPlan.actions.map(action =>
          action.id === actionId ? { ...action, approved: !action.approved } : action
        ),
      },
    }));
  }, []);

  const toggleMediaApproval = useCallback((mediaId: string, isAiImage: boolean) => {
    setLocalReviewData(prev => ({
      ...prev,
      [isAiImage ? 'aiImages' : 'stockMedia']: (isAiImage ? prev.aiImages : prev.stockMedia).map(media =>
        media.id === mediaId ? { ...media, approved: !media.approved } : media
      ),
    }));
  }, []);

  const toggleTranscriptApproval = useCallback((segmentId: string) => {
    setLocalReviewData(prev => ({
      ...prev,
      transcript: prev.transcript.map(seg =>
        seg.id === segmentId ? { ...seg, approved: !seg.approved } : seg
      ),
    }));
  }, []);

  const updateTranscriptText = useCallback((segmentId: string, newText: string) => {
    setLocalReviewData(prev => ({
      ...prev,
      transcript: prev.transcript.map(seg =>
        seg.id === segmentId ? { ...seg, text: newText, edited: true } : seg
      ),
    }));
  }, []);

  const handleApprove = () => {
    onApprove({ ...localReviewData, userApproved: true });
  };

  const approvedActions = localReviewData.editPlan.actions.filter(a => a.approved);
  const approvedCuts = approvedActions.filter(a => a.type === 'cut');
  const approvedKeeps = approvedActions.filter(a => a.type === 'keep');
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
                      Review what the AI plans to do. Uncheck actions to skip them.
                    </CardDescription>
                  </div>
                  <div className="flex gap-2">
                    <Badge variant="outline" className="gap-1">
                      <Scissors className="h-3 w-3" />
                      {approvedCuts.length} cuts
                    </Badge>
                    <Badge variant="outline" className="gap-1">
                      <Check className="h-3 w-3" />
                      {approvedKeeps.length} keeps
                    </Badge>
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
