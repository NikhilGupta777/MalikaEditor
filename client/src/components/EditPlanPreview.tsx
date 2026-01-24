import { Scissors, Image, Type, Clock, Zap, ChevronDown, ChevronUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import type { EditPlan } from "@shared/schema";

interface EditPlanPreviewProps {
  editPlan: EditPlan | null;
  isLoading?: boolean;
}

export function EditPlanPreview({ editPlan, isLoading }: EditPlanPreviewProps) {
  const [expanded, setExpanded] = useState(false);

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-3">
            <Zap className="h-5 w-5 text-primary animate-pulse" />
            <span className="text-sm">Creating edit plan...</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!editPlan) return null;

  const counts = {
    keep: editPlan.actions.filter(a => a.type === "keep").length,
    caption: editPlan.actions.filter(a => a.type === "add_caption").length,
    broll: editPlan.actions.filter(a => a.type === "insert_stock").length,
    cut: editPlan.actions.filter(a => a.type === "cut").length,
  };

  const formatTime = (seconds?: number) => {
    if (!seconds) return "--:--";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  return (
    <Card data-testid="edit-plan-preview">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Zap className="h-4 w-4 text-primary" />
            Edit Plan
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded(!expanded)}
            className="h-7 px-2"
          >
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        {/* Summary badges */}
        <div className="flex flex-wrap gap-2">
          {counts.keep > 0 && (
            <Badge variant="secondary" className="text-xs gap-1">
              <Clock className="h-3 w-3" /> Keep: {counts.keep}
            </Badge>
          )}
          {counts.caption > 0 && (
            <Badge variant="secondary" className="text-xs gap-1 bg-purple-500/20 text-purple-600 dark:text-purple-400">
              <Type className="h-3 w-3" /> Captions: {counts.caption}
            </Badge>
          )}
          {counts.broll > 0 && (
            <Badge variant="secondary" className="text-xs gap-1 bg-blue-500/20 text-blue-600 dark:text-blue-400">
              <Image className="h-3 w-3" /> B-Roll: {counts.broll}
            </Badge>
          )}
          {counts.cut > 0 && (
            <Badge variant="secondary" className="text-xs gap-1 bg-red-500/20 text-red-600 dark:text-red-400">
              <Scissors className="h-3 w-3" /> Cuts: {counts.cut}
            </Badge>
          )}
        </div>

        {/* Estimated duration */}
        {editPlan.estimatedDuration && (
          <p className="text-xs text-muted-foreground">
            Estimated output: {formatTime(editPlan.estimatedDuration)}
          </p>
        )}

        {/* Key points */}
        {editPlan.keyPoints && editPlan.keyPoints.length > 0 && expanded && (
          <div className="pt-2 border-t">
            <p className="text-xs font-medium mb-2">Key Points:</p>
            <ul className="text-xs text-muted-foreground space-y-1">
              {editPlan.keyPoints.slice(0, 4).map((point, i) => (
                <li key={i} className="truncate">• {point}</li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
