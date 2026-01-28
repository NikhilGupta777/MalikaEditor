import { createLogger } from "../utils/logger";
import { getGeminiClient } from "./ai/clients";
import { AI_CONFIG } from "../config/ai";
import type { VideoAnalysis, EditPlan, TranscriptSegment, StockMediaItem, ReviewData } from "@shared/schema";

const chatLogger = createLogger("chat-companion");

export type MessageRole = "companion" | "user" | "system";
export type MessageType = "update" | "explanation" | "question" | "answer" | "milestone" | "insight";

export interface ChatMessage {
  id: string;
  projectId: number;
  role: MessageRole;
  type: MessageType;
  content: string;
  timestamp: Date;
  stage?: string;
  metadata?: Record<string, any>;
}

export interface ProjectContext {
  projectId: number;
  title?: string;
  status?: string;
  duration?: number;
  prompt?: string;
  videoAnalysis?: VideoAnalysis;
  transcript?: TranscriptSegment[];
  editPlan?: EditPlan;
  stockMedia?: StockMediaItem[];
  reviewData?: ReviewData;
  selfReviewScore?: number;
}

const projectMessages = new Map<number, ChatMessage[]>();
const projectContexts = new Map<number, ProjectContext>();

const MAX_MESSAGES_PER_PROJECT = 100;

function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

export function initializeProjectChat(projectId: number, title?: string): void {
  if (!projectMessages.has(projectId)) {
    projectMessages.set(projectId, []);
    projectContexts.set(projectId, { projectId, title });
    
    addCompanionMessage(projectId, "milestone", 
      `Hey there! I'm your AI editing companion. I'll guide you through the entire video editing process and explain what I'm doing at each step. Feel free to ask me anything along the way!`,
      "initialization"
    );
  }
}

export function updateProjectContext(projectId: number, updates: Partial<ProjectContext>): void {
  const existing = projectContexts.get(projectId) || { projectId };
  projectContexts.set(projectId, { ...existing, ...updates });
}

export function getProjectContext(projectId: number): ProjectContext | undefined {
  return projectContexts.get(projectId);
}

export function addCompanionMessage(
  projectId: number,
  type: MessageType,
  content: string,
  stage?: string,
  metadata?: Record<string, any>
): ChatMessage {
  const message: ChatMessage = {
    id: generateMessageId(),
    projectId,
    role: "companion",
    type,
    content,
    timestamp: new Date(),
    stage,
    metadata,
  };
  
  addMessage(projectId, message);
  chatLogger.debug(`[Project ${projectId}] Companion: ${content.substring(0, 80)}...`);
  
  return message;
}

export function addUserMessage(projectId: number, content: string): ChatMessage {
  const message: ChatMessage = {
    id: generateMessageId(),
    projectId,
    role: "user",
    type: "question",
    content,
    timestamp: new Date(),
  };
  
  addMessage(projectId, message);
  return message;
}

function addMessage(projectId: number, message: ChatMessage): void {
  if (!projectMessages.has(projectId)) {
    projectMessages.set(projectId, []);
  }
  
  const messages = projectMessages.get(projectId)!;
  messages.push(message);
  
  if (messages.length > MAX_MESSAGES_PER_PROJECT) {
    messages.shift();
  }
}

export function getProjectMessages(projectId: number, limit?: number): ChatMessage[] {
  const messages = projectMessages.get(projectId) || [];
  if (limit) {
    return messages.slice(-limit);
  }
  return [...messages];
}

export function clearProjectChat(projectId: number): void {
  projectMessages.delete(projectId);
  projectContexts.delete(projectId);
}

