import { useState, useCallback, useMemo } from "react";
import { 
  FileText, 
  Scissors, 
  Image, 
  Star, 
  Trash2, 
  Clock, 
  Zap, 
  RotateCcw,
  Sparkles,
  AlertCircle
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { TranscriptSegment, EditPlan, EditAction, SemanticAnalysis } from "@shared/schema";

interface TranscriptEditorProps {
  transcript: TranscriptSegment[];
  editPlan: EditPlan | null;
  onEditPlanChange: (updatedPlan: EditPlan) => void;
  semanticAnalysis?: SemanticAnalysis;
  isLoading?: boolean;
}

type SegmentAction = "keep" | "cut" | "broll" | "key_moment" | "clear";

const FILLER_WORDS = ["um", "uh", "like", "you know", "basically", "actually", "literally", "so", "just"];

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function isFillerWord(text: string): boolean {
  const lowerText = text.toLowerCase().trim();
  return FILLER_WORDS.some(filler => {
    const pattern = new RegExp(`\\b${filler}\\b`, 'i');
    return pattern.test(lowerText);
  });
}

function getSegmentAction(segment: TranscriptSegment, editPlan: EditPlan | null): EditAction | null {
  if (!editPlan) return null;
  return editPlan.actions.find(action => {
    if (action.start !== undefined && action.end !== undefined) {
      return action.start <= segment.start && action.end >= segment.end;
    }
    return false;
  }) || null;
}

export function TranscriptEditor({
  transcript,
  editPlan,
  onEditPlanChange,
  semanticAnalysis,
  isLoading = false,
}: TranscriptEditorProps) {
  const [selectedSegmentIndex, setSelectedSegmentIndex] = useState<number | null>(null);
  const [brollQuery, setBrollQuery] = useState("");
  const [selectionStart, setSelectionStart] = useState<number | null>(null);
  const [selectionEnd, setSelectionEnd] = useState<number | null>(null);
  const [editHistory, setEditHistory] = useState<EditPlan[]>([]);

  const fillerSegments = useMemo(() => {
    const fillers: { index: number; segment: TranscriptSegment }[] = [];
    transcript.forEach((segment, index) => {
      if (segment.isFiller || isFillerWord(segment.text)) {
        fillers.push({ index, segment });
      }
    });
    return fillers;
  }, [transcript]);

  const stats = useMemo(() => {
    if (!transcript.length) return { total: 0, afterCuts: 0, keeps: 0, cuts: 0, brolls: 0, fillers: 0 };

    const totalDuration = transcript.length > 0 
      ? transcript[transcript.length - 1].end - transcript[0].start 
      : 0;

    let cutDuration = 0;
    let keeps = 0;
    let cuts = 0;
    let brolls = 0;

    if (editPlan) {
      editPlan.actions.forEach(action => {
        if (action.type === "cut" && action.start !== undefined && action.end !== undefined) {
          cutDuration += action.end - action.start;
          cuts++;
        } else if (action.type === "keep") {
          keeps++;
        } else if (action.type === "insert_stock") {
          brolls++;
        }
      });
    }

    return {
      total: totalDuration,
      afterCuts: totalDuration - cutDuration,
      keeps,
      cuts,
      brolls,
      fillers: fillerSegments.length,
    };
  }, [transcript, editPlan, fillerSegments]);

  const keyMoments = useMemo(() => {
    const moments: { segmentIndex: number; type: string; score?: number }[] = [];
    
    if (semanticAnalysis?.hookMoments) {
      semanticAnalysis.hookMoments.forEach(hook => {
        const segmentIndex = transcript.findIndex(
          seg => seg.start <= hook.timestamp && seg.end >= hook.timestamp
        );
        if (segmentIndex !== -1) {
          moments.push({ segmentIndex, type: "hook", score: hook.score });
        }
      });
    }

    if (semanticAnalysis?.keyMoments) {
      semanticAnalysis.keyMoments.forEach(moment => {
        const segmentIndex = transcript.findIndex(
          seg => seg.start <= moment.timestamp && seg.end >= moment.timestamp
        );
        if (segmentIndex !== -1 && !moments.some(m => m.segmentIndex === segmentIndex)) {
          moments.push({ segmentIndex, type: moment.importance });
        }
      });
    }

    transcript.forEach((segment, index) => {
      if (segment.hookScore && segment.hookScore > 70 && !moments.some(m => m.segmentIndex === index)) {
        moments.push({ segmentIndex: index, type: "hook", score: segment.hookScore });
      }
      if (segment.isKeyMoment && !moments.some(m => m.segmentIndex === index)) {
        moments.push({ segmentIndex: index, type: "key" });
      }
    });

    return moments;
  }, [transcript, semanticAnalysis]);

  const saveToHistory = useCallback(() => {
    if (editPlan) {
      setEditHistory(prev => [...prev.slice(-9), editPlan]);
    }
  }, [editPlan]);

  const handleUndo = useCallback(() => {
    if (editHistory.length > 0) {
      const previousPlan = editHistory[editHistory.length - 1];
      setEditHistory(prev => prev.slice(0, -1));
      onEditPlanChange(previousPlan);
    }
  }, [editHistory, onEditPlanChange]);

  const handleReset = useCallback(() => {
    saveToHistory();
    onEditPlanChange({
      actions: [],
      stockQueries: editPlan?.stockQueries || [],
      keyPoints: editPlan?.keyPoints || [],
      estimatedDuration: stats.total,
    });
  }, [saveToHistory, onEditPlanChange, editPlan, stats.total]);

  const handleSegmentAction = useCallback((
    segmentIndex: number,
    action: SegmentAction,
    query?: string
  ) => {
    const segment = transcript[segmentIndex];
    if (!segment) return;

    saveToHistory();

    const currentPlan = editPlan || { actions: [], stockQueries: [], keyPoints: [] };
    const existingActions = currentPlan.actions.filter(
      a => !(a.start !== undefined && a.end !== undefined && 
             a.start <= segment.start && a.end >= segment.end)
    );

    let newAction: EditAction | null = null;

    switch (action) {
      case "keep":
        newAction = {
          type: "keep",
          start: segment.start,
          end: segment.end,
          reason: "User marked as keep",
        };
        break;
      case "cut":
        newAction = {
          type: "cut",
          start: segment.start,
          end: segment.end,
          reason: "User marked for removal",
        };
        break;
      case "broll":
        newAction = {
          type: "insert_stock",
          start: segment.start,
          end: segment.end,
          stockQuery: query || segment.suggestedBrollQuery || "relevant footage",
          transcriptContext: segment.text,
          reason: "User added B-roll",
        };
        break;
      case "key_moment":
        newAction = {
          type: "keep",
          start: segment.start,
          end: segment.end,
          priority: "high",
          reason: "User marked as key moment",
        };
        break;
      case "clear":
        break;
    }

    const newActions = newAction ? [...existingActions, newAction] : existingActions;

    let estimatedDuration = stats.total;
    newActions.forEach(a => {
      if (a.type === "cut" && a.start !== undefined && a.end !== undefined) {
        estimatedDuration -= (a.end - a.start);
      }
    });

    onEditPlanChange({
      ...currentPlan,
      actions: newActions,
      estimatedDuration,
    });

    setSelectedSegmentIndex(null);
    setBrollQuery("");
  }, [transcript, editPlan, saveToHistory, onEditPlanChange, stats.total]);

  const handleAutoRemoveFillers = useCallback(() => {
    saveToHistory();

    const currentPlan = editPlan || { actions: [], stockQueries: [], keyPoints: [] };
    const newActions = [...currentPlan.actions];

    fillerSegments.forEach(({ segment }) => {
      const alreadyMarked = newActions.some(
        a => a.start !== undefined && a.end !== undefined &&
             a.start <= segment.start && a.end >= segment.end
      );
      
      if (!alreadyMarked) {
        newActions.push({
          type: "cut",
          start: segment.start,
          end: segment.end,
          reason: "Auto-removed filler word",
        });
      }
    });

    let estimatedDuration = stats.total;
    newActions.forEach(a => {
      if (a.type === "cut" && a.start !== undefined && a.end !== undefined) {
        estimatedDuration -= (a.end - a.start);
      }
    });

    onEditPlanChange({
      ...currentPlan,
      actions: newActions,
      estimatedDuration,
    });
  }, [editPlan, fillerSegments, saveToHistory, onEditPlanChange, stats.total]);

  const handleMultiSelect = useCallback((startIdx: number, endIdx: number, action: SegmentAction) => {
    const minIdx = Math.min(startIdx, endIdx);
    const maxIdx = Math.max(startIdx, endIdx);
    
    for (let i = minIdx; i <= maxIdx; i++) {
      handleSegmentAction(i, action);
    }
    
    setSelectionStart(null);
    setSelectionEnd(null);
  }, [handleSegmentAction]);

  const handleMouseDown = useCallback((index: number) => {
    setSelectionStart(index);
    setSelectionEnd(index);
  }, []);

  const handleMouseEnter = useCallback((index: number) => {
    if (selectionStart !== null) {
      setSelectionEnd(index);
    }
  }, [selectionStart]);

  const handleMouseUp = useCallback(() => {
    if (selectionStart !== null && selectionEnd !== null && selectionStart !== selectionEnd) {
      setSelectedSegmentIndex(selectionStart);
    }
    setSelectionStart(null);
    setSelectionEnd(null);
  }, [selectionStart, selectionEnd]);

  const getSegmentClasses = useCallback((segment: TranscriptSegment, index: number) => {
    const action = getSegmentAction(segment, editPlan);
    const isFiller = segment.isFiller || isFillerWord(segment.text);
    const keyMoment = keyMoments.find(m => m.segmentIndex === index);
    const isSelected = selectionStart !== null && selectionEnd !== null &&
      index >= Math.min(selectionStart, selectionEnd) &&
      index <= Math.max(selectionStart, selectionEnd);

    let baseClasses = "px-3 py-2 rounded-md cursor-pointer transition-all border-2";
    
    if (isSelected) {
      baseClasses += " ring-2 ring-primary ring-offset-2";
    }

    if (action?.type === "cut") {
      return cn(baseClasses, "bg-red-500/20 border-red-500/50 line-through opacity-60 dark:bg-red-500/10");
    }
    
    if (action?.type === "insert_stock") {
      return cn(baseClasses, "bg-blue-500/20 border-blue-500/50 dark:bg-blue-500/10");
    }
    
    if (action?.type === "keep" && action.priority === "high") {
      return cn(baseClasses, "bg-purple-500/20 border-purple-500/50 dark:bg-purple-500/10");
    }
    
    if (action?.type === "keep") {
      return cn(baseClasses, "bg-green-500/20 border-green-500/50 dark:bg-green-500/10");
    }
    
    if (keyMoment) {
      return cn(baseClasses, "bg-purple-500/10 border-purple-500/40 dark:bg-purple-500/5");
    }
    
    if (isFiller) {
      return cn(baseClasses, "bg-yellow-500/20 border-yellow-500/40 dark:bg-yellow-500/10");
    }

    return cn(baseClasses, "bg-muted/30 border-transparent hover:border-muted-foreground/20");
  }, [editPlan, keyMoments, selectionStart, selectionEnd]);

  if (isLoading) {
    return (
      <Card data-testid="transcript-editor">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <FileText className="h-4 w-4" />
            Transcript Editor
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!transcript.length) {
    return (
      <Card data-testid="transcript-editor">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <FileText className="h-4 w-4" />
            Transcript Editor
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
            <AlertCircle className="h-8 w-8 mb-2" />
            <p>No transcript available</p>
            <p className="text-xs mt-1">Upload and process a video to see the transcript</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="transcript-editor">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="flex items-center gap-2 text-base">
            <FileText className="h-4 w-4" />
            Transcript Editor
          </CardTitle>
          <div className="flex items-center gap-2">
            {editHistory.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleUndo}
                data-testid="button-undo"
              >
                <RotateCcw className="h-3.5 w-3.5 mr-1" />
                Undo
              </Button>
            )}
            {stats.fillers > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleAutoRemoveFillers}
                data-testid="button-auto-remove-fillers"
              >
                <Sparkles className="h-3.5 w-3.5 mr-1" />
                Auto-remove fillers ({stats.fillers})
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div 
          className="flex flex-wrap items-center gap-2 p-3 rounded-md bg-muted/50 text-sm"
          data-testid="stats-bar"
        >
          <Badge variant="secondary" className="gap-1">
            <Clock className="h-3 w-3" />
            {formatTime(stats.total)} total
          </Badge>
          <Badge variant="secondary" className="gap-1 bg-green-500/20 text-green-700 dark:text-green-400">
            ~{formatTime(stats.afterCuts)} after cuts
          </Badge>
          {stats.keeps > 0 && (
            <Badge variant="secondary" className="gap-1 bg-green-500/20 text-green-700 dark:text-green-400">
              {stats.keeps} keep
            </Badge>
          )}
          {stats.cuts > 0 && (
            <Badge variant="secondary" className="gap-1 bg-red-500/20 text-red-700 dark:text-red-400">
              <Scissors className="h-3 w-3" />
              {stats.cuts} cuts
            </Badge>
          )}
          {stats.brolls > 0 && (
            <Badge variant="secondary" className="gap-1 bg-blue-500/20 text-blue-700 dark:text-blue-400">
              <Image className="h-3 w-3" />
              {stats.brolls} B-roll
            </Badge>
          )}
        </div>

        <div className="flex flex-wrap gap-2 text-xs">
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded bg-green-500/40 border border-green-500/60" />
            <span className="text-muted-foreground">Keep</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded bg-red-500/40 border border-red-500/60" />
            <span className="text-muted-foreground">Cut</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded bg-blue-500/40 border border-blue-500/60" />
            <span className="text-muted-foreground">B-roll</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded bg-yellow-500/40 border border-yellow-500/60" />
            <span className="text-muted-foreground">Filler</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded bg-purple-500/40 border border-purple-500/60" />
            <span className="text-muted-foreground">Key moment</span>
          </div>
        </div>

        <ScrollArea className="h-[400px] pr-4" data-testid="transcript-scroll-area">
          <div 
            className="space-y-2"
            onMouseUp={handleMouseUp}
            onMouseLeave={() => { setSelectionStart(null); setSelectionEnd(null); }}
          >
            {transcript.map((segment, index) => {
              const action = getSegmentAction(segment, editPlan);
              const keyMoment = keyMoments.find(m => m.segmentIndex === index);
              const isFiller = segment.isFiller || isFillerWord(segment.text);

              return (
                <div 
                  key={index} 
                  className="flex gap-2"
                  data-testid={`segment-row-${index}`}
                >
                  <div className="flex flex-col items-end shrink-0 w-16 pt-2">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="text-xs text-muted-foreground font-mono">
                          {formatTime(segment.start)}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {formatTime(segment.start)} - {formatTime(segment.end)}
                      </TooltipContent>
                    </Tooltip>
                    {keyMoment && (
                      <Badge 
                        variant="secondary" 
                        className="text-[10px] px-1 py-0 mt-1 bg-purple-500/30 text-purple-700 dark:text-purple-300"
                        data-testid={`badge-key-moment-${index}`}
                      >
                        {keyMoment.type === "hook" ? (
                          <>HOOK {keyMoment.score ? `${keyMoment.score}` : ""}</>
                        ) : (
                          <Star className="h-2.5 w-2.5" />
                        )}
                      </Badge>
                    )}
                  </div>

                  <Popover 
                    open={selectedSegmentIndex === index}
                    onOpenChange={(open) => {
                      if (!open) setSelectedSegmentIndex(null);
                    }}
                  >
                    <PopoverTrigger asChild>
                      <div
                        className={getSegmentClasses(segment, index)}
                        onClick={() => setSelectedSegmentIndex(index)}
                        onMouseDown={() => handleMouseDown(index)}
                        onMouseEnter={() => handleMouseEnter(index)}
                        data-testid={`segment-${index}`}
                      >
                        <div className="flex items-start gap-2 flex-wrap">
                          {action?.type === "cut" && (
                            <Badge variant="destructive" className="text-[10px] px-1.5 py-0 shrink-0">
                              CUT
                            </Badge>
                          )}
                          {action?.type === "insert_stock" && (
                            <Badge className="text-[10px] px-1.5 py-0 shrink-0 bg-blue-500">
                              B-ROLL
                            </Badge>
                          )}
                          {isFiller && !action && (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0 border-yellow-500/60 text-yellow-700 dark:text-yellow-400">
                              FILLER
                            </Badge>
                          )}
                          <span className={cn(
                            "text-sm leading-relaxed",
                            action?.type === "cut" && "line-through opacity-60"
                          )}>
                            {segment.words && segment.words.length > 0 ? (
                              segment.words.map((word, wordIdx) => (
                                <Tooltip key={wordIdx}>
                                  <TooltipTrigger asChild>
                                    <span className={cn(
                                      "hover:bg-primary/10 rounded px-0.5",
                                      isFillerWord(word.word) && "bg-yellow-500/20"
                                    )}>
                                      {word.word}{" "}
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    {formatTime(word.start)} - {formatTime(word.end)}
                                  </TooltipContent>
                                </Tooltip>
                              ))
                            ) : (
                              segment.text
                            )}
                          </span>
                        </div>
                        {segment.emotion && (
                          <span className="text-[10px] text-muted-foreground mt-1 block">
                            Tone: {segment.emotion}
                          </span>
                        )}
                      </div>
                    </PopoverTrigger>
                    <PopoverContent 
                      className="w-64 p-2" 
                      align="start"
                      data-testid={`popover-segment-${index}`}
                    >
                      <div className="space-y-2">
                        <p className="text-xs text-muted-foreground mb-2 truncate">
                          {segment.text.substring(0, 50)}...
                        </p>
                        <div className="grid grid-cols-2 gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="justify-start gap-2 h-8"
                            onClick={() => handleSegmentAction(index, "keep")}
                            data-testid={`action-keep-${index}`}
                          >
                            <div className="w-2.5 h-2.5 rounded-full bg-green-500" />
                            Keep
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="justify-start gap-2 h-8"
                            onClick={() => handleSegmentAction(index, "cut")}
                            data-testid={`action-cut-${index}`}
                          >
                            <Scissors className="h-3.5 w-3.5 text-red-500" />
                            Cut
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="justify-start gap-2 h-8"
                            onClick={() => handleSegmentAction(index, "key_moment")}
                            data-testid={`action-key-moment-${index}`}
                          >
                            <Star className="h-3.5 w-3.5 text-purple-500" />
                            Key Moment
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="justify-start gap-2 h-8"
                            onClick={() => handleSegmentAction(index, "clear")}
                            data-testid={`action-clear-${index}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Clear
                          </Button>
                        </div>
                        <div className="pt-2 border-t">
                          <p className="text-xs font-medium mb-1.5 flex items-center gap-1">
                            <Image className="h-3 w-3 text-blue-500" />
                            Add B-roll
                          </p>
                          <div className="flex gap-1">
                            <Input
                              placeholder="Search query..."
                              value={brollQuery}
                              onChange={(e) => setBrollQuery(e.target.value)}
                              className="h-7 text-xs"
                              data-testid={`input-broll-query-${index}`}
                            />
                            <Button
                              size="sm"
                              className="h-7 px-2"
                              onClick={() => handleSegmentAction(index, "broll", brollQuery || segment.suggestedBrollQuery)}
                              data-testid={`action-broll-${index}`}
                            >
                              <Zap className="h-3 w-3" />
                            </Button>
                          </div>
                          {segment.suggestedBrollQuery && (
                            <button
                              className="text-[10px] text-blue-500 hover:underline mt-1"
                              onClick={() => setBrollQuery(segment.suggestedBrollQuery!)}
                              data-testid={`suggestion-broll-${index}`}
                            >
                              Suggested: {segment.suggestedBrollQuery}
                            </button>
                          )}
                        </div>
                      </div>
                    </PopoverContent>
                  </Popover>
                </div>
              );
            })}
          </div>
        </ScrollArea>

        {editPlan && editPlan.actions.length > 0 && (
          <div className="flex justify-end pt-2 border-t">
            <Button
              variant="outline"
              size="sm"
              onClick={handleReset}
              data-testid="button-reset-all"
            >
              <RotateCcw className="h-3.5 w-3.5 mr-1" />
              Reset All Changes
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
