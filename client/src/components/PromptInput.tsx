import { useState } from "react";
import { Sparkles, Wand2, Scissors, Type, Image, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface PromptInputProps {
  onSubmit: (prompt: string) => void;
  isProcessing: boolean;
}

const EXAMPLE_PROMPTS = [
  {
    icon: Sparkles,
    label: "Make it Engaging",
    description: "Remove boring parts, add captions & b-roll",
    prompt: "Make it engaging, remove boring parts, add captions and relevant b-roll footage",
    color: "from-purple-500 to-pink-500",
  },
  {
    icon: Scissors,
    label: "Quick Trim",
    description: "Remove silences and long pauses",
    prompt: "Remove silent sections and long pauses, keep only the key moments with smooth transitions",
    color: "from-orange-500 to-red-500",
  },
  {
    icon: Type,
    label: "Add Captions",
    description: "Professional subtitles throughout",
    prompt: "Add professional captions throughout, highlight key points with text overlays",
    color: "from-blue-500 to-cyan-500",
  },
  {
    icon: Image,
    label: "Enhance with B-Roll",
    description: "Add relevant stock footage",
    prompt: "Enhance with relevant stock images and videos that complement the content",
    color: "from-green-500 to-emerald-500",
  },
];

export function PromptInput({ onSubmit, isProcessing }: PromptInputProps) {
  const [prompt, setPrompt] = useState("");
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);

  const handleSubmit = () => {
    if (prompt.trim()) {
      onSubmit(prompt.trim());
    }
  };

  const handlePresetClick = (preset: typeof EXAMPLE_PROMPTS[0]) => {
    setPrompt(preset.prompt);
    setSelectedPreset(preset.label);
  };

  return (
    <Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-3 text-lg">
          <div className="p-2 rounded-lg bg-primary/10">
            <Wand2 className="h-5 w-5 text-primary" />
          </div>
          <div>
            <span className="block">How should we edit your video?</span>
            <span className="text-sm font-normal text-muted-foreground">
              Pick a style or write your own instructions
            </span>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Preset buttons */}
        <div className="grid grid-cols-2 gap-3">
          {EXAMPLE_PROMPTS.map((preset) => (
            <button
              key={preset.label}
              onClick={() => handlePresetClick(preset)}
              disabled={isProcessing}
              className={cn(
                "relative p-4 rounded-xl text-left transition-all hover-elevate",
                "border-2 bg-card",
                selectedPreset === preset.label
                  ? "border-primary shadow-md"
                  : "border-transparent hover:border-primary/30"
              )}
              data-testid={`preset-${preset.label.toLowerCase().replace(/\s/g, "-")}`}
            >
              <div className={cn(
                "w-10 h-10 rounded-lg flex items-center justify-center mb-3",
                "bg-gradient-to-br",
                preset.color
              )}>
                <preset.icon className="h-5 w-5 text-white" />
              </div>
              <p className="font-semibold text-sm mb-1">{preset.label}</p>
              <p className="text-xs text-muted-foreground line-clamp-2">
                {preset.description}
              </p>
              {selectedPreset === preset.label && (
                <div className="absolute top-2 right-2 w-3 h-3 rounded-full bg-primary" />
              )}
            </button>
          ))}
        </div>

        {/* Custom prompt */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-muted-foreground">
            Or write custom instructions:
          </label>
          <Textarea
            placeholder="e.g., 'Focus on the product demo parts, add modern transitions, include stock footage of happy customers...'"
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
              setSelectedPreset(null);
            }}
            className="min-h-[100px] resize-none bg-background/50"
            disabled={isProcessing}
            data-testid="textarea-prompt"
          />
        </div>

        <Button
          onClick={handleSubmit}
          disabled={!prompt.trim() || isProcessing}
          className="w-full gap-3 h-12 text-base font-semibold"
          size="lg"
          data-testid="button-process-video"
        >
          {isProcessing ? (
            <>
              <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Processing your video...
            </>
          ) : (
            <>
              <Zap className="h-5 w-5" />
              Start AI Editing
            </>
          )}
        </Button>

        <p className="text-xs text-center text-muted-foreground">
          Processing usually takes 1-2 minutes depending on video length
        </p>
      </CardContent>
    </Card>
  );
}
