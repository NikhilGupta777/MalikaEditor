import { useCallback } from "react";
import { Download, Loader2 } from "lucide-react";
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
  const handleDownload = useCallback(() => {
    if (outputPath) {
      const link = document.createElement("a");
      link.href = outputPath;
      link.download = "edited-video.mp4";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  }, [outputPath]);

  if (isProcessing) {
    return (
      <Button disabled className="w-full gap-2" size="lg">
        <Loader2 className="h-4 w-4 animate-spin" />
        Processing...
      </Button>
    );
  }

  if (!isComplete || !outputPath) {
    return (
      <Button disabled variant="outline" className="w-full gap-2" size="lg">
        <Download className="h-4 w-4" />
        Download (available after processing)
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
      <Download className="h-4 w-4" />
      Download Edited Video
    </Button>
  );
}
