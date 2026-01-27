import axios from "axios";
import { z } from "zod";
import type { StockMediaItem } from "@shared/schema";
import { createLogger } from "../utils/logger";
import { AI_CONFIG } from "../config/ai";

const pexelsLogger = createLogger("pexels");

const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const PEXELS_BASE_URL = "https://api.pexels.com";

// Runtime validation schema for stock media items
const StockMediaItemSchema = z.object({
  type: z.enum(["image", "video"]),
  query: z.string(),
  url: z.string().url(),
  thumbnailUrl: z.string().optional(),
  photographer: z.string().optional(),
  duration: z.number().optional(),
});

function validateStockMediaItem(item: unknown): StockMediaItem | null {
  const result = StockMediaItemSchema.safeParse(item);
  if (!result.success) {
    pexelsLogger.debug("Invalid stock media item:", result.error.issues[0]);
    return null;
  }
  return result.data as StockMediaItem;
}

interface PexelsPhoto {
  id: number;
  url: string;
  photographer: string;
  src: {
    original: string;
    large: string;
    medium: string;
    small: string;
  };
}

interface PexelsVideo {
  id: number;
  url: string;
  user: { name: string };
  duration: number;
  video_files: Array<{
    id: number;
    quality: string;
    file_type: string;
    link: string;
    width: number;
    height: number;
  }>;
  video_pictures: Array<{
    id: number;
    picture: string;
  }>;
}

export async function searchPhotos(
  query: string,
  perPage: number = 3
): Promise<StockMediaItem[]> {
  if (!PEXELS_API_KEY) {
    pexelsLogger.warn("Pexels API key not configured");
    return [];
  }

  try {
    // Pexels photo search error often occurs with very long or complex queries
    const maxLength = AI_CONFIG.network.pexelsQueryMaxLength;
    const searchQuery = query.length > maxLength ? query.substring(0, maxLength).trim() : query;
    
    const response = await axios.get(`${PEXELS_BASE_URL}/v1/search`, {
      headers: {
        Authorization: PEXELS_API_KEY,
      },
      params: {
        query: searchQuery,
        per_page: perPage,
        orientation: "landscape",
      },
    });

    return response.data.photos
      .map((photo: PexelsPhoto) => {
        const item = {
          type: "image" as const,
          query,
          url: photo.src.large,
          thumbnailUrl: photo.src.small,
          photographer: photo.photographer,
        };
        return validateStockMediaItem(item);
      })
      .filter((item: StockMediaItem | null): item is StockMediaItem => item !== null);
  } catch (error) {
    pexelsLogger.error("Pexels photo search error", { query, error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

export async function searchVideos(
  query: string,
  perPage: number = 2
): Promise<StockMediaItem[]> {
  if (!PEXELS_API_KEY) {
    pexelsLogger.warn("Pexels API key not configured");
    return [];
  }

  try {
    // Use full query for AI-driven searches - Pexels handles long queries well
    // Only truncate extremely long queries (>100 chars) to prevent API issues
    const searchQuery = query.length > 100 ? query.substring(0, 100).trim() : query;
    
    const response = await axios.get(`${PEXELS_BASE_URL}/videos/search`, {
      headers: {
        Authorization: PEXELS_API_KEY,
      },
      params: {
        query: searchQuery,
        per_page: perPage,
        orientation: "landscape",
      },
    });

    const videos = response.data.videos || [];
    
    if (videos.length === 0) {
      pexelsLogger.debug(`No videos found for query: "${searchQuery.slice(0, 50)}..."`);
    }

    return videos
      .map((video: PexelsVideo) => {
        // Prefer HD, then SD, then any available file
        const hdFile = video.video_files.find((f) => f.quality === "hd") ||
          video.video_files.find((f) => f.quality === "sd") ||
          video.video_files[0];

        const item = {
          type: "video" as const,
          query,
          url: hdFile?.link || "",
          thumbnailUrl: video.video_pictures[0]?.picture || "",
          duration: video.duration,
          photographer: video.user.name,
        };
        return item.url ? validateStockMediaItem(item) : null;
      })
      .filter((item: StockMediaItem | null): item is StockMediaItem => item !== null);
  } catch (error) {
    pexelsLogger.error("Pexels video search error", { 
      query: query.slice(0, 50), 
      error: error instanceof Error ? error.message : String(error) 
    });
    return [];
  }
}

export interface StockMediaVariants {
  query: string;
  photos: StockMediaItem[];
  videos: StockMediaItem[];
  allItems: StockMediaItem[];
}

export async function fetchStockMediaWithVariants(
  queries: string[],
  photosPerQuery: number = 3,
  videosPerQuery: number = 3
): Promise<StockMediaVariants[]> {
  // No artificial limits - process all unique queries from AI
  const uniqueQueries = Array.from(new Set(queries));
  
  pexelsLogger.info(`Fetching ${photosPerQuery} photos + ${videosPerQuery} videos per query for ${uniqueQueries.length} queries (no limit)`);

  const results = await Promise.all(
    uniqueQueries.map(async (query) => {
      const [photos, videos] = await Promise.all([
        searchPhotos(query, photosPerQuery),
        searchVideos(query, videosPerQuery),
      ]);
      
      pexelsLogger.debug(`Query "${query.slice(0, 40)}...": ${photos.length} photos, ${videos.length} videos`);
      
      return {
        query,
        photos,
        videos,
        allItems: [...photos, ...videos],
      };
    })
  );

  const totalPhotos = results.reduce((sum, r) => sum + r.photos.length, 0);
  const totalVideos = results.reduce((sum, r) => sum + r.videos.length, 0);
  pexelsLogger.info(`Fetched ${totalPhotos} photos + ${totalVideos} videos across ${uniqueQueries.length} queries`);

  return results;
}

export async function fetchStockMedia(
  queries: string[]
): Promise<StockMediaItem[]> {
  // No artificial limits - process all unique queries from AI
  const uniqueQueries = Array.from(new Set(queries));

  const results = await Promise.all(
    uniqueQueries.flatMap((query) => [
      searchPhotos(query, 3),
      searchVideos(query, 3),
    ])
  );

  return results.flat();
}
