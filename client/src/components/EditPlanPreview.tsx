import { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Scissors,
  Image,
  Type,
  Sparkles,
  Clock,
  FileJson,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { EditPlan, EditAction } from "@shared/schema";

interface EditPlanPreviewProps {
  editPlan: EditPlan | null;
  isLoading?: boolean;
}

const ACTION_ICONS: Record<string, typeof Scissors> = {
  cut: Scissors,
  keep: Clock,
  insert_stock: Image,
  add_caption: Type,
  add_text_overlay: Type,
  transition: Sparkles,
  speed_change: Clock,
};

const ACTION_LABELS: Record<string, string> = {
  cut: "Remove",
  keep: "Keep",
  insert_stock: "Add Stock Media",
  add_caption: "Add Caption",
  add_text_overlay: "Text Overlay",
  transition: "Transition",
  speed_change: "Speed Change",
};

export function EditPlanPreview({ editPlan, isLoading }: EditPlanPreviewProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const formatTime = (seconds?: number): string => {
    if (seconds === undefined) return "--:--";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <FileJson className="h-5 w-5 text-primary" />
            Edit Plan
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-12 bg-muted animate-pulse rounded-md"
              />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!editPlan) {
    return null;
  }

  const actionGroups = editPlan.actions.reduce((acc, action) => {
    acc[action.type] = (acc[action.type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return (
    <Card data-testid="edit-plan-preview">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <FileJson className="h-5 w-5 text-primary" />
            Edit Plan
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowRaw(!showRaw)}
              className="text-xs"
              data-testid="button-toggle-raw-json"
            >
              {showRaw ? "Visual" : "JSON"}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setIsExpanded(!isExpanded)}
              data-testid="button-toggle-expand"
            >
              {isExpanded ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* Summary badges */}
        <div className="flex flex-wrap gap-2 mb-4">
          {Object.entries(actionGroups).map(([type, count]) => (
            <Badge
              key={type}
              variant="secondary"
              className="gap-1"
            >
              {ACTION_LABELS[type] || type}: {count}
            </Badge>
          ))}
          {editPlan.estimatedDuration && (
            <Badge variant="outline" className="gap-1">
              <Clock className="h-3 w-3" />
              Est. {formatTime(editPlan.estimatedDuration)}
            </Badge>
          )}
        </div>

        {/* Key points */}
        {editPlan.keyPoints && editPlan.keyPoints.length > 0 && (
          <div className="mb-4">
            <p className="text-xs text-muted-foreground mb-2">Key Points:</p>
            <div className="flex flex-wrap gap-2">
              {editPlan.keyPoints.map((point, i) => (
                <Badge key={i} variant="outline" className="text-xs">
                  {point}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Expandable details */}
        {isExpanded && (
          <div className="border-t pt-4 mt-4">
            {showRaw ? (
              <ScrollArea className="h-64">
                <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap">
                  {JSON.stringify(editPlan, null, 2)}
                </pre>
              </ScrollArea>
            ) : (
              <ScrollArea className="h-64">
                <div className="space-y-2">
                  {editPlan.actions.map((action, index) => {
                    const Icon = ACTION_ICONS[action.type] || Sparkles;
                    return (
                      <div
                        key={index}
                        className="flex items-start gap-3 p-2 rounded-md bg-muted/50"
                        data-testid={`edit-action-${index}`}
                      >
                        <div
                          className={cn(
                            "p-1.5 rounded",
                            action.type === "cut"
                              ? "bg-destructive/20"
                              : action.type === "insert_stock"
                              ? "bg-accent/20"
                              : "bg-primary/20"
                          )}
                        >
                          <Icon className="h-3 w-3" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">
                              {ACTION_LABELS[action.type] || action.type}
                            </span>
                            {action.start !== undefined && (
                              <span className="text-xs text-muted-foreground">
                                {formatTime(action.start)} - {formatTime(action.end)}
                              </span>
                            )}
                          </div>
                          {action.reason && (
                            <p className="text-xs text-muted-foreground mt-0.5 truncate">
                              {action.reason}
                            </p>
                          )}
                          {action.text && (
                            <p className="text-xs text-foreground mt-0.5 truncate">
                              "{action.text}"
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
