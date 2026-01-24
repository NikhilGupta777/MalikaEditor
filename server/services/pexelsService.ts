import axios from "axios";
import type { StockMediaItem } from "@shared/schema";

const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const PEXELS_BASE_URL = "https://api.pexels.com";

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
    console.warn("Pexels API key not configured");
    return [];
  }

  try {
    const response = await axios.get(`${PEXELS_BASE_URL}/v1/search`, {
      headers: {
        Authorization: PEXELS_API_KEY,
      },
      params: {
        query,
        per_page: perPage,
        orientation: "landscape",
      },
    });

    return response.data.photos.map((photo: PexelsPhoto) => ({
      type: "image" as const,
      query,
      url: photo.src.large,
      thumbnailUrl: photo.src.small,
      photographer: photo.photographer,
    }));
  } catch (error) {
    console.error("Pexels photo search error:", error);
    return [];
  }
}

export async function searchVideos(
  query: string,
  perPage: number = 2
): Promise<StockMediaItem[]> {
  if (!PEXELS_API_KEY) {
    console.warn("Pexels API key not configured");
    return [];
  }

  try {
    const response = await axios.get(`${PEXELS_BASE_URL}/videos/search`, {
      headers: {
        Authorization: PEXELS_API_KEY,
      },
      params: {
        query,
        per_page: perPage,
        orientation: "landscape",
        size: "medium",
      },
    });

    return response.data.videos.map((video: PexelsVideo) => {
      const hdFile = video.video_files.find((f) => f.quality === "hd") ||
        video.video_files.find((f) => f.quality === "sd") ||
        video.video_files[0];

      return {
        type: "video" as const,
        query,
        url: hdFile?.link || "",
        thumbnailUrl: video.video_pictures[0]?.picture || "",
        duration: video.duration,
        photographer: video.user.name,
      };
    });
  } catch (error) {
    console.error("Pexels video search error:", error);
    return [];
  }
}

export async function fetchStockMedia(
  queries: string[]
): Promise<StockMediaItem[]> {
  const uniqueQueries = [...new Set(queries)].slice(0, 5);

  const results = await Promise.all(
    uniqueQueries.flatMap((query) => [
      searchPhotos(query, 2),
      searchVideos(query, 1),
    ])
  );

  return results.flat();
}
