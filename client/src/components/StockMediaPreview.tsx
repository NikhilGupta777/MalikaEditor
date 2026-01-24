import { useState } from "react";
import { ChevronDown, ChevronUp, Image, Video, ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
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
          <CardTitle className="flex items-center gap-3 text-base">
            <div className="p-2 rounded-lg bg-accent/10">
              <Image className="h-5 w-5 text-accent animate-pulse" />
            </div>
            Finding Stock Media...
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-2">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="aspect-video bg-muted animate-pulse rounded-lg"
                style={{ animationDelay: `${i * 100}ms` }}
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
          <CardTitle className="flex items-center gap-3 text-base">
            <div className="p-2 rounded-lg bg-accent/10">
              <Image className="h-5 w-5 text-accent" />
            </div>
            <div>
              <span className="block">Stock Media</span>
              <span className="text-sm font-normal text-muted-foreground">
                {stockMedia.length} items found
              </span>
            </div>
          </CardTitle>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setIsExpanded(!isExpanded)}
            data-testid="button-toggle-stock-expand"
          >
            {isExpanded ? (
              <ChevronUp className="h-5 w-5" />
            ) : (
              <ChevronDown className="h-5 w-5" />
            )}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary */}
        <div className="flex gap-3">
          {images.length > 0 && (
            <Badge variant="secondary" className="gap-1.5">
              <Image className="h-3 w-3" />
              {images.length} Images
            </Badge>
          )}
          {videos.length > 0 && (
            <Badge variant="secondary" className="gap-1.5">
              <Video className="h-3 w-3" />
              {videos.length} Videos
            </Badge>
          )}
        </div>

        {/* Preview grid */}
        <div className="grid grid-cols-4 gap-2">
          {stockMedia.slice(0, 8).map((item, index) => (
            <div
              key={index}
              className="relative aspect-square rounded-lg overflow-hidden bg-muted group"
              data-testid={`stock-media-item-${index}`}
            >
              <img
                src={item.thumbnailUrl || item.url}
                alt={item.query}
                className="w-full h-full object-cover"
                loading="lazy"
              />
              <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                <div className={cn(
                  "p-1.5 rounded-full",
                  item.type === "video" ? "bg-accent" : "bg-primary"
                )}>
                  {item.type === "video" ? (
                    <Video className="h-3 w-3 text-white" />
                  ) : (
                    <Image className="h-3 w-3 text-white" />
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        {stockMedia.length > 8 && !isExpanded && (
          <p className="text-xs text-center text-muted-foreground">
            +{stockMedia.length - 8} more items
          </p>
        )}

        {/* Expanded view */}
        {isExpanded && (
          <div className="border-t pt-4">
            <ScrollArea className="h-64">
              <div className="space-y-3 pr-4">
                {stockMedia.map((item, index) => (
                  <div
                    key={index}
                    className="flex gap-3 p-2 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors"
                  >
                    <div className="relative w-20 h-14 rounded overflow-hidden flex-shrink-0">
                      <img
                        src={item.thumbnailUrl || item.url}
                        alt={item.query}
                        className="w-full h-full object-cover"
                      />
                      <div className="absolute bottom-0.5 right-0.5">
                        <div className={cn(
                          "p-0.5 rounded",
                          item.type === "video" ? "bg-accent" : "bg-primary"
                        )}>
                          {item.type === "video" ? (
                            <Video className="h-2.5 w-2.5 text-white" />
                          ) : (
                            <Image className="h-2.5 w-2.5 text-white" />
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{item.query}</p>
                      {item.photographer && (
                        <p className="text-xs text-muted-foreground">
                          by {item.photographer}
                        </p>
                      )}
                      {item.duration && (
                        <p className="text-xs text-muted-foreground">
                          {item.duration}s
                        </p>
                      )}
                    </div>
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-shrink-0 p-2 hover:bg-muted rounded"
                    >
                      <ExternalLink className="h-4 w-4 text-muted-foreground" />
                    </a>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        )}

        <p className="text-xs text-muted-foreground text-center">
          Media from Pexels
        </p>
      </CardContent>
    </Card>
  );
}
