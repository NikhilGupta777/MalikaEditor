import { useState } from "react";
import { Sparkles, Wand2, Film, Type, Image, Scissors } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface PromptInputProps {
  onSubmit: (prompt: string) => void;
  isProcessing: boolean;
}

const EXAMPLE_PROMPTS = [
  {
    icon: Sparkles,
    label: "Engaging",
    prompt: "Make it engaging, remove boring parts, add captions and relevant b-roll footage",
  },
  {
    icon: Scissors,
    label: "Trim",
    prompt: "Remove silent sections and long pauses, keep only the key moments with smooth transitions",
  },
  {
    icon: Type,
    label: "Caption",
    prompt: "Add professional captions throughout, highlight key points with text overlays",
  },
  {
    icon: Image,
    label: "B-Roll",
    prompt: "Enhance with relevant stock images and videos that complement the content",
  },
];

export function PromptInput({ onSubmit, isProcessing }: PromptInputProps) {
  const [prompt, setPrompt] = useState("");

  const handleSubmit = () => {
    if (prompt.trim()) {
      onSubmit(prompt.trim());
    }
  };

  const handleExampleClick = (examplePrompt: string) => {
    setPrompt(examplePrompt);
  };

  return (
    <Card className="border-0 bg-transparent shadow-none">
      <CardHeader className="px-0 pt-0">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Wand2 className="h-5 w-5 text-primary" />
          Editing Instructions
        </CardTitle>
      </CardHeader>
      <CardContent className="px-0 space-y-4">
        <div className="space-y-2">
          <Textarea
            placeholder="Describe how you want your video edited... e.g., 'Make it engaging, remove boring parts, add captions and relevant stock footage'"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            className="min-h-[120px] resize-none bg-card border-card-border"
            disabled={isProcessing}
            data-testid="textarea-prompt"
          />
        </div>

        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Quick presets:</p>
          <div className="flex flex-wrap gap-2">
            {EXAMPLE_PROMPTS.map((example) => (
              <Badge
                key={example.label}
                variant="outline"
                className="cursor-pointer gap-1.5 py-1.5 px-3"
                onClick={() => handleExampleClick(example.prompt)}
                data-testid={`badge-preset-${example.label.toLowerCase()}`}
              >
                <example.icon className="h-3 w-3" />
                {example.label}
              </Badge>
            ))}
          </div>
        </div>

        <Button
          onClick={handleSubmit}
          disabled={!prompt.trim() || isProcessing}
          className="w-full gap-2"
          data-testid="button-process-video"
        >
          {isProcessing ? (
            <>
              <Film className="h-4 w-4 animate-spin" />
              Processing...
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4" />
              Process Video
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
