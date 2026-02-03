import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";

let geminiClient: GoogleGenAI | null = null;
let videoAnalysisGeminiClient: GoogleGenAI | null = null;

/**
 * Get Gemini API key - prefers user's own key from .env (GEMINI_API_KEY),
 * falls back to Replit integration (AI_INTEGRATIONS_GEMINI_API_KEY).
 */
function getGeminiApiKey(): string {
  const key = process.env.GEMINI_API_KEY || process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
  if (!key) {
    throw new Error('Gemini API key is not configured. Please set GEMINI_API_KEY or AI_INTEGRATIONS_GEMINI_API_KEY.');
  }
  return key;
}

/**
 * Use Replit proxy only when using Replit integration key.
 * User's GEMINI_API_KEY must use direct Google API.
 */
function useReplitProxy(): boolean {
  return !process.env.GEMINI_API_KEY && !!process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
}

export function getGeminiClient(): GoogleGenAI {
  if (!geminiClient) {
    const apiKey = getGeminiApiKey();
    geminiClient = new GoogleGenAI({
      apiKey,
      httpOptions: useReplitProxy() && process.env.AI_INTEGRATIONS_GEMINI_BASE_URL
        ? { apiVersion: "", baseUrl: process.env.AI_INTEGRATIONS_GEMINI_BASE_URL }
        : undefined,
    });
  }
  return geminiClient;
}

/**
 * Video analysis client - uses same key as getGeminiClient (GEMINI_API_KEY for all Gemini tasks).
 */
export function getVideoAnalysisGeminiClient(): GoogleGenAI {
  if (!videoAnalysisGeminiClient) {
    const apiKey = getGeminiApiKey();
    videoAnalysisGeminiClient = new GoogleGenAI({
      apiKey,
      httpOptions: useReplitProxy() && process.env.AI_INTEGRATIONS_GEMINI_BASE_URL
        ? { apiVersion: "", baseUrl: process.env.AI_INTEGRATIONS_GEMINI_BASE_URL }
        : undefined,
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
