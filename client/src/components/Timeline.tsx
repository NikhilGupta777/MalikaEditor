import { useMemo } from "react";
import { Scissors, Image, Type, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EditAction } from "@shared/schema";

interface TimelineProps {
  duration: number;
  editPlan?: { actions: EditAction[] };
  currentTime?: number;
  onSeek?: (time: number) => void;
}

const ACTION_COLORS = {
  cut: "bg-destructive/60",
  keep: "bg-secondary/60",
  insert_stock: "bg-accent/60",
  add_caption: "bg-primary/60",
  add_text_overlay: "bg-chart-4/60",
  transition: "bg-chart-5/60",
  speed_change: "bg-chart-3/60",
};

const ACTION_ICONS = {
  cut: Scissors,
  keep: null,
  insert_stock: Image,
  add_caption: Type,
  add_text_overlay: Type,
  transition: Sparkles,
  speed_change: Sparkles,
};

export function Timeline({
  duration,
  editPlan,
  currentTime = 0,
  onSeek,
}: TimelineProps) {
  const timeMarkers = useMemo(() => {
    if (!duration) return [];
    const markers = [];
    const interval = duration > 60 ? 30 : duration > 30 ? 10 : 5;
    for (let i = 0; i <= duration; i += interval) {
      markers.push(i);
    }
    return markers;
  }, [duration]);

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!onSeek || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percentage = x / rect.width;
    onSeek(percentage * duration);
  };

  const playheadPosition = duration ? (currentTime / duration) * 100 : 0;

  const renderSegments = () => {
    if (!editPlan?.actions || !duration) return null;

    return editPlan.actions.map((action, index) => {
      if (action.start === undefined || action.end === undefined) return null;

      const left = (action.start / duration) * 100;
      const width = ((action.end - action.start) / duration) * 100;
      const Icon = ACTION_ICONS[action.type];

      return (
        <div
          key={index}
          className={cn(
            "absolute top-0 h-full timeline-segment flex items-center justify-center",
            ACTION_COLORS[action.type]
          )}
          style={{ left: `${left}%`, width: `${width}%` }}
          title={`${action.type}: ${action.reason || ""}`}
          data-testid={`timeline-segment-${index}`}
        >
          {Icon && width > 3 && (
            <Icon className="h-3 w-3 text-white/80" />
          )}
        </div>
      );
    });
  };

  if (!duration) {
    return (
      <div
        className="h-16 bg-card rounded-lg border border-card-border flex items-center justify-center text-muted-foreground text-sm"
        data-testid="timeline-empty"
      >
        Upload a video to see the timeline
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="timeline">
      {/* Timeline track */}
      <div
        className="relative h-12 bg-muted rounded-md overflow-hidden cursor-pointer"
        onClick={handleClick}
      >
        {/* Segments */}
        {renderSegments()}

        {/* Default track if no edit plan */}
        {!editPlan?.actions && (
          <div className="absolute inset-0 bg-secondary/30" />
        )}

        {/* Playhead */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-white shadow-lg z-10"
          style={{ left: `${playheadPosition}%` }}
        >
          <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-3 h-3 bg-white rounded-full shadow" />
        </div>
      </div>

      {/* Time markers */}
      <div className="relative h-4">
        {timeMarkers.map((time) => (
          <div
            key={time}
            className="absolute text-xs text-muted-foreground"
            style={{ left: `${(time / duration) * 100}%`, transform: "translateX(-50%)" }}
          >
            {formatTime(time)}
          </div>
        ))}
      </div>

      {/* Legend */}
      {editPlan?.actions && editPlan.actions.length > 0 && (
        <div className="flex flex-wrap gap-3 pt-2">
          {Object.entries(ACTION_COLORS).map(([type, color]) => {
            const hasAction = editPlan.actions.some((a) => a.type === type);
            if (!hasAction) return null;

            return (
              <div key={type} className="flex items-center gap-1.5 text-xs">
                <div className={cn("w-3 h-3 rounded", color)} />
                <span className="text-muted-foreground capitalize">
                  {type.replace("_", " ")}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
