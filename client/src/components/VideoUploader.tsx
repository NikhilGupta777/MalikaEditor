import { useState, useCallback } from "react";
import { Upload, Film, X, AlertCircle, CloudUpload, CheckCircle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

interface VideoUploaderProps {
  onUpload: (file: File) => void;
  onCancel?: () => void;
  isUploading: boolean;
  uploadProgress: number;
  maxSizeGB?: number;
}

export function VideoUploader({
  onUpload,
  onCancel,
  isUploading,
  uploadProgress,
  maxSizeGB = 1,
}: VideoUploaderProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  const maxSizeBytes = maxSizeGB * 1024 * 1024 * 1024;

  const validateFile = useCallback(
    (file: File): boolean => {
      setError(null);

      if (!file.type.startsWith("video/")) {
        setError("Please upload a video file (MP4, MOV, AVI, etc.)");
        return false;
      }

      if (file.size > maxSizeBytes) {
        setError(`File size exceeds ${maxSizeGB}GB limit`);
        return false;
      }

      return true;
    },
    [maxSizeBytes, maxSizeGB]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);

      const file = e.dataTransfer.files[0];
      if (file && validateFile(file)) {
        setSelectedFile(file);
      }
    },
    [validateFile]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file && validateFile(file)) {
        setSelectedFile(file);
      }
    },
    [validateFile]
  );

  const handleUpload = () => {
    if (selectedFile) {
      onUpload(selectedFile);
    }
  };

  const clearSelection = () => {
    setSelectedFile(null);
    setError(null);
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    if (bytes < 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  if (isUploading) {
    return (
      <Card className="p-8 border-2 border-primary/30 bg-primary/5">
        <div className="flex flex-col items-center gap-6">
          <div className="relative">
            <div className="absolute inset-0 bg-primary/20 blur-xl rounded-full animate-pulse" />
            <div className="relative p-6 rounded-full bg-primary/10">
              <CloudUpload className="h-12 w-12 text-primary animate-bounce" />
            </div>
          </div>
          <div className="text-center">
            <p className="font-bold text-xl mb-1">Uploading Video</p>
            <p className="text-sm text-muted-foreground truncate max-w-[250px]">
              {selectedFile?.name}
            </p>
          </div>
          <div className="w-full space-y-4">
            <Progress value={uploadProgress} className="h-3" />
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">
                {formatFileSize((selectedFile?.size || 0) * (uploadProgress / 100))}
              </span>
              <span className="font-semibold text-primary">
                {uploadProgress.toFixed(0)}%
              </span>
            </div>
          </div>
          {onCancel && (
            <Button
              variant="outline"
              size="sm"
              onClick={onCancel}
              className="mt-2 text-muted-foreground hover:text-destructive"
              data-testid="button-cancel-upload"
            >
              <X className="h-4 w-4 mr-2" />
              Cancel Upload
            </Button>
          )}
        </div>
      </Card>
    );
  }

  if (selectedFile) {
    return (
      <Card className="p-6 border-2 border-primary/30 bg-gradient-to-br from-primary/5 to-transparent">
        <div className="flex flex-col items-center gap-5">
          <div className="relative">
            <div className="p-5 rounded-2xl bg-primary/10 border border-primary/20">
              <Film className="h-10 w-10 text-primary" />
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="absolute -top-2 -right-2 h-7 w-7 rounded-full bg-destructive hover:bg-destructive/90 text-destructive-foreground"
              onClick={clearSelection}
              data-testid="button-clear-file"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          
          <div className="text-center">
            <p className="font-semibold text-lg truncate max-w-[280px]">
              {selectedFile.name}
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              {formatFileSize(selectedFile.size)}
            </p>
          </div>

          <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
            <CheckCircle className="h-4 w-4" />
            <span>Ready to upload</span>
          </div>
          
          <Button 
            onClick={handleUpload} 
            className="w-full gap-2 h-12 text-base font-semibold" 
            size="lg"
            data-testid="button-start-upload"
          >
            <Upload className="h-5 w-5" />
            Upload Video
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card
      className={cn(
        "p-8 border-2 border-dashed transition-all cursor-pointer",
        isDragging
          ? "border-primary bg-primary/10 scale-[1.02]"
          : "border-muted-foreground/30 hover:border-primary/50 hover:bg-muted/50"
      )}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      data-testid="dropzone-video"
    >
      <label className="flex flex-col items-center gap-5 cursor-pointer">
        <div className={cn(
          "p-5 rounded-2xl transition-all",
          isDragging ? "bg-primary/20" : "bg-muted"
        )}>
          <Upload className={cn(
            "h-12 w-12 transition-all",
            isDragging ? "text-primary scale-110" : "text-muted-foreground"
          )} />
        </div>
        <div className="text-center">
          <p className="font-bold text-xl mb-2">
            {isDragging ? "Drop it here!" : "Drop your video here"}
          </p>
          <p className="text-muted-foreground">
            or <span className="text-primary font-medium">browse files</span>
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2 text-xs text-muted-foreground">
          <span className="px-2 py-1 rounded bg-muted">MP4</span>
          <span className="px-2 py-1 rounded bg-muted">MOV</span>
          <span className="px-2 py-1 rounded bg-muted">AVI</span>
          <span className="px-2 py-1 rounded bg-muted">WebM</span>
          <span className="px-2 py-1 rounded bg-muted">Up to {maxSizeGB}GB</span>
        </div>
        <input
          type="file"
          accept="video/*"
          onChange={handleFileSelect}
          className="hidden"
          data-testid="input-video-file"
        />
      </label>

      {error && (
        <div className="mt-4 flex items-center justify-center gap-2 text-destructive text-sm">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      )}
    </Card>
  );
}
