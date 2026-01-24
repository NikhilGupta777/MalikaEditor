import { useState, useCallback } from "react";
import { Upload, Film, X, AlertCircle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

interface VideoUploaderProps {
  onUpload: (file: File) => void;
  isUploading: boolean;
  uploadProgress: number;
  maxSizeGB?: number;
}

export function VideoUploader({
  onUpload,
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
      <Card className="p-8 border-2 border-dashed border-primary/50">
        <div className="flex flex-col items-center gap-4">
          <div className="relative">
            <Film className="h-16 w-16 text-primary animate-pulse" />
          </div>
          <div className="text-center">
            <p className="font-medium text-lg">Uploading video...</p>
            <p className="text-sm text-muted-foreground mt-1">
              {selectedFile?.name}
            </p>
          </div>
          <div className="w-full max-w-md">
            <Progress value={uploadProgress} className="h-2" />
            <p className="text-center text-sm text-muted-foreground mt-2">
              {uploadProgress.toFixed(0)}%
            </p>
          </div>
        </div>
      </Card>
    );
  }

  if (selectedFile) {
    return (
      <Card className="p-8 border-2 border-primary/30">
        <div className="flex flex-col items-center gap-4">
          <div className="relative p-4 rounded-full bg-primary/10">
            <Film className="h-12 w-12 text-primary" />
            <Button
              variant="ghost"
              size="icon"
              className="absolute -top-1 -right-1 h-6 w-6 rounded-full bg-destructive text-destructive-foreground"
              onClick={clearSelection}
              data-testid="button-clear-file"
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
          <div className="text-center">
            <p className="font-medium text-lg truncate max-w-xs">
              {selectedFile.name}
            </p>
            <p className="text-sm text-muted-foreground">
              {formatFileSize(selectedFile.size)}
            </p>
          </div>
          <Button onClick={handleUpload} className="gap-2" data-testid="button-start-upload">
            <Upload className="h-4 w-4" />
            Upload & Process
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
          ? "border-primary bg-primary/5 drop-zone-active"
          : "border-muted-foreground/30 hover:border-primary/50"
      )}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      data-testid="dropzone-video"
    >
      <label className="flex flex-col items-center gap-4 cursor-pointer">
        <div className="p-4 rounded-full bg-muted">
          <Upload className="h-10 w-10 text-muted-foreground" />
        </div>
        <div className="text-center">
          <p className="font-medium text-lg">
            {isDragging ? "Drop your video here" : "Drag & drop your video"}
          </p>
          <p className="text-sm text-muted-foreground mt-1">
            or click to browse
          </p>
          <p className="text-xs text-muted-foreground mt-2">
            Supports MP4, MOV, AVI up to {maxSizeGB}GB
          </p>
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
        <div className="mt-4 flex items-center gap-2 text-destructive text-sm">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      )}
    </Card>
  );
}