export async function answerUserQuestion(
  projectId: number,
  question: string
): Promise<ChatMessage> {
  const context = projectContexts.get(projectId);
  const recentMessages = getProjectMessages(projectId, 10);
  
  const conversationHistory = recentMessages
    .map(m => `${m.role === "companion" ? "Assistant" : "User"}: ${m.content}`)
    .join("\n");
  
  const contextSummary = buildContextSummary(context);
  
  const prompt = `You are an AI video editing companion having a friendly conversation with a user about their video project.

PROJECT CONTEXT:
${contextSummary}

RECENT CONVERSATION:
${conversationHistory}

USER'S NEW QUESTION:
"${question}"

INSTRUCTIONS:
1. Answer the user's question conversationally and helpfully
2. Reference specific details from the project when relevant
3. Explain technical concepts in simple terms
4. Be encouraging and supportive
5. If you don't have enough information, say so honestly
6. Keep responses concise but informative (2-4 sentences typically)
7. Use a friendly, professional tone

Your response:`;

  try {
    const gemini = getGeminiClient();
    const response = await gemini.models.generateContent({
      model: AI_CONFIG.models.editPlanning,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });
    
    const answerText = response.text || "I'm not sure how to answer that. Could you rephrase your question?";
    
    const answerMessage: ChatMessage = {
      id: generateMessageId(),
      projectId,
      role: "companion",
      type: "answer",
      content: answerText,
      timestamp: new Date(),
    };
    
    addMessage(projectId, answerMessage);
    return answerMessage;
    
  } catch (error) {
    chatLogger.error(`Failed to answer user question: ${error}`);
    
    const errorMessage: ChatMessage = {
      id: generateMessageId(),
      projectId,
      role: "companion",
      type: "answer",
      content: "I'm having trouble processing that right now. Let me focus on your video editing, and you can ask me again in a moment!",
      timestamp: new Date(),
    };
    
    addMessage(projectId, errorMessage);
    return errorMessage;
  }
}

function buildContextSummary(context?: ProjectContext): string {
  if (!context) {
    return "No project context available yet.";
  }
  
  const parts: string[] = [];
  
  if (context.title) {
    parts.push(`Video title: "${context.title}"`);
  }
  
  if (context.status) {
    parts.push(`Current status: ${context.status}`);
  }
  
  if (context.duration) {
    parts.push(`Video duration: ${context.duration} seconds`);
  }
  
  if (context.prompt) {
    parts.push(`User's editing request: "${context.prompt}"`);
  }
  
  if (context.videoAnalysis?.context) {
    const vc = context.videoAnalysis.context;
    parts.push(`Video genre: ${vc.genre}, tone: ${vc.tone}, pacing: ${vc.pacing}`);
  }
  
  if (context.transcript?.length) {
    parts.push(`Transcript: ${context.transcript.length} segments`);
  }
  
  if (context.editPlan?.actions?.length) {
    const cuts = context.editPlan.actions.filter(a => a.type === "cut").length;
    const keeps = context.editPlan.actions.filter(a => a.type === "keep").length;
    const broll = context.editPlan.actions.filter(a => a.type === "add_broll").length;
    parts.push(`Edit plan: ${cuts} cuts, ${keeps} keeps, ${broll} B-roll placements`);
  }
  
  if (context.stockMedia?.length) {
    parts.push(`Stock media fetched: ${context.stockMedia.length} items`);
  }
  
  if (context.selfReviewScore) {
    parts.push(`Self-review quality score: ${context.selfReviewScore}/100`);
  }
  
  return parts.length > 0 ? parts.join("\n") : "Project is being initialized...";
}

export function sendUploadUpdate(projectId: number, fileName: string, duration: number): void {
  addCompanionMessage(projectId, "update",
    `Great! I've received your video "${fileName}". It's ${duration} seconds long. Let me start analyzing it to understand what we're working with...`,
    "upload"
  );
}

export function sendTranscriptionUpdate(projectId: number, segmentCount: number, language?: string): void {
  const langNote = language ? ` I detected that the video is in ${language}.` : "";
  addCompanionMessage(projectId, "update",
    `I've transcribed the audio and found ${segmentCount} speech segments.${langNote} This transcript will help me understand the content and time my edits precisely.`,
    "transcription"
  );
}

export function sendAnalysisUpdate(projectId: number, analysis: VideoAnalysis): void {
  const genre = analysis.context?.genre || "general";
  const tone = analysis.context?.tone || "casual";
  const sceneCount = analysis.scenes?.length || 0;
  
  addCompanionMessage(projectId, "insight",
    `I've analyzed your video! It appears to be a ${genre} video with a ${tone} tone. I identified ${sceneCount} distinct scenes. Based on this, I'll tailor the editing style to match the content.`,
    "analysis",
    { genre, tone, sceneCount }
  );
}

