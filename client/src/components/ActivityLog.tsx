import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Terminal, Brain, CheckCircle2, ChevronDown, ChevronUp, Zap, Clock } from "lucide-react";
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
  const [historyOpen, setHistoryOpen] = useState(true);

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

  const currentActivity = activities.length > 0 ? activities[activities.length - 1] : null;
  const historyActivities = activities.slice(0, -1);

  return (
    <div className="space-y-3" data-testid="activity-log">
      {/* Current Activity - Highlighted */}
      <Card className="border-primary/50 bg-primary/5">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="relative">
              <Zap className="h-5 w-5 text-primary" />
              {isProcessing && (
                <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-primary"></span>
                </span>
              )}
            </div>
            <span className="text-sm font-medium text-primary">
              {isProcessing ? "Currently Processing" : "Last Activity"}
            </span>
            {currentActivity && (
              <span className="ml-auto text-xs text-muted-foreground flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {formatTime(currentActivity.timestamp)}
              </span>
            )}
          </div>
          
          {currentActivity ? (
            <div className="flex items-center gap-3">
              {isProcessing && (
                <div className="shrink-0">
                  <Terminal className="h-5 w-5 text-primary animate-pulse" />
                </div>
              )}
              <p className={cn(
                "text-sm",
                isProcessing ? "text-foreground font-medium" : "text-muted-foreground"
              )}>
                {currentActivity.message}
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Waiting for AI to start...</p>
          )}

          {isProcessing && (
            <div className="flex items-center gap-1 mt-2 text-primary text-xs">
              <span className="animate-bounce" style={{ animationDelay: "0ms" }}>.</span>
              <span className="animate-bounce" style={{ animationDelay: "150ms" }}>.</span>
              <span className="animate-bounce" style={{ animationDelay: "300ms" }}>.</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Activity History - Collapsible */}
      {historyActivities.length > 0 && (
        <Collapsible open={historyOpen} onOpenChange={setHistoryOpen}>
          <Card>
            <CardHeader className="pb-0 pt-3 px-4">
              <CollapsibleTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-between p-0 h-auto hover:bg-transparent"
                  data-testid="button-toggle-history"
                >
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <Brain className="h-4 w-4 text-muted-foreground" />
                    Activity History
                    <span className="text-xs text-muted-foreground font-normal">
                      ({historyActivities.length} events)
                    </span>
                  </CardTitle>
                  {historyOpen ? (
                    <ChevronUp className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  )}
                </Button>
              </CollapsibleTrigger>
            </CardHeader>
            
            <CollapsibleContent>
              <CardContent className="p-0 pt-2">
                <ScrollArea className="h-40" ref={scrollRef}>
                  <div className="px-4 pb-3 space-y-1 font-mono text-xs">
                    {historyActivities.map((activity, index) => (
                      <div
                        key={`${activity.timestamp}-${index}`}
                        className="flex items-start gap-2 py-1 px-2 rounded hover:bg-muted/50 transition-colors"
                        data-testid={`activity-item-${index}`}
                      >
                        <span className="text-muted-foreground shrink-0 w-16">
                          {formatTime(activity.timestamp)}
                        </span>
                        <CheckCircle2 className="h-3.5 w-3.5 text-secondary shrink-0 mt-0.5" />
                        <span className="flex-1 text-muted-foreground">
                          {activity.message}
                        </span>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>
      )}
    </div>
  );
}
