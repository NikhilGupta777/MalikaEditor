import { Download, Loader2, CheckCircle, Film } from "lucide-react";
import { Button } from "@/components/ui/button";

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
      <Button disabled className="w-full gap-2" size="lg">
        <Loader2 className="h-5 w-5 animate-spin" />
        Processing Video...
      </Button>
    );
  }

  if (!isComplete || !outputPath) {
    return (
      <Button disabled variant="outline" className="w-full gap-2" size="lg">
        <Film className="h-5 w-5" />
        Download will be available after processing
      </Button>
    );
  }

  return (
    <Button
      onClick={handleDownload}
      className="w-full gap-2 bg-secondary hover:bg-secondary/90"
      size="lg"
      data-testid="button-download"
    >
      <Download className="h-5 w-5" />
      Download Edited Video
    </Button>
  );
}
