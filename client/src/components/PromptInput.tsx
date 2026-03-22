import { useState, useCallback } from "react";
import { Sparkles, Wand2, Scissors, Type, Image, Zap, Settings2, Film, ImagePlus, Gauge } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type QualityMode = "preview" | "balanced" | "quality";

export interface EditOptions {
  addCaptions: boolean;
  addBroll: boolean;
  removeSilence: boolean;
  generateAiImages: boolean;
  addTransitions: boolean;
  qualityMode: QualityMode;
}

interface PromptInputProps {
  onSubmit: (prompt: string) => void;
  isProcessing: boolean;
  editOptions: EditOptions;
  onEditOptionsChange: (options: EditOptions) => void;
}

const QUICK_STYLES = [
  {
    label: "Make it Engaging",
    prompt: "Make it engaging, remove boring parts, add captions and relevant b-roll footage",
  },
  {
    label: "Professional",
    prompt: "Create a professional, polished video with smooth transitions and clear captions",
  },
  {
    label: "Social Media Ready",
    prompt: "Optimize for social media: fast-paced, attention-grabbing, with bold captions",
  },
];

export function PromptInput({ 
  onSubmit, 
  isProcessing, 
  editOptions, 
  onEditOptionsChange 
}: PromptInputProps) {
  const [prompt, setPrompt] = useState(""); // Empty by default - quick styles or placeholder guide the user

  const handleSubmit = useCallback(() => {
    if (prompt.trim()) {
      onSubmit(prompt.trim());
    }
  }, [prompt, onSubmit]);

  const handleOptionChange = useCallback((key: keyof EditOptions) => {
    onEditOptionsChange({
      ...editOptions,
      [key]: !editOptions[key],
    });
  }, [editOptions, onEditOptionsChange]);

  return (
    <div className="space-y-4">
      {/* Edit Options - Separate Card */}
      <Card data-testid="edit-options-card">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Settings2 className="h-4 w-4 text-muted-foreground" />
            Edit Options
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center space-x-3">
            <Checkbox
              id="addCaptions"
              checked={editOptions.addCaptions}
              onCheckedChange={() => handleOptionChange("addCaptions")}
              disabled={isProcessing}
              data-testid="checkbox-captions"
            />
            <Label 
              htmlFor="addCaptions" 
              className="flex items-center gap-2 cursor-pointer"
            >
              <Type className="h-4 w-4 text-purple-500" />
              <span>Add Captions</span>
            </Label>
          </div>
          
          <div className="flex items-center space-x-3">
            <Checkbox
              id="addBroll"
              checked={editOptions.addBroll}
              onCheckedChange={() => handleOptionChange("addBroll")}
              disabled={isProcessing}
              data-testid="checkbox-broll"
            />
            <Label 
              htmlFor="addBroll" 
              className="flex items-center gap-2 cursor-pointer"
            >
              <Image className="h-4 w-4 text-blue-500" />
              <span>Add B-Roll Stock Footage</span>
            </Label>
          </div>
          
          <div className="flex items-center space-x-3">
            <Checkbox
              id="removeSilence"
              checked={editOptions.removeSilence}
              onCheckedChange={() => handleOptionChange("removeSilence")}
              disabled={isProcessing}
              data-testid="checkbox-silence"
            />
            <Label 
              htmlFor="removeSilence" 
              className="flex items-center gap-2 cursor-pointer"
            >
              <Scissors className="h-4 w-4 text-orange-500" />
              <span>Remove Silent Parts</span>
            </Label>
          </div>
          
          <div className="flex items-center space-x-3">
            <Checkbox
              id="addTransitions"
              checked={editOptions.addTransitions}
              onCheckedChange={() => handleOptionChange("addTransitions")}
              disabled={isProcessing}
              data-testid="checkbox-transitions"
            />
            <Label 
              htmlFor="addTransitions" 
              className="flex items-center gap-2 cursor-pointer"
            >
              <Film className="h-4 w-4 text-green-500" />
              <span>Add Transitions</span>
              <span className="hidden sm:inline text-xs text-muted-foreground ml-1">(crossfade between segments)</span>
            </Label>
          </div>
          
          <div className="flex items-center space-x-3">
            <Checkbox
              id="generateAiImages"
              checked={editOptions.generateAiImages}
              onCheckedChange={() => handleOptionChange("generateAiImages")}
              disabled={isProcessing}
              data-testid="checkbox-ai-images"
            />
            <Label 
              htmlFor="generateAiImages" 
              className="flex items-center gap-2 cursor-pointer"
            >
              <ImagePlus className="h-4 w-4 text-pink-500" />
              <span>AI Generated Images</span>
              <span className="hidden sm:inline text-xs text-muted-foreground ml-1">(context-aware visuals)</span>
            </Label>
          </div>
          
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pt-2 border-t">
            <Label className="flex items-center gap-2">
              <Gauge className="h-4 w-4 text-purple-500" />
              <span>Output Quality</span>
            </Label>
            <Select
              value={editOptions.qualityMode}
              onValueChange={(value: QualityMode) => 
                onEditOptionsChange({ ...editOptions, qualityMode: value })
              }
              disabled={isProcessing}
            >
              <SelectTrigger className="w-full sm:w-[140px]" data-testid="select-quality-mode">
                <SelectValue placeholder="Quality" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="preview">Preview (Fast)</SelectItem>
                <SelectItem value="balanced">Balanced</SelectItem>
                <SelectItem value="quality">High Quality</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Prompt Input - Separate Card */}
      <Card data-testid="prompt-input-card">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Wand2 className="h-4 w-4 text-primary" />
            Editing Instructions
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Quick style buttons */}
          <div className="flex flex-wrap gap-2">
            {QUICK_STYLES.map((style) => (
              <button
                key={style.label}
                onClick={() => setPrompt(style.prompt)}
                disabled={isProcessing}
                className={cn(
                  "px-3 py-1.5 text-xs rounded-full transition-all",
                  "border hover:border-primary/50 hover:bg-primary/5",
                  prompt === style.prompt
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-muted-foreground/30"
                )}
                data-testid={`style-${style.label.toLowerCase().replace(/\s/g, "-")}`}
              >
                {style.label}
              </button>
            ))}
          </div>

          {/* Text area */}
          <Textarea
            placeholder="Describe how you want the video edited..."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            className="min-h-[80px] resize-none"
            disabled={isProcessing}
            data-testid="textarea-prompt"
          />

          {/* Submit button */}
          <Button
            onClick={handleSubmit}
            disabled={!prompt.trim() || isProcessing}
            className="w-full gap-2 h-11"
            size="lg"
            data-testid="button-process-video"
          >
            {isProcessing ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Processing...
              </>
            ) : (
              <>
                <Zap className="h-4 w-4" />
                Start Editing
              </>
            )}
          </Button>

          <p className="text-xs text-center text-muted-foreground">
            Takes 1-2 minutes depending on video length
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
