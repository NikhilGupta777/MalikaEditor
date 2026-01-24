import { useMemo } from "react";
import { Scissors, Image, Type, Sparkles, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EditAction } from "@shared/schema";

interface TimelineProps {
  duration: number;
  editPlan?: { actions: EditAction[] };
  currentTime?: number;
  onSeek?: (time: number) => void;
}

const ACTION_COLORS: Record<string, string> = {
  cut: "bg-red-500/70",
  keep: "bg-emerald-500/70",
  insert_stock: "bg-blue-500/70",
  add_caption: "bg-purple-500/70",
  add_text_overlay: "bg-amber-500/70",
  transition: "bg-pink-500/70",
  speed_change: "bg-cyan-500/70",
};

const ACTION_LABELS: Record<string, string> = {
  cut: "Cut",
  keep: "Keep",
  insert_stock: "Stock",
  add_caption: "Caption",
  add_text_overlay: "Text",
  transition: "Transition",
  speed_change: "Speed",
};

const ACTION_ICONS: Record<string, typeof Scissors | null> = {
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
    const interval = duration > 120 ? 30 : duration > 60 ? 15 : duration > 30 ? 10 : 5;
    for (let i = 0; i <= duration; i += interval) {
      markers.push(i);
    }
    if (markers[markers.length - 1] !== Math.floor(duration)) {
      markers.push(Math.floor(duration));
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
    onSeek(Math.max(0, Math.min(duration, percentage * duration)));
  };

  const playheadPosition = duration ? (currentTime / duration) * 100 : 0;

  const renderSegments = () => {
    if (!editPlan?.actions || !duration) return null;

    return editPlan.actions.map((action, index) => {
      if (action.start === undefined || action.end === undefined) return null;

      const left = (action.start / duration) * 100;
      const width = Math.max(0.5, ((action.end - action.start) / duration) * 100);
      const Icon = ACTION_ICONS[action.type];

      return (
        <div
          key={index}
          className={cn(
            "absolute top-0 h-full flex items-center justify-center transition-all",
            ACTION_COLORS[action.type] || "bg-gray-500/70"
          )}
          style={{ left: `${left}%`, width: `${width}%` }}
          title={`${ACTION_LABELS[action.type] || action.type}: ${formatTime(action.start)} - ${formatTime(action.end)}`}
          data-testid={`timeline-segment-${index}`}
        >
          {Icon && width > 4 && (
            <Icon className="h-4 w-4 text-white drop-shadow" />
          )}
        </div>
      );
    });
  };

  if (!duration) {
    return (
      <div
        className="h-20 bg-card rounded-xl border-2 border-dashed border-muted-foreground/20 flex flex-col items-center justify-center text-muted-foreground gap-2"
        data-testid="timeline-empty"
      >
        <Play className="h-6 w-6 opacity-50" />
        <span className="text-sm">Upload a video to see the timeline</span>
      </div>
    );
  }

  return (
    <div className="space-y-3 bg-card/50 p-4 rounded-xl" data-testid="timeline">
      {/* Current time display */}
      <div className="flex items-center justify-between text-sm">
        <span className="font-mono font-medium text-primary">
          {formatTime(currentTime)}
        </span>
        <span className="text-muted-foreground">
          Duration: {formatTime(duration)}
        </span>
      </div>

      {/* Timeline track */}
      <div
        className="relative h-14 bg-muted rounded-lg overflow-hidden cursor-pointer group"
        onClick={handleClick}
      >
        {/* Background grid */}
        <div className="absolute inset-0 opacity-20">
          {timeMarkers.slice(0, -1).map((time) => (
            <div
              key={time}
              className="absolute top-0 bottom-0 w-px bg-foreground/30"
              style={{ left: `${(time / duration) * 100}%` }}
            />
          ))}
        </div>

        {/* Segments */}
        {renderSegments()}

        {/* Default track if no edit plan */}
        {!editPlan?.actions && (
          <div className="absolute inset-0 bg-gradient-to-r from-primary/20 via-primary/30 to-primary/20" />
        )}

        {/* Hover effect */}
        <div className="absolute inset-0 bg-white/5 opacity-0 group-hover:opacity-100 transition-opacity" />

        {/* Playhead */}
        <div
          className="absolute top-0 bottom-0 w-1 bg-white shadow-lg z-20 transition-all"
          style={{ left: `calc(${playheadPosition}% - 2px)` }}
        >
          <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-4 h-4 bg-white rounded-full shadow-md border-2 border-primary" />
          <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-4 h-4 bg-white rounded-full shadow-md border-2 border-primary" />
        </div>
      </div>

      {/* Time markers */}
      <div className="relative h-5">
        {timeMarkers.map((time, index) => (
          <div
            key={time}
            className="absolute text-xs text-muted-foreground font-mono"
            style={{
              left: `${(time / duration) * 100}%`,
              transform: index === 0 ? "none" : index === timeMarkers.length - 1 ? "translateX(-100%)" : "translateX(-50%)",
            }}
          >
            {formatTime(time)}
          </div>
        ))}
      </div>

      {/* Legend */}
      {editPlan?.actions && editPlan.actions.length > 0 && (
        <div className="flex flex-wrap gap-4 pt-2 border-t border-muted">
          {Object.entries(ACTION_COLORS).map(([type, color]) => {
            const hasAction = editPlan.actions.some((a) => a.type === type);
            if (!hasAction) return null;

            return (
              <div key={type} className="flex items-center gap-2 text-xs">
                <div className={cn("w-4 h-4 rounded", color)} />
                <span className="text-muted-foreground">
                  {ACTION_LABELS[type] || type}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
