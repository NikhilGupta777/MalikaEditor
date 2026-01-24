import { Download, Loader2, Film, PartyPopper } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface DownloadButtonProps {
  outputPath?: string;
  isProcessing: boolean;
  isComplete: boolean;
}

export function DownloadButton({
  outputPath,
  isProcessing,
  isComplete,
}: DownloadButtonProps) {
  const handleDownload = () => {
    if (outputPath) {
      const link = document.createElement("a");
      link.href = outputPath;
      link.download = "edited-video.mp4";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  if (isProcessing) {
    return (
      <Button disabled className="w-full gap-3 h-14" size="lg">
        <Loader2 className="h-5 w-5 animate-spin" />
        <div className="text-left">
          <span className="block font-semibold">Processing Video</span>
          <span className="block text-xs opacity-70">Please wait...</span>
        </div>
      </Button>
    );
  }

  if (!isComplete || !outputPath) {
    return (
      <Button disabled variant="outline" className="w-full gap-3 h-14" size="lg">
        <Film className="h-5 w-5 opacity-50" />
        <div className="text-left">
          <span className="block font-medium">Download</span>
          <span className="block text-xs opacity-70">Available after processing</span>
        </div>
      </Button>
    );
  }

  return (
    <Button
      onClick={handleDownload}
      className={cn(
        "w-full gap-3 h-14 font-semibold text-base",
        "bg-gradient-to-r from-secondary to-emerald-600 hover:from-secondary/90 hover:to-emerald-600/90",
        "shadow-lg shadow-secondary/25"
      )}
      size="lg"
      data-testid="button-download"
    >
      <Download className="h-6 w-6" />
      <div className="text-left">
        <span className="block">Download Edited Video</span>
        <span className="block text-xs opacity-80">MP4 format, ready to share</span>
      </div>
      <PartyPopper className="h-5 w-5 ml-auto" />
    </Button>
  );
}
