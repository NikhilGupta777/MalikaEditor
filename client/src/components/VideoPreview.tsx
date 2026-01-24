import { useState, useRef, useEffect, useCallback } from "react";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize2,
  SkipBack,
  SkipForward,
  Film,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

interface VideoPreviewProps {
  src?: string;
  poster?: string;
  className?: string;
  currentTime?: number;
  onTimeUpdate?: (time: number) => void;
  onDurationChange?: (duration: number) => void;
}

export function VideoPreview({
  src,
  poster,
  className,
  currentTime: externalTime,
  onTimeUpdate,
  onDurationChange,
}: VideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [internalTime, setInternalTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [showControls, setShowControls] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSeeking, setIsSeeking] = useState(false);

  const currentTime = externalTime !== undefined ? externalTime : internalTime;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleTimeUpdate = () => {
      if (!isSeeking) {
        const time = video.currentTime;
        setInternalTime(time);
        onTimeUpdate?.(time);
      }
    };

    const handleDurationChange = () => {
      if (video.duration && isFinite(video.duration)) {
        setDuration(video.duration);
        onDurationChange?.(video.duration);
      }
    };

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleEnded = () => setIsPlaying(false);
    const handleLoadedMetadata = () => {
      setIsLoaded(true);
      setError(null);
      if (video.duration && isFinite(video.duration)) {
        setDuration(video.duration);
        onDurationChange?.(video.duration);
      }
    };
    const handleCanPlay = () => {
      setIsLoaded(true);
      setError(null);
      if (video.duration && isFinite(video.duration)) {
        setDuration(video.duration);
        onDurationChange?.(video.duration);
      }
    };
    const handleLoadedData = () => {
      setIsLoaded(true);
      setError(null);
    };
    const handleError = () => {
      setError("Failed to load video");
      setIsLoaded(false);
    };
    const handleSeeked = () => {
      setIsSeeking(false);
    };

    video.addEventListener("timeupdate", handleTimeUpdate);
    video.addEventListener("durationchange", handleDurationChange);
    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePause);
    video.addEventListener("ended", handleEnded);
    video.addEventListener("loadedmetadata", handleLoadedMetadata);
    video.addEventListener("loadeddata", handleLoadedData);
    video.addEventListener("canplay", handleCanPlay);
    video.addEventListener("error", handleError);
    video.addEventListener("seeked", handleSeeked);

    return () => {
      video.removeEventListener("timeupdate", handleTimeUpdate);
      video.removeEventListener("durationchange", handleDurationChange);
      video.removeEventListener("play", handlePlay);
      video.removeEventListener("pause", handlePause);
      video.removeEventListener("ended", handleEnded);
      video.removeEventListener("loadedmetadata", handleLoadedMetadata);
      video.removeEventListener("loadeddata", handleLoadedData);
      video.removeEventListener("canplay", handleCanPlay);
      video.removeEventListener("error", handleError);
      video.removeEventListener("seeked", handleSeeked);
    };
  }, [isSeeking, onTimeUpdate, onDurationChange]);

  useEffect(() => {
    if (src && videoRef.current) {
      setIsLoaded(false);
      setError(null);
      setInternalTime(0);
      setDuration(0);
      setIsPlaying(false);
      
      const video = videoRef.current;
      video.load();
      
      const loadTimeout = setTimeout(() => {
        if (video.readyState >= 2) {
          setIsLoaded(true);
          if (video.duration && isFinite(video.duration)) {
            setDuration(video.duration);
            onDurationChange?.(video.duration);
          }
        }
      }, 1000);
      
      return () => clearTimeout(loadTimeout);
    }
  }, [src, onDurationChange]);

  useEffect(() => {
    const video = videoRef.current;
    if (
      video &&
      isLoaded &&
      externalTime !== undefined &&
      Math.abs(video.currentTime - externalTime) > 0.5
    ) {
      setIsSeeking(true);
      video.currentTime = externalTime;
    }
  }, [externalTime, isLoaded]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video || !isLoaded) return;

    if (isPlaying) {
      video.pause();
    } else {
      video.play().catch(console.error);
    }
  }, [isLoaded, isPlaying]);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    video.muted = !video.muted;
    setIsMuted(video.muted);
  }, []);

  const handleSeek = useCallback(
    (value: number[]) => {
      const video = videoRef.current;
      if (!video || !isLoaded) return;

      const newTime = value[0];
      setIsSeeking(true);
      video.currentTime = newTime;
      setInternalTime(newTime);
      onTimeUpdate?.(newTime);
    },
    [isLoaded, onTimeUpdate]
  );

  const handleVolumeChange = useCallback((value: number[]) => {
    const video = videoRef.current;
    if (!video) return;

    video.volume = value[0];
    setVolume(value[0]);
    setIsMuted(value[0] === 0);
  }, []);

  const skipBackward = useCallback(() => {
    const video = videoRef.current;
    if (!video || !isLoaded) return;

    const newTime = Math.max(0, video.currentTime - 10);
    setIsSeeking(true);
    video.currentTime = newTime;
    setInternalTime(newTime);
    onTimeUpdate?.(newTime);
  }, [isLoaded, onTimeUpdate]);

  const skipForward = useCallback(() => {
    const video = videoRef.current;
    if (!video || !isLoaded) return;

    const newTime = Math.min(duration, video.currentTime + 10);
    setIsSeeking(true);
    video.currentTime = newTime;
    setInternalTime(newTime);
    onTimeUpdate?.(newTime);
  }, [duration, isLoaded, onTimeUpdate]);

  const toggleFullscreen = useCallback(async () => {
    const container = containerRef.current;
    if (!container) return;

    try {
      if (isFullscreen) {
        await document.exitFullscreen();
      } else {
        await container.requestFullscreen();
      }
    } catch (err) {
      console.error("Fullscreen error:", err);
    }
  }, [isFullscreen]);

  const formatTime = (time: number): string => {
    if (!isFinite(time) || isNaN(time)) return "0:00";
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  if (!src) {
    return (
      <div
        className={cn(
          "aspect-video bg-card rounded-lg flex items-center justify-center border border-card-border",
          className
        )}
        data-testid="video-preview-empty"
      >
        <div className="text-center text-muted-foreground">
          <Film className="h-16 w-16 mx-auto mb-4 opacity-50" />
          <p className="text-lg font-medium">No video loaded</p>
          <p className="text-sm">Upload a video to get started</p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative aspect-video bg-black rounded-lg overflow-hidden group",
        className
      )}
      onMouseEnter={() => setShowControls(true)}
      onMouseLeave={() => !isFullscreen && setShowControls(false)}
      data-testid="video-preview"
    >
      <video
        ref={videoRef}
        src={src}
        poster={poster}
        className="w-full h-full object-contain"
        onClick={togglePlay}
        playsInline
        preload="auto"
        crossOrigin="anonymous"
      />

      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          <div className="text-center text-white">
            <Film className="h-12 w-12 mx-auto mb-2 opacity-50" />
            <p>{error}</p>
          </div>
        </div>
      )}

      {!isPlaying && !error && isLoaded && (
        <div
          className="absolute inset-0 flex items-center justify-center bg-black/30 cursor-pointer"
          onClick={togglePlay}
        >
          <div className="p-4 rounded-full bg-primary/90">
            <Play className="h-8 w-8 text-primary-foreground fill-current" />
          </div>
        </div>
      )}

      {!isLoaded && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          <div className="text-center text-white">
            <div className="h-8 w-8 border-2 border-white border-t-transparent rounded-full animate-spin mx-auto mb-2" />
            <p className="text-sm">Loading video...</p>
          </div>
        </div>
      )}

      <div
        className={cn(
          "absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-4 transition-opacity",
          showControls || !isPlaying ? "opacity-100" : "opacity-0"
        )}
      >
        <div className="mb-3">
          <Slider
            value={[currentTime]}
            min={0}
            max={duration || 100}
            step={0.1}
            onValueChange={handleSeek}
            className="cursor-pointer"
            disabled={!isLoaded}
            data-testid="slider-video-progress"
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={skipBackward}
              className="text-white hover:bg-white/20"
              disabled={!isLoaded}
              data-testid="button-skip-back"
            >
              <SkipBack className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={togglePlay}
              className="text-white hover:bg-white/20"
              disabled={!isLoaded}
              data-testid="button-play-pause"
            >
              {isPlaying ? (
                <Pause className="h-5 w-5" />
              ) : (
                <Play className="h-5 w-5 fill-current" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={skipForward}
              className="text-white hover:bg-white/20"
              disabled={!isLoaded}
              data-testid="button-skip-forward"
            >
              <SkipForward className="h-4 w-4" />
            </Button>

            <div className="flex items-center gap-2 ml-2">
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleMute}
                className="text-white hover:bg-white/20"
                data-testid="button-mute"
              >
                {isMuted || volume === 0 ? (
                  <VolumeX className="h-4 w-4" />
                ) : (
                  <Volume2 className="h-4 w-4" />
                )}
              </Button>
              <Slider
                value={[isMuted ? 0 : volume]}
                min={0}
                max={1}
                step={0.1}
                onValueChange={handleVolumeChange}
                className="w-20"
                data-testid="slider-volume"
              />
            </div>
          </div>

          <div className="flex items-center gap-4">
            <span className="text-white text-sm font-mono">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleFullscreen}
              className="text-white hover:bg-white/20"
              data-testid="button-fullscreen"
            >
              <Maximize2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
