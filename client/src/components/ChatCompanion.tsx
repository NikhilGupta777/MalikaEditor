import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Send, Bot, User, Sparkles, AlertCircle, CheckCircle, Lightbulb, MessageCircle } from "lucide-react";
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
}

interface ChatCompanionProps {
  projectId: number | null;
  className?: string;
}

export function ChatCompanion({ projectId, className }: ChatCompanionProps) {
  const [input, setInput] = useState("");
  const [isExpanded, setIsExpanded] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  // Fetch messages using react-query with auto-refresh
  const { data: messagesData, isLoading: isLoadingMessages } = useQuery<{ messages: ChatMessage[] }>({
    queryKey: ["/api/videos", projectId, "chat"],
    queryFn: async () => {
      if (!projectId) return { messages: [] };
      const response = await fetch(`/api/videos/${projectId}/chat`);
      if (!response.ok) {
        if (response.status === 401) {
          return { messages: [] }; // Handle unauthenticated gracefully
        }
        throw new Error("Failed to fetch chat messages");
      }
      return response.json();
    },
    enabled: !!projectId && isExpanded, // Only poll when chat is expanded
    refetchInterval: isExpanded ? 2000 : false, // Poll every 2 seconds only when expanded
    refetchIntervalInBackground: false, // Don't poll when tab is in background
    staleTime: 1000,
  });

  const messages = messagesData?.messages || [];

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Mutation for sending messages
  const sendMessageMutation = useMutation({
    mutationFn: async (message: string) => {
      if (!projectId) throw new Error("No project ID");
      const response = await apiRequest("POST", `/api/videos/${projectId}/chat`, { message });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/videos", projectId, "chat"] });
    },
  });

  const handleSendMessage = async () => {
    if (!input.trim() || !projectId || sendMessageMutation.isPending) return;

    const userMessage = input.trim();
    setInput("");
    
    sendMessageMutation.mutate(userMessage);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const getMessageIcon = (message: ChatMessage) => {
    if (message.role === "user") {
      return <User className="h-4 w-4" />;
    }
    
    switch (message.type) {
      case "milestone":
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case "insight":
        return <Lightbulb className="h-4 w-4 text-yellow-500" />;
      case "explanation":
        return <Sparkles className="h-4 w-4 text-purple-500" />;
      case "answer":
        return <MessageCircle className="h-4 w-4 text-blue-500" />;
      default:
        return <Bot className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const getMessageStyle = (message: ChatMessage) => {
    if (message.role === "user") {
      return "bg-primary text-primary-foreground ml-8";
    }
    
    switch (message.type) {
      case "milestone":
        return "bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800 mr-8";
      case "insight":
        return "bg-yellow-50 dark:bg-yellow-950/30 border-yellow-200 dark:border-yellow-800 mr-8";
      case "explanation":
        return "bg-purple-50 dark:bg-purple-950/30 border-purple-200 dark:border-purple-800 mr-8";
      default:
        return "bg-muted mr-8";
    }
  };

  const getStageBadge = (stage?: string) => {
    if (!stage) return null;
    
    const stageLabels: Record<string, string> = {
      initialization: "Start",
      upload: "Upload",
      transcription: "Transcription",
      analysis: "Analysis",
      edit_planning: "Planning",
      media_fetching: "Media",
      media_selection: "Selection",
      review_ready: "Review",
      rendering: "Rendering",
      self_review: "Quality Check",
      correction: "Auto-Fix",
      complete: "Complete",
      error: "Issue",
    };
    
    return (
      <Badge variant="outline" className="text-xs">
        {stageLabels[stage] || stage}
      </Badge>
    );
  };

  if (!projectId) {
    return (
      <Card className={cn("flex flex-col", className)} data-testid="chat-companion-empty">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Bot className="h-4 w-4" />
            AI Companion
          </CardTitle>
        </CardHeader>
        <CardContent className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          Upload a video to start chatting with your AI editor
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={cn("flex flex-col", className)} data-testid="chat-companion">
      <CardHeader className="pb-3 flex flex-row items-center justify-between">
        <CardTitle className="text-sm flex items-center gap-2">
          <Bot className="h-4 w-4" />
          AI Companion
          {messages.length > 0 && (
            <Badge variant="secondary" className="text-xs">
              {messages.length}
            </Badge>
          )}
        </CardTitle>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setIsExpanded(!isExpanded)}
          data-testid="button-toggle-chat"
        >
          {isExpanded ? "Minimize" : "Expand"}
        </Button>
      </CardHeader>
      
      {isExpanded && (
        <>
          <ScrollArea className="flex-1 px-4" ref={scrollRef}>
            <div className="space-y-3 pb-4">
              {messages.length === 0 ? (
                <div className="text-center text-muted-foreground text-sm py-8">
                  Starting conversation...
                </div>
              ) : (
                messages.map((message) => (
                  <div
                    key={message.id}
                    className={cn(
                      "rounded-lg p-3 border text-sm",
                      getMessageStyle(message)
                    )}
                    data-testid={`chat-message-${message.id}`}
                  >
                    <div className="flex items-start gap-2">
                      <div className="mt-0.5">{getMessageIcon(message)}</div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-medium text-xs">
                            {message.role === "user" ? "You" : "AI Editor"}
                          </span>
                          {getStageBadge(message.stage)}
                          <span className="text-xs text-muted-foreground">
                            {new Date(message.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                        <p className="whitespace-pre-wrap break-words">
                          {message.content}
                        </p>
                      </div>
                    </div>
                  </div>
                ))
              )}
              
              {sendMessageMutation.isPending && (
                <div className="flex items-center gap-2 text-muted-foreground text-sm mr-8">
                  <Bot className="h-4 w-4 animate-pulse" />
                  <span>Thinking...</span>
                </div>
              )}
            </div>
          </ScrollArea>
          
          <CardContent className="pt-0">
            <div className="flex gap-2">
              <Input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="Ask about your video..."
                disabled={sendMessageMutation.isPending}
                className="flex-1"
                data-testid="input-chat-message"
              />
              <Button
                onClick={handleSendMessage}
                disabled={!input.trim() || sendMessageMutation.isPending}
                size="icon"
                data-testid="button-send-chat"
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </>
      )}
    </Card>
  );
}

export default ChatCompanion;
