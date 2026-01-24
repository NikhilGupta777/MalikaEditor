import { Image, Video } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { StockMediaItem } from "@shared/schema";

interface StockMediaPreviewProps {
  stockMedia: StockMediaItem[] | null;
  isLoading?: boolean;
}

export function StockMediaPreview({ stockMedia, isLoading }: StockMediaPreviewProps) {
  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-3">
            <Image className="h-5 w-5 text-accent animate-pulse" />
            <span className="text-sm">Finding stock media...</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!stockMedia || stockMedia.length === 0) return null;

  const images = stockMedia.filter(m => m.type === "image");
  const videos = stockMedia.filter(m => m.type === "video");

  return (
    <Card data-testid="stock-media-preview">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-sm font-medium">
          <span className="flex items-center gap-2">
            <Image className="h-4 w-4 text-accent" />
            Stock Media
          </span>
          <div className="flex gap-2">
            {images.length > 0 && (
              <Badge variant="secondary" className="text-xs gap-1">
                <Image className="h-3 w-3" /> {images.length}
              </Badge>
            )}
            {videos.length > 0 && (
              <Badge variant="secondary" className="text-xs gap-1">
                <Video className="h-3 w-3" /> {videos.length}
              </Badge>
            )}
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="grid grid-cols-4 gap-1.5">
          {stockMedia.slice(0, 8).map((item, i) => (
            <div
              key={i}
              className="aspect-square rounded overflow-hidden bg-muted"
              data-testid={`stock-item-${i}`}
            >
              <img
                src={item.thumbnailUrl || item.url}
                alt={item.query}
                className="w-full h-full object-cover"
                loading="lazy"
              />
            </div>
          ))}
        </div>
        {stockMedia.length > 8 && (
          <p className="text-xs text-muted-foreground text-center mt-2">
            +{stockMedia.length - 8} more
          </p>
        )}
      </CardContent>
    </Card>
  );
}
