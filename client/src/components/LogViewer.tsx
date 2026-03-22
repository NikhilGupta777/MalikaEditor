import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal, X, Maximize2, Minimize2, Trash2, PauseCircle, PlayCircle, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface LogEntry {
  id: number;
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  context: string;
  message: string;
}

const LEVEL_STYLES: Record<LogEntry["level"], string> = {
  debug: "text-muted-foreground",
  info:  "text-blue-400",
  warn:  "text-yellow-400",
  error: "text-red-400",
};

const LEVEL_BADGE: Record<LogEntry["level"], string> = {
  debug: "bg-muted text-muted-foreground",
  info:  "bg-blue-500/20 text-blue-400",
  warn:  "bg-yellow-500/20 text-yellow-400",
  error: "bg-red-500/20 text-red-400",
};

function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
}

interface LogViewerProps {
  open: boolean;
  onClose: () => void;
}

export function LogViewer({ open, onClose }: LogViewerProps) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [fullscreen, setFullscreen] = useState(false);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState<LogEntry["level"] | "all">("all");
  const [newCount, setNewCount] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(false);
  const esRef = useRef<EventSource | null>(null);
  const pendingRef = useRef<LogEntry[]>([]);

  pausedRef.current = paused;

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    if (!open) return;

    const es = new EventSource("/api/logs/stream");
    esRef.current = es;

    es.onmessage = (e) => {
      try {
        const entry: LogEntry = JSON.parse(e.data);
        if (pausedRef.current) {
          pendingRef.current.push(entry);
          setNewCount(c => c + 1);
        } else {
          setLogs(prev => [...prev.slice(-999), entry]);
        }
      } catch {}
    };

    es.onerror = () => {};

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!paused) {
      scrollToBottom();
    }
  }, [logs, paused, scrollToBottom]);

  const handleResume = () => {
    if (pendingRef.current.length > 0) {
      setLogs(prev => [...prev, ...pendingRef.current].slice(-1000));
      pendingRef.current = [];
    }
    setNewCount(0);
    setPaused(false);
    setTimeout(scrollToBottom, 50);
  };

  const handleClear = () => {
    setLogs([]);
    pendingRef.current = [];
    setNewCount(0);
  };

  const filtered = filter === "all" ? logs : logs.filter(l => l.level === filter);

  if (!open) return null;

  return (
    <div
      className={cn(
        "fixed left-0 right-0 bottom-0 z-50 flex flex-col bg-zinc-950 border-t border-zinc-800 shadow-2xl transition-all duration-200",
        fullscreen ? "top-0" : "h-[45vh]"
      )}
      data-testid="log-viewer"
    >
      {/* Toolbar */}
      <div className="flex flex-col shrink-0 border-b border-zinc-800">
        {/* Top row: title + action buttons */}
        <div className="flex items-center gap-2 px-3 py-2">
          <Terminal className="h-4 w-4 text-green-400 shrink-0" />
          <span className="text-sm font-mono font-semibold text-green-400">Server Logs</span>
          <div className="ml-auto flex items-center gap-1">
            {paused && newCount > 0 && (
              <button
                onClick={handleResume}
                className="flex items-center gap-1 px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-400 text-xs font-mono hover:bg-yellow-500/30 transition-colors"
                data-testid="button-resume-logs"
              >
                <ChevronDown className="h-3 w-3" />
                {newCount} new
              </button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
              onClick={() => paused ? handleResume() : setPaused(true)}
              title={paused ? "Resume" : "Pause scroll"}
              data-testid="button-pause-logs"
            >
              {paused ? <PlayCircle className="h-4 w-4" /> : <PauseCircle className="h-4 w-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
              onClick={handleClear}
              title="Clear logs"
              data-testid="button-clear-logs"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="hidden sm:flex h-7 w-7 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
              onClick={() => setFullscreen(f => !f)}
              title={fullscreen ? "Half screen" : "Full screen"}
              data-testid="button-fullscreen-logs"
            >
              {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
              onClick={onClose}
              title="Close"
              data-testid="button-close-logs"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
        {/* Filter row — scrollable on mobile */}
        <div className="flex items-center gap-1 px-3 pb-2 overflow-x-auto scrollbar-none">
          {(["all", "debug", "info", "warn", "error"] as const).map(lvl => (
            <button
              key={lvl}
              onClick={() => setFilter(lvl)}
              className={cn(
                "px-2 py-0.5 rounded text-xs font-mono transition-colors shrink-0",
                filter === lvl
                  ? "bg-zinc-700 text-white"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
              )}
              data-testid={`log-filter-${lvl}`}
            >
              {lvl}
            </button>
          ))}
        </div>
      </div>

      {/* Log output */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto font-mono text-xs px-2 py-1"
        onWheel={() => setPaused(true)}
      >
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full text-zinc-600">
            No logs yet — start processing a video to see live output
          </div>
        ) : (
          filtered.map(entry => (
            <div
              key={entry.id}
              className={cn(
                "flex items-start gap-2 py-0.5 px-1 rounded hover:bg-zinc-900 group",
                entry.level === "error" && "bg-red-950/20"
              )}
            >
              <span className="hidden xs:inline text-zinc-600 shrink-0 tabular-nums w-20">
                {formatTime(entry.timestamp)}
              </span>
              <span className={cn("shrink-0 uppercase font-bold w-10 tabular-nums", LEVEL_STYLES[entry.level])}>
                {entry.level === "debug" ? "DBG" : entry.level === "info" ? "INF" : entry.level === "warn" ? "WRN" : "ERR"}
              </span>
              <span className="hidden sm:inline text-zinc-500 shrink-0 max-w-[90px] truncate">
                [{entry.context}]
              </span>
              <span className={cn("flex-1 break-all leading-relaxed", LEVEL_STYLES[entry.level])}>
                {entry.message}
              </span>
            </div>
          ))
        )}
      </div>

      {/* Status bar */}
      <div className="flex items-center gap-2 px-3 py-1 border-t border-zinc-800 shrink-0 bg-zinc-900/50">
        <span className="text-xs text-zinc-500 font-mono">
          {filtered.length} entries
          {filter !== "all" && ` (filtered: ${filter})`}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <span className={cn("h-2 w-2 rounded-full", paused ? "bg-yellow-500" : "bg-green-500 animate-pulse")} />
          <span className="text-xs text-zinc-500 font-mono">{paused ? "paused" : "live"}</span>
        </div>
      </div>
    </div>
  );
}
