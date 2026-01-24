import { useState } from "react";
import { ChevronDown, ChevronUp, Image, Film, ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { StockMediaItem } from "@shared/schema";

interface StockMediaPreviewProps {
  stockMedia: StockMediaItem[] | null;
  isLoading?: boolean;
}

export function StockMediaPreview({ stockMedia, isLoading }: StockMediaPreviewProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Image className="h-5 w-5 text-accent" />
            Stock Media
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-2">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="aspect-video bg-muted animate-pulse rounded-md"
              />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!stockMedia || stockMedia.length === 0) {
    return null;
  }

  const images = stockMedia.filter((m) => m.type === "image");
  const videos = stockMedia.filter((m) => m.type === "video");

  return (
    <Card data-testid="stock-media-preview">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Image className="h-5 w-5 text-accent" />
            Stock Media
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="gap-1">
              <Image className="h-3 w-3" />
              {images.length}
            </Badge>
            <Badge variant="secondary" className="gap-1">
              <Film className="h-3 w-3" />
              {videos.length}
            </Badge>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setIsExpanded(!isExpanded)}
              data-testid="button-toggle-stock-expand"
            >
              {isExpanded ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ScrollArea className={isExpanded ? "h-64" : "h-32"}>
          <div className="grid grid-cols-3 gap-2">
            {stockMedia.slice(0, isExpanded ? undefined : 6).map((item, index) => (
              <a
                key={index}
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="relative group aspect-video rounded-md overflow-hidden bg-muted"
                data-testid={`stock-media-item-${index}`}
              >
                <img
                  src={item.thumbnailUrl || item.url}
                  alt={item.query}
                  className="w-full h-full object-cover"
                />
                <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <ExternalLink className="h-4 w-4 text-white" />
                </div>
                <div className="absolute bottom-0 left-0 right-0 p-1 bg-gradient-to-t from-black/80 to-transparent">
                  <div className="flex items-center gap-1">
                    {item.type === "video" ? (
                      <Film className="h-3 w-3 text-white/80" />
                    ) : (
                      <Image className="h-3 w-3 text-white/80" />
                    )}
                    <span className="text-xs text-white/80 truncate">
                      {item.query}
                    </span>
                  </div>
                </div>
              </a>
            ))}
          </div>
          {!isExpanded && stockMedia.length > 6 && (
            <p className="text-xs text-muted-foreground text-center mt-2">
              +{stockMedia.length - 6} more
            </p>
          )}
        </ScrollArea>
        {stockMedia[0]?.photographer && (
          <p className="text-xs text-muted-foreground mt-2">
            Media from Pexels
          </p>
        )}
      </CardContent>
    </Card>
  );
}
