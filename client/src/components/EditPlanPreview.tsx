import { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Scissors,
  Image,
  Type,
  Sparkles,
  Clock,
  Zap,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { EditPlan } from "@shared/schema";

interface EditPlanPreviewProps {
  editPlan: EditPlan | null;
  isLoading?: boolean;
}

const ACTION_CONFIG: Record<string, { icon: typeof Scissors; label: string; color: string }> = {
  cut: { icon: Scissors, label: "Remove", color: "bg-red-500/20 text-red-600 dark:text-red-400" },
  keep: { icon: Clock, label: "Keep", color: "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400" },
  insert_stock: { icon: Image, label: "Add B-Roll", color: "bg-blue-500/20 text-blue-600 dark:text-blue-400" },
  add_caption: { icon: Type, label: "Caption", color: "bg-purple-500/20 text-purple-600 dark:text-purple-400" },
  add_text_overlay: { icon: Type, label: "Text Overlay", color: "bg-amber-500/20 text-amber-600 dark:text-amber-400" },
  transition: { icon: Sparkles, label: "Transition", color: "bg-pink-500/20 text-pink-600 dark:text-pink-400" },
  speed_change: { icon: Zap, label: "Speed Change", color: "bg-cyan-500/20 text-cyan-600 dark:text-cyan-400" },
};

export function EditPlanPreview({ editPlan, isLoading }: EditPlanPreviewProps) {
  const [isExpanded, setIsExpanded] = useState(false);

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
          <CardTitle className="flex items-center gap-3 text-base">
            <div className="p-2 rounded-lg bg-primary/10">
              <Zap className="h-5 w-5 text-primary animate-pulse" />
            </div>
            Creating Edit Plan...
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-14 bg-muted animate-pulse rounded-lg"
                style={{ animationDelay: `${i * 150}ms` }}
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
          <CardTitle className="flex items-center gap-3 text-base">
            <div className="p-2 rounded-lg bg-primary/10">
              <Zap className="h-5 w-5 text-primary" />
            </div>
            <div>
              <span className="block">Edit Plan</span>
              <span className="text-sm font-normal text-muted-foreground">
                {editPlan.actions.length} edits planned
              </span>
            </div>
          </CardTitle>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setIsExpanded(!isExpanded)}
            data-testid="button-toggle-expand"
          >
            {isExpanded ? (
              <ChevronUp className="h-5 w-5" />
            ) : (
              <ChevronDown className="h-5 w-5" />
            )}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary badges */}
        <div className="flex flex-wrap gap-2">
          {Object.entries(actionGroups).map(([type, count]) => {
            const config = ACTION_CONFIG[type];
            if (!config) return null;
            const Icon = config.icon;
            return (
              <Badge
                key={type}
                variant="secondary"
                className={cn("gap-1.5", config.color)}
              >
                <Icon className="h-3 w-3" />
                {config.label}: {count}
              </Badge>
            );
          })}
        </div>

        {/* Estimated duration */}
        {editPlan.estimatedDuration && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/50">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm">
              Estimated output: <strong>{formatTime(editPlan.estimatedDuration)}</strong>
            </span>
          </div>
        )}

        {/* Key points */}
        {editPlan.keyPoints && editPlan.keyPoints.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">
              Key Points Identified:
            </p>
            <div className="flex flex-wrap gap-2">
              {editPlan.keyPoints.slice(0, 5).map((point, i) => (
                <Badge key={i} variant="outline" className="text-xs font-normal">
                  {point}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Expandable details */}
        {isExpanded && (
          <div className="border-t pt-4 mt-4">
            <ScrollArea className="h-64">
              <div className="space-y-2 pr-4">
                {editPlan.actions.map((action, index) => {
                  const config = ACTION_CONFIG[action.type] || {
                    icon: Sparkles,
                    label: action.type,
                    color: "bg-muted",
                  };
                  const Icon = config.icon;

                  return (
                    <div
                      key={index}
                      className="flex items-start gap-3 p-3 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors"
                      data-testid={`edit-action-${index}`}
                    >
                      <div className={cn("p-2 rounded-lg", config.color)}>
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-sm">{config.label}</span>
                          {action.start !== undefined && (
                            <span className="text-xs text-muted-foreground font-mono">
                              {formatTime(action.start)} → {formatTime(action.end)}
                            </span>
                          )}
                        </div>
                        {action.reason && (
                          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                            {action.reason}
                          </p>
                        )}
                        {action.text && (
                          <p className="text-xs text-foreground mt-1 italic">
                            "{action.text}"
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
