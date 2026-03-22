import { Eye, Sparkles, RotateCcw, CheckCircle2, AlertCircle, Download, TrendingUp, Loader2, Film } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type BgQualityPhase =
  | "connecting"
  | "watching"
  | "scored"
  | "accepted"
  | "correcting"
  | "fetching_media"
  | "rendering"
  | "reviewing"
  | "improved"
  | "done";

export interface BgQualityState {
  phase: BgQualityPhase;
  score?: number;
  approved?: boolean;
  issueCount?: number;
  correctionReason?: string;
  oldScore?: number;
  newScore?: number;
  improvedOutputPath?: string;
}

interface Props {
  state: BgQualityState;
  onDownloadImproved?: (outputPath: string) => void;
}

function ScoreBadge({ score }: { score: number }) {
  const color =
    score >= 80 ? "text-green-600 bg-green-50 border-green-200 dark:bg-green-900/20 dark:border-green-800 dark:text-green-400"
    : score >= 60 ? "text-yellow-600 bg-yellow-50 border-yellow-200 dark:bg-yellow-900/20 dark:border-yellow-800 dark:text-yellow-400"
    : "text-red-600 bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800 dark:text-red-400";
  return (
    <span className={cn("inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border", color)}>
      {score}/100
    </span>
  );
}

const PHASE_CONFIG: Record<BgQualityPhase, { icon: React.ReactNode; label: string; detail?: (s: BgQualityState) => string | null; spinning?: boolean }> = {
  connecting: {
    icon: <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />,
    label: "Connecting to AI quality review...",
    spinning: true,
  },
  watching: {
    icon: <Eye className="h-4 w-4 text-blue-500 animate-pulse" />,
    label: "AI is watching your video",
    detail: () => "Analyzing pacing, cuts, B-roll and captions...",
  },
  scored: {
    icon: <Sparkles className="h-4 w-4 text-yellow-500" />,
    label: "Quality review complete",
    detail: (s) => s.issueCount ? `${s.issueCount} area${s.issueCount !== 1 ? "s" : ""} flagged for review` : null,
  },
  accepted: {
    icon: <CheckCircle2 className="h-4 w-4 text-green-500" />,
    label: "Video quality approved — no corrections needed",
  },
  correcting: {
    icon: <Sparkles className="h-4 w-4 text-purple-500 animate-pulse" />,
    label: "AI is generating correction plan",
    detail: (s) => s.correctionReason ? s.correctionReason.slice(0, 100) + (s.correctionReason.length > 100 ? "…" : "") : null,
  },
  fetching_media: {
    icon: <Film className="h-4 w-4 text-blue-500 animate-pulse" />,
    label: "Fetching fresh B-roll footage",
    detail: () => "Searching for the best clips for the corrected edit...",
  },
  rendering: {
    icon: <RotateCcw className="h-4 w-4 text-orange-500 animate-spin" />,
    label: "Rendering improved version",
    detail: () => "Applying corrections and re-building the video...",
    spinning: true,
  },
  reviewing: {
    icon: <Eye className="h-4 w-4 text-blue-500 animate-pulse" />,
    label: "AI is reviewing the corrected video",
    detail: () => "Verifying quality improvements...",
  },
  improved: {
    icon: <TrendingUp className="h-4 w-4 text-green-500" />,
    label: "Improved video ready",
    detail: (s) =>
      s.oldScore !== undefined && s.newScore !== undefined
        ? `Quality improved: ${s.oldScore}/100 → ${s.newScore}/100`
        : null,
  },
  done: {
    icon: <CheckCircle2 className="h-4 w-4 text-green-500" />,
    label: "AI quality review complete",
  },
};

export function BackgroundQualityPanel({ state, onDownloadImproved }: Props) {
  const config = PHASE_CONFIG[state.phase];
  if (!config) return null;

  const isActive = !["done", "accepted", "improved"].includes(state.phase);
  const detail = config.detail?.(state);

  return (
    <Card className={cn(
      "border transition-all duration-300",
      state.phase === "improved"
        ? "border-green-300 bg-green-50/50 dark:bg-green-950/20 dark:border-green-800"
        : isActive
          ? "border-blue-200 bg-blue-50/40 dark:bg-blue-950/20 dark:border-blue-900"
          : "border-border bg-muted/30"
    )}>
      <CardContent className="py-3 px-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 shrink-0">{config.icon}</div>

          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn(
                "text-sm font-medium",
                state.phase === "improved" ? "text-green-700 dark:text-green-400" : "text-foreground"
              )}>
                {config.label}
              </span>

              {state.phase === "scored" && state.score !== undefined && (
                <ScoreBadge score={state.score} />
              )}
              {state.phase === "improved" && state.newScore !== undefined && (
                <ScoreBadge score={state.newScore} />
              )}
              {isActive && (
                <Badge variant="secondary" className="text-xs py-0 h-5">Live</Badge>
              )}
            </div>

            {detail && (
              <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{detail}</p>
            )}

            {state.phase === "improved" && state.improvedOutputPath && onDownloadImproved && (
              <Button
                size="sm"
                className="mt-2 h-7 text-xs gap-1.5"
                onClick={() => onDownloadImproved(state.improvedOutputPath!)}
              >
                <Download className="h-3 w-3" />
                Download improved version
              </Button>
            )}
          </div>

          {isActive && (
            <div className="shrink-0 flex gap-0.5 mt-1.5">
              {[0, 1, 2].map(i => (
                <span
                  key={i}
                  className="w-1 h-1 rounded-full bg-blue-400 dark:bg-blue-500 animate-bounce"
                  style={{ animationDelay: `${i * 0.15}s` }}
                />
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
