import axios from "axios";
import type { StockMediaItem } from "@shared/schema";
import { createLogger } from "../utils/logger";

const freepikLogger = createLogger("freepik");

const FREEPIK_API_KEY = process.env.FREEPIK_API_KEY;
const FREEPIK_BASE_URL = "https://api.freepik.com/v1";

interface FreepikResource {
  id: number;
  title: string;
  url: string;
  filename: string;
  image?: {
    type: "photo" | "vector" | "psd";
    orientation: string;
    source: {
      url: string;
      key: string;
      size: string;
    };
  };
  stats?: {
    downloads: number;
    likes: number;
  };
  author?: {
    id: number;
    name: string;
    avatar: string;
  };
}

interface FreepikVideo {
  id: number;
  url: string;
  name: string;
  "aspect-ratio": string;
  quality: string;
  premium: boolean;
  duration: string;
  author?: {
    id: number;
    name: string;
  };
  thumbnails?: Array<{
    width: number;
    height: number;
    url: string;
  }>;
  previews?: Array<{
    width: number;
    height: number;
    url: string;
  }>;
}

interface FreepikDownloadResponse {
  data: {
    filename: string;
    url: string;
    signed_url?: string;
  };
}

function parseDuration(durationStr: string): number {
  const parts = durationStr.split(":");
  if (parts.length === 2) {
    return parseInt(parts[0]) * 60 + parseInt(parts[1]);
  }
  return 0;
}

export async function searchFreepikPhotos(
  query: string,
  perPage: number = 3
): Promise<StockMediaItem[]> {
  if (!FREEPIK_API_KEY) {
    freepikLogger.debug("Freepik API key not configured, skipping");
    return [];
  }

  try {
    const searchQuery = query.length > 80 ? query.substring(0, 80).trim() : query;
    
    const response = await axios.get(`${FREEPIK_BASE_URL}/resources`, {
      headers: {
        "x-freepik-api-key": FREEPIK_API_KEY,
        "Accept-Language": "en-US",
      },
      params: {
        term: searchQuery,
        limit: perPage,
        order: "relevance",
        "filters[content_type][photo]": 1,
        "filters[orientation][landscape]": 1,
      },
      timeout: 15000,
    });

    const resources = response.data?.data || [];
    
    return resources
      .filter((resource: FreepikResource) => resource.image?.source?.url)
      .map((resource: FreepikResource) => ({
        type: "image" as const,
        query,
        url: resource.image!.source.url,
        thumbnailUrl: resource.image!.source.url,
        photographer: resource.author?.name || "Freepik",
        source: "freepik" as const,
        freepikId: resource.id,
      }));
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 401) {
      freepikLogger.warn("Freepik API key invalid or expired");
    } else if (axios.isAxiosError(error) && error.response?.status === 429) {
      freepikLogger.warn("Freepik API rate limit reached");
    } else {
      freepikLogger.error("Freepik photo search error", { 
        query: query.slice(0, 50), 
        error: error instanceof Error ? error.message : String(error) 
      });
    }
    return [];
  }
}

export async function searchFreepikVideos(
  query: string,
  perPage: number = 2
): Promise<StockMediaItem[]> {
  if (!FREEPIK_API_KEY) {
    freepikLogger.debug("Freepik API key not configured, skipping");
    return [];
  }

  try {
    const searchQuery = query.length > 80 ? query.substring(0, 80).trim() : query;
    
    const response = await axios.get(`${FREEPIK_BASE_URL}/videos`, {
      headers: {
        "x-freepik-api-key": FREEPIK_API_KEY,
        "Accept-Language": "en-US",
      },
      params: {
        term: searchQuery,
        limit: perPage,
        order: "relevance",
      },
      timeout: 15000,
    });

    const videos = response.data?.data || [];
    
    if (videos.length === 0) {
      freepikLogger.debug(`No Freepik videos found for query: "${searchQuery.slice(0, 50)}..."`);
    }

    return videos
      .map((video: FreepikVideo) => {
        const thumbnail = video.thumbnails?.find(t => t.width >= 400) || video.thumbnails?.[0];
        const preview = video.previews?.[0];
        
        return {
          type: "video" as const,
          query,
          url: preview?.url || thumbnail?.url || "",
          thumbnailUrl: thumbnail?.url || "",
          duration: parseDuration(video.duration),
          photographer: video.author?.name || "Freepik",
          source: "freepik" as const,
          freepikId: video.id,
          freepikPremium: video.premium,
        };
      })
      .filter((item: { url: string }) => item.url && item.url.length > 0);
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 401) {
      freepikLogger.warn("Freepik API key invalid or expired");
    } else if (axios.isAxiosError(error) && error.response?.status === 429) {
      freepikLogger.warn("Freepik API rate limit reached");
    } else {
      freepikLogger.error("Freepik video search error", { 
        query: query.slice(0, 50), 
        error: error instanceof Error ? error.message : String(error) 
      });
    }
    return [];
  }
}

export async function getFreepikDownloadUrl(
  resourceId: number,
  resourceType: "image" | "video"
): Promise<string | null> {
  if (!FREEPIK_API_KEY) {
    freepikLogger.warn("Freepik API key not configured");
    return null;
  }

  try {
    const endpoint = resourceType === "video" 
      ? `${FREEPIK_BASE_URL}/videos/${resourceId}/download`
      : `${FREEPIK_BASE_URL}/resources/${resourceId}/download`;
    
    const response = await axios.get<FreepikDownloadResponse>(endpoint, {
      headers: {
        "x-freepik-api-key": FREEPIK_API_KEY,
      },
      timeout: 15000,
    });

    return response.data?.data?.url || response.data?.data?.signed_url || null;
  } catch (error) {
    freepikLogger.error("Freepik download URL error", { 
      resourceId, 
      resourceType,
      error: error instanceof Error ? error.message : String(error) 
    });
    return null;
  }
}

export interface FreepikMediaVariants {
  query: string;
  photos: StockMediaItem[];
  videos: StockMediaItem[];
  allItems: StockMediaItem[];
}

export async function fetchFreepikMediaWithVariants(
  queries: string[],
  photosPerQuery: number = 2,
  videosPerQuery: number = 2
): Promise<FreepikMediaVariants[]> {
  if (!FREEPIK_API_KEY) {
    freepikLogger.debug("Freepik API key not configured, skipping all queries");
    return queries.map(query => ({ query, photos: [], videos: [], allItems: [] }));
  }

  const uniqueQueries = Array.from(new Set(queries));
  
  freepikLogger.info(`Fetching ${photosPerQuery} photos + ${videosPerQuery} videos per query for ${uniqueQueries.length} Freepik queries`);

  const results = await Promise.all(
    uniqueQueries.map(async (query) => {
      const [photos, videos] = await Promise.all([
        searchFreepikPhotos(query, photosPerQuery),
        searchFreepikVideos(query, videosPerQuery),
      ]);
      
      freepikLogger.debug(`Freepik query "${query.slice(0, 40)}...": ${photos.length} photos, ${videos.length} videos`);
      
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
  freepikLogger.info(`Fetched ${totalPhotos} photos + ${totalVideos} videos from Freepik across ${uniqueQueries.length} queries`);

  return results;
}

export function isFreepikConfigured(): boolean {
  return !!FREEPIK_API_KEY;
}
