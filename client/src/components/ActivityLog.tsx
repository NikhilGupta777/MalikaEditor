import { useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Terminal, Brain, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface ActivityItem {
  message: string;
  timestamp: number;
  details?: Record<string, unknown>;
}

interface ActivityLogProps {
  activities: ActivityItem[];
  isProcessing: boolean;
}

export function ActivityLog({ activities, isProcessing }: ActivityLogProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [activities]);

  if (activities.length === 0 && !isProcessing) {
    return null;
  }

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };

  return (
    <Card data-testid="activity-log">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Brain className="h-4 w-4 text-primary" />
          AI Activity Feed
          {isProcessing && (
            <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground font-normal">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
              </span>
              Live
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-48" ref={scrollRef}>
          <div className="p-3 space-y-1.5 font-mono text-xs">
            {activities.map((activity, index) => {
              const isLast = index === activities.length - 1;
              return (
                <div
                  key={`${activity.timestamp}-${index}`}
                  className={cn(
                    "flex items-start gap-2 py-1 px-2 rounded transition-colors",
                    isLast && isProcessing && "bg-primary/5 border-l-2 border-primary"
                  )}
                  data-testid={`activity-item-${index}`}
                >
                  <span className="text-muted-foreground shrink-0 w-16">
                    {formatTime(activity.timestamp)}
                  </span>
                  {isLast && isProcessing ? (
                    <Terminal className="h-3.5 w-3.5 text-primary shrink-0 mt-0.5 animate-pulse" />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                  )}
                  <span className={cn(
                    "flex-1",
                    isLast && isProcessing ? "text-foreground" : "text-muted-foreground"
                  )}>
                    {activity.message}
                  </span>
                </div>
              );
            })}
            {isProcessing && activities.length > 0 && (
              <div className="flex items-center gap-2 py-1 px-2 text-muted-foreground">
                <span className="w-16"></span>
                <span className="flex gap-1">
                  <span className="animate-bounce delay-0">.</span>
                  <span className="animate-bounce delay-100">.</span>
                  <span className="animate-bounce delay-200">.</span>
                </span>
              </div>
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