export function sendEditPlanningUpdate(projectId: number, actionCounts: { cuts: number; keeps: number; broll: number }): void {
  addCompanionMessage(projectId, "explanation",
    `I've created an edit plan! Here's what I'm thinking: ${actionCounts.cuts} segments to cut (removing filler or repetitive parts), ${actionCounts.keeps} segments to keep (the important content), and ${actionCounts.broll} spots where I'll add B-roll footage to make it more engaging.`,
    "edit_planning",
    actionCounts
  );
}

export function sendMediaFetchingUpdate(projectId: number, queriesCount: number): void {
  addCompanionMessage(projectId, "update",
    `Now I'm searching for the perfect B-roll footage. I've identified ${queriesCount} different topics where visual support would enhance your video. I'll analyze thumbnails to pick the most relevant ones!`,
    "media_fetching"
  );
}

export function sendMediaSelectionUpdate(projectId: number, selectedCount: number, aiImageCount: number): void {
  const aiNote = aiImageCount > 0 ? ` I also generated ${aiImageCount} custom AI images for unique visuals.` : "";
  addCompanionMessage(projectId, "insight",
    `I've selected ${selectedCount} pieces of stock media for your B-roll.${aiNote} Each one was chosen based on visual relevance to your content.`,
    "media_selection",
    { selectedCount, aiImageCount }
  );
}

export function sendReviewReadyUpdate(projectId: number): void {
  addCompanionMessage(projectId, "milestone",
    `Everything is ready for your review! Take a look at the transcript and my edit suggestions. You can approve, reject, or modify any of my decisions. I'll explain my reasoning if you click on any edit action.`,
    "review_ready"
  );
}

export function sendRenderingUpdate(projectId: number): void {
  addCompanionMessage(projectId, "update",
    `You've approved the edits - now I'm rendering your final video. This involves applying all the cuts, adding B-roll overlays, syncing captions, and creating smooth transitions. This might take a few minutes...`,
    "rendering"
  );
}

export function sendSelfReviewUpdate(projectId: number, score: number, issueCount: number): void {
  const quality = score >= 90 ? "excellent" : score >= 70 ? "good" : score >= 50 ? "acceptable" : "needs improvement";
  const issueNote = issueCount > 0 ? ` I found ${issueCount} potential issues that could be improved.` : " No major issues detected!";
  
  addCompanionMessage(projectId, "insight",
    `I just watched the rendered video to check my own work. Quality score: ${score}/100 (${quality}).${issueNote}`,
    "self_review",
    { score, issueCount, quality }
  );
}

export function sendCorrectionUpdate(projectId: number, iteration: number, correctionCount: number): void {
  addCompanionMessage(projectId, "explanation",
    `I noticed some issues in my self-review, so I'm making ${correctionCount} corrections and re-rendering. This is iteration ${iteration} of my self-improvement loop - I want to get this right for you!`,
    "correction",
    { iteration, correctionCount }
  );
}

export function sendCompletionUpdate(projectId: number, finalScore?: number): void {
  const scoreNote = finalScore ? ` Final quality score: ${finalScore}/100.` : "";
  addCompanionMessage(projectId, "milestone",
    `Your video is complete and ready to download!${scoreNote} I hope you love the result. Feel free to ask me any questions about the edits I made!`,
    "complete"
  );
}

export function sendErrorUpdate(projectId: number, stage: string, userFriendlyMessage: string): void {
  addCompanionMessage(projectId, "update",
    `I ran into a small hiccup during ${stage}: ${userFriendlyMessage}. Don't worry, I'm handling it and will continue with the best approach available.`,
    "error",
    { stage }
  );
}

export function explainEditAction(action: any): string {
  switch (action.type) {
    case "cut":
      return `I'm removing this segment (${action.start?.toFixed(1)}s - ${action.end?.toFixed(1)}s) because: ${action.reason || "it doesn't add value to the final video"}`;
    case "keep":
      return `I'm keeping this segment because: ${action.reason || "it contains important content"}`;
    case "add_broll":
      return `I'm adding B-roll here to: ${action.reason || "visually support the content being discussed"}`;
    case "add_caption":
      return `Adding a caption at this point to highlight: ${action.text || "key information"}`;
    default:
      return `This action helps improve the overall video quality.`;
  }
}
