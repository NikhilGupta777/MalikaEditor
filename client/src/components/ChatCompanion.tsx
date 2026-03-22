import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  Send, Bot, User, Sparkles, AlertCircle, CheckCircle, Lightbulb,
  MessageCircle, RefreshCw, ChevronDown, ChevronUp, Wand2, Play,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";

interface ChatMessage {
  id: string;
  projectId: number;
  role: "companion" | "user" | "system";
  type: "update" | "explanation" | "question" | "answer" | "milestone" | "insight";
  content: string;
  timestamp: string;
  stage?: string;
  metadata?: {
    pendingReEdit?: string;
    [key: string]: any;
  };
}

interface ChatCompanionProps {
  projectId: number | null;
  className?: string;
  onReEditStarted?: () => void;
}

export function ChatCompanion({ projectId, className, onReEditStarted }: ChatCompanionProps) {
  const [input, setInput] = useState("");
  const [isExpanded, setIsExpanded] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const queryClient = useQueryClient();

  const { data: messagesData, isLoading } = useQuery<{ messages: ChatMessage[] }>({
    queryKey: ["/api/videos", projectId, "chat"],
    queryFn: async () => {
      if (!projectId) return { messages: [] };
      const response = await fetch(`/api/videos/${projectId}/chat`);
      if (!response.ok) {
        if (response.status === 401) return { messages: [] };
        throw new Error("Failed to fetch chat messages");
      }
      return response.json();
    },
    enabled: !!projectId && isExpanded,
    refetchInterval: isExpanded ? 3000 : false,
    refetchIntervalInBackground: false,
    staleTime: 1500,
  });

  const messages = messagesData?.messages || [];

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const sendMutation = useMutation({
    mutationFn: async (message: string) => {
      if (!projectId) throw new Error("No project ID");
      const response = await apiRequest("POST", `/api/videos/${projectId}/chat`, { message });
      return response.json() as Promise<{ messages: ChatMessage[]; reEditStarted: boolean }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/videos", projectId, "chat"] });
      if (data.reEditStarted && onReEditStarted) {
        onReEditStarted();
      }
    },
  });

  const handleSend = async (messageOverride?: string) => {
    const text = (messageOverride ?? input).trim();
    if (!text || !projectId || sendMutation.isPending) return;
    if (!messageOverride) setInput("");
    sendMutation.mutate(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const getMessageIcon = (message: ChatMessage) => {
    if (message.role === "user") return <User className="h-3.5 w-3.5" />;
    if (message.metadata?.pendingReEdit) return <Wand2 className="h-3.5 w-3.5 text-violet-400" />;
    switch (message.type) {
      case "milestone": return <CheckCircle className="h-3.5 w-3.5 text-green-400" />;
      case "insight": return <Lightbulb className="h-3.5 w-3.5 text-amber-400" />;
      case "explanation": return <Sparkles className="h-3.5 w-3.5 text-violet-400" />;
      case "answer": return <MessageCircle className="h-3.5 w-3.5 text-blue-400" />;
      default: return <Bot className="h-3.5 w-3.5 text-muted-foreground" />;
    }
  };

  const getStageBadge = (stage?: string) => {
    if (!stage) return null;
    const stageLabels: Record<string, string> = {
      initialization: "Start", upload: "Upload", transcription: "Transcription",
      analysis: "Analysis", edit_planning: "Planning", media_fetching: "Media",
      media_selection: "Selection", review_ready: "Review", rendering: "Rendering",
      self_review: "Quality Check", correction: "Auto-Fix", complete: "Complete",
      re_edit: "Re-edit", error: "Issue",
    };
    return (
      <Badge variant="outline" className="text-[10px] h-4 px-1">
        {stageLabels[stage] || stage}
      </Badge>
    );
  };

  const formatTimestamp = (ts: string) => {
    try {
      return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch { return ""; }
  };

  if (!projectId) {
    return (
      <div className={cn("flex flex-col rounded-lg border bg-card text-card-foreground", className)} data-testid="chat-companion-empty">
        <div className="p-4 flex items-center gap-2 border-b">
          <Bot className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">AI Editor</span>
        </div>
        <div className="flex-1 flex items-center justify-center p-8 text-sm text-muted-foreground">
          Upload a video to start chatting with your AI editor
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col rounded-lg border bg-card text-card-foreground overflow-hidden", className)} data-testid="chat-companion">
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 border-b cursor-pointer hover:bg-muted/30 transition-colors select-none"
        onClick={() => setIsExpanded(v => !v)}
      >
        <div className="flex items-center gap-2">
          <div className="relative">
            <Bot className="h-4 w-4 text-primary" />
            <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-green-500 border border-card" />
          </div>
          <span className="text-sm font-semibold">AI Editor</span>
          {messages.length > 0 && (
            <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
              {messages.length}
            </Badge>
          )}
          <span className="text-xs text-muted-foreground hidden sm:block">
            Ask questions or request changes
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {sendMutation.isPending && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <RefreshCw className="h-3 w-3 animate-spin" />
              Thinking...
            </span>
          )}
          {isExpanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </div>
      </div>

      {isExpanded && (
        <>
          {/* Message list */}
          <ScrollArea className="flex-1 min-h-0" ref={scrollRef}>
            <div className="p-4 space-y-3">
              {isLoading && messages.length === 0 && (
                <div className="text-center text-muted-foreground text-xs py-6">Loading conversation...</div>
              )}

              {!isLoading && messages.length === 0 && (
                <div className="text-center text-muted-foreground text-xs py-6">
                  <Bot className="h-8 w-8 mx-auto mb-2 opacity-30" />
                  <p>Ask me anything about your video edit.</p>
                  <p className="mt-1 opacity-70">e.g. "Why did you cut that part?" or "The B-roll at 23s doesn't fit"</p>
                </div>
              )}

              {messages.map((message) => {
                const isUser = message.role === "user";
                const hasPlan = !!message.metadata?.pendingReEdit;

                if (isUser) {
                  return (
                    <div key={message.id} className="flex justify-end" data-testid={`chat-message-${message.id}`}>
                      <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-primary text-primary-foreground px-3.5 py-2.5">
                        <p className="text-sm whitespace-pre-wrap break-words">{message.content}</p>
                        <p className="text-[10px] opacity-60 mt-1 text-right">{formatTimestamp(message.timestamp)}</p>
                      </div>
                    </div>
                  );
                }

                // AI message with a proposed re-edit plan
                if (hasPlan) {
                  const planLines = (message.metadata!.pendingReEdit as string)
                    .split("\n")
                    .map(l => l.trim())
                    .filter(Boolean);

                  return (
                    <div key={message.id} className="flex gap-2.5" data-testid={`chat-message-${message.id}`}>
                      <div className="flex-shrink-0 mt-1 h-6 w-6 rounded-full bg-violet-500/10 flex items-center justify-center">
                        <Wand2 className="h-3.5 w-3.5 text-violet-400" />
                      </div>
                      <div className="flex-1 min-w-0 space-y-2">
                        {/* Normal text part */}
                        {message.content && (
                          <div className="rounded-2xl rounded-tl-sm bg-muted px-3.5 py-2.5">
                            <div className="flex items-center gap-1.5 mb-1.5">
                              <span className="text-xs font-medium text-foreground">AI Editor</span>
                              {getStageBadge(message.stage)}
                              <span className="text-[10px] text-muted-foreground">{formatTimestamp(message.timestamp)}</span>
                            </div>
                            <p className="text-sm whitespace-pre-wrap break-words">{message.content}</p>
                          </div>
                        )}

                        {/* Proposed Changes card */}
                        <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 overflow-hidden">
                          <div className="flex items-center gap-2 px-3.5 py-2 bg-violet-500/10 border-b border-violet-500/20">
                            <Sparkles className="h-3.5 w-3.5 text-violet-400" />
                            <span className="text-xs font-semibold text-violet-400">Proposed Changes</span>
                          </div>
                          <div className="px-3.5 py-2.5 space-y-1.5">
                            {planLines.map((line, i) => (
                              <div key={i} className="flex gap-2 items-start">
                                <span className="text-violet-400 text-xs mt-0.5 flex-shrink-0">→</span>
                                <p className="text-xs text-foreground/80 leading-relaxed">
                                  {line.replace(/^[-•*]\s*/, "")}
                                </p>
                              </div>
                            ))}
                          </div>
                          <div className="px-3.5 py-2.5 border-t border-violet-500/20 bg-violet-500/5">
                            <p className="text-[11px] text-muted-foreground mb-2">
                              Say <strong>"start"</strong> or click below to apply these changes and re-render your video.
                            </p>
                            <Button
                              size="sm"
                              className="w-full gap-2 bg-violet-600 hover:bg-violet-700 text-white text-xs h-8"
                              disabled={sendMutation.isPending}
                              onClick={() => handleSend("start")}
                            >
                              <Play className="h-3 w-3" />
                              Start Re-edit
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                }

                // Normal AI message
                const bgStyle = {
                  milestone: "bg-green-500/10 border border-green-500/20",
                  insight: "bg-amber-500/10 border border-amber-500/20",
                  explanation: "bg-violet-500/10 border border-violet-500/20",
                  answer: "bg-muted",
                  update: "bg-muted",
                  question: "bg-muted",
                }[message.type] || "bg-muted";

                return (
                  <div key={message.id} className="flex gap-2.5" data-testid={`chat-message-${message.id}`}>
                    <div className="flex-shrink-0 mt-1 h-6 w-6 rounded-full bg-muted flex items-center justify-center">
                      {getMessageIcon(message)}
                    </div>
                    <div className={cn("flex-1 min-w-0 rounded-2xl rounded-tl-sm px-3.5 py-2.5", bgStyle)}>
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="text-xs font-medium text-foreground">AI Editor</span>
                        {getStageBadge(message.stage)}
                        <span className="text-[10px] text-muted-foreground">{formatTimestamp(message.timestamp)}</span>
                      </div>
                      <p className="text-sm whitespace-pre-wrap break-words">{message.content}</p>
                    </div>
                  </div>
                );
              })}

              {sendMutation.isPending && (
                <div className="flex gap-2.5">
                  <div className="flex-shrink-0 mt-1 h-6 w-6 rounded-full bg-muted flex items-center justify-center">
                    <Bot className="h-3.5 w-3.5 animate-pulse text-primary" />
                  </div>
                  <div className="bg-muted rounded-2xl rounded-tl-sm px-3.5 py-2.5 flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce" style={{ animationDelay: "0ms" }} />
                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce" style={{ animationDelay: "150ms" }} />
                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce" style={{ animationDelay: "300ms" }} />
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>

          {/* Quick action chips */}
          {messages.length > 0 && !sendMutation.isPending && (
            <div className="px-4 py-2 flex gap-2 flex-wrap border-t bg-muted/20">
              {[
                "Why did you cut that?",
                "Explain the B-roll choices",
                "How can this be improved?",
                "Make the pacing faster",
              ].map((chip) => (
                <button
                  key={chip}
                  className="text-[11px] px-2.5 py-1 rounded-full bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground transition-colors border border-border/50"
                  onClick={() => { setInput(chip); textareaRef.current?.focus(); }}
                >
                  {chip}
                </button>
              ))}
            </div>
          )}

          {/* Input */}
          <div className="p-3 border-t bg-card">
            <div className="flex gap-2 items-end">
              <Textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask anything or describe what to change... (Enter to send)"
                disabled={sendMutation.isPending}
                className="flex-1 min-h-[40px] max-h-[120px] resize-none text-sm py-2.5 px-3 rounded-xl"
                rows={1}
                data-testid="input-chat-message"
              />
              <Button
                onClick={() => handleSend()}
                disabled={!input.trim() || sendMutation.isPending}
                size="icon"
                className="h-10 w-10 flex-shrink-0 rounded-xl"
                data-testid="button-send-chat"
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default ChatCompanion;
