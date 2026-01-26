import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";

let geminiClient: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI {
  if (!geminiClient) {
    const apiKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY || "_DUMMY_API_KEY_";
    const baseUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL || "http://localhost:1106/modelfarm/gemini";
    
    geminiClient = new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        apiVersion: "",
        baseUrl: baseUrl,
      },
    });
  }
  return geminiClient;
}

let openaiClient: OpenAI | null = null;

export function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || "_DUMMY_API_KEY_";
    const baseUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || "http://localhost:1106/modelfarm/openai";
    
    openaiClient = new OpenAI({
      apiKey: apiKey,
      baseURL: baseUrl,
    });
  }
  return openaiClient;
}
