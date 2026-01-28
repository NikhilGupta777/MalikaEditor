import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";

let geminiClient: GoogleGenAI | null = null;
let videoAnalysisGeminiClient: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI {
  if (!geminiClient) {
    if (!process.env.AI_INTEGRATIONS_GEMINI_API_KEY) {
      throw new Error('Gemini API key is not configured. Please set up the Gemini integration.');
    }
    geminiClient = new GoogleGenAI({
      apiKey: process.env.AI_INTEGRATIONS_GEMINI_API_KEY,
      httpOptions: {
        apiVersion: "",
        baseUrl: process.env.AI_INTEGRATIONS_GEMINI_BASE_URL,
      },
    });
  }
  return geminiClient;
}

// Separate Gemini client for video analysis using user's own API key
export function getVideoAnalysisGeminiClient(): GoogleGenAI {
  if (!videoAnalysisGeminiClient) {
    // Use user's own API key for video analysis, fall back to Replit integration
    const apiKey = process.env.GEMINI_VIDEO_ANALYSIS_API_KEY || process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('Gemini API key for video analysis is not configured. Please set GEMINI_VIDEO_ANALYSIS_API_KEY.');
    }
    videoAnalysisGeminiClient = new GoogleGenAI({
      apiKey: apiKey,
      // Use direct Google API when using user's own key
      httpOptions: process.env.GEMINI_VIDEO_ANALYSIS_API_KEY ? undefined : {
        apiVersion: "",
        baseUrl: process.env.AI_INTEGRATIONS_GEMINI_BASE_URL,
      },
    });
  }
  return videoAnalysisGeminiClient;
}

let openaiClient: OpenAI | null = null;

export function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
      throw new Error('OpenAI API key is not configured. Please set up the OpenAI integration.');
    }
    openaiClient = new OpenAI({
      apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
      baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || "https://api.openai.com/v1",
    });
  }
  return openaiClient;
}
