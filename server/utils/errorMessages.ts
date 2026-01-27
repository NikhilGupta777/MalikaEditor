export interface UserFriendlyError {
  message: string;
  suggestion?: string;
  errorType: ErrorType;
}

export type ErrorType = 
  | "upload_failed"
  | "file_not_found"
  | "video_processing"
  | "transcription"
  | "ai_api"
  | "rate_limit"
  | "network"
  | "timeout"
  | "permission"
  | "storage"
  | "unknown";

interface ErrorPattern {
  patterns: (string | RegExp)[];
  errorType: ErrorType;
  message: string;
  suggestion: string;
}

const ERROR_PATTERNS: ErrorPattern[] = [
  {
    patterns: ["ENOENT", "no such file", "file not found"],
    errorType: "file_not_found",
    message: "File not found",
    suggestion: "Please try uploading your video again",
  },
  {
    patterns: ["ENOSPC", "no space left", "disk full", "quota exceeded"],
    errorType: "storage",
    message: "Storage space is full",
    suggestion: "Please try again later or contact support",
  },
  {
    patterns: ["EACCES", "EPERM", "permission denied"],
    errorType: "permission",
    message: "Permission denied",
    suggestion: "Please try uploading again or contact support",
  },
  {
    patterns: ["FFmpeg", "ffmpeg", "ffprobe", "Invalid data found", "could not find codec", "Discarding invalid"],
    errorType: "video_processing",
    message: "Video processing failed",
    suggestion: "Try uploading a different video format (MP4, MOV, or WebM work best)",
  },
  {
    patterns: ["corrupt", "damaged", "truncated", "moov atom not found"],
    errorType: "video_processing",
    message: "Video file appears to be corrupted",
    suggestion: "Please try re-exporting your video or use a different file",
  },
  {
    patterns: ["unsupported codec", "unsupported format", "Invalid data found when processing input"],
    errorType: "video_processing",
    message: "Unsupported video format",
    suggestion: "Please convert your video to MP4 (H.264) format and try again",
  },
  {
    patterns: ["transcription", "speech-to-text", "audio extraction failed"],
    errorType: "transcription",
    message: "Could not transcribe audio",
    suggestion: "Make sure your video has clear audio. Videos with no speech or very low audio may fail",
  },
  {
    patterns: ["rate limit", "429", "too many requests", "quota", "resource_exhausted"],
    errorType: "rate_limit",
    message: "Service is temporarily busy",
    suggestion: "Please wait a few minutes and try again",
  },
  {
    patterns: ["API", "api error", "503", "502", "500", "service unavailable", "internal server error"],
    errorType: "ai_api",
    message: "AI service temporarily unavailable",
    suggestion: "Please wait a moment and try again. If the problem persists, try processing without AI images",
  },
  {
    patterns: ["ETIMEDOUT", "timeout", "timed out", "deadline exceeded", "socket hang up"],
    errorType: "timeout",
    message: "Request timed out",
    suggestion: "Your video may be too long or complex. Try a shorter video or check your connection",
  },
  {
    patterns: ["ECONNREFUSED", "ECONNRESET", "network error", "connection refused", "connection reset"],
    errorType: "network",
    message: "Connection problem",
    suggestion: "Please check your internet connection and try again",
  },
  {
    patterns: ["file too large", "payload too large", "request entity too large"],
    errorType: "upload_failed",
    message: "Video file is too large",
    suggestion: "Please upload a video under 1GB. Try compressing the video or using a shorter clip",
  },
  {
    patterns: ["only video files", "invalid file type", "unsupported file"],
    errorType: "upload_failed",
    message: "Invalid file type",
    suggestion: "Please upload a video file (MP4, MOV, WebM, or AVI)",
  },
  {
    patterns: ["duration exceeds", "video too long", "maximum duration"],
    errorType: "upload_failed",
    message: "Video is too long",
    suggestion: "Please upload a shorter video (under 30 minutes)",
  },
  {
    patterns: ["no audio", "audio track not found", "no audio stream"],
    errorType: "transcription",
    message: "No audio track found",
    suggestion: "Your video appears to have no audio. Transcription and some features require audio",
  },
  {
    patterns: ["memory", "out of memory", "heap", "allocation failed"],
    errorType: "video_processing",
    message: "Video is too complex to process",
    suggestion: "Try uploading a shorter video or a lower resolution version",
  },
  {
    patterns: ["OpenAI", "openai", "Gemini", "gemini", "AI model"],
    errorType: "ai_api",
    message: "AI service error",
    suggestion: "The AI service encountered an issue. Try again or disable AI image generation",
  },
  {
    patterns: ["Pexels", "pexels", "stock media"],
    errorType: "ai_api",
    message: "Could not fetch stock media",
    suggestion: "Stock media service is temporarily unavailable. Try again or disable B-roll option",
  },
];

export function getUserFriendlyError(error: Error | string): UserFriendlyError {
  const errorMessage = typeof error === "string" ? error : error.message;
  
  // Check error.cause for additional context (chained errors)
  let causeMessage = "";
  if (error instanceof Error && error.cause) {
    const cause = error.cause;
    if (cause instanceof Error) {
      causeMessage = cause.message;
    } else if (typeof cause === "string") {
      causeMessage = cause;
    }
  }
  
  const lowerMessage = (errorMessage + " " + causeMessage).toLowerCase();

  for (const pattern of ERROR_PATTERNS) {
    for (const p of pattern.patterns) {
      const matches = typeof p === "string" 
        ? lowerMessage.includes(p.toLowerCase())
        : p.test(errorMessage);
      
      if (matches) {
        return {
          message: pattern.message,
          suggestion: pattern.suggestion,
          errorType: pattern.errorType,
        };
      }
    }
  }

  return {
    message: "Something went wrong",
    suggestion: "Please try again. If the problem persists, try a different video or contact support",
    errorType: "unknown",
  };
}

export function getErrorTypeIcon(errorType: ErrorType): string {
  switch (errorType) {
    case "upload_failed":
      return "upload";
    case "file_not_found":
      return "file";
    case "video_processing":
      return "video";
    case "transcription":
      return "mic";
    case "ai_api":
      return "brain";
    case "rate_limit":
      return "clock";
    case "network":
      return "wifi";
    case "timeout":
      return "timer";
    case "permission":
      return "lock";
    case "storage":
      return "database";
    default:
      return "alert";
  }
}

export function formatErrorForSSE(error: Error | string): { error: string; suggestion?: string; errorType: ErrorType } {
  const friendlyError = getUserFriendlyError(error);
  return {
    error: friendlyError.message,
    suggestion: friendlyError.suggestion,
    errorType: friendlyError.errorType,
  };
}
