import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";

let geminiClient: GoogleGenAI | null = null;

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

let openaiClient: OpenAI | null = null;

export function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
      throw new Error('OpenAI API key is not configured. Please set up the OpenAI integration.');
    }
    openaiClient = new OpenAI({
      apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
      baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
    });
  }
  return openaiClient;
}
