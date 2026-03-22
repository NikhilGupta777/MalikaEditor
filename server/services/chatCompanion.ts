import { createLogger } from "../utils/logger";
import { getGeminiClient } from "./ai/clients";
import { AI_CONFIG } from "../config/ai";
import { storage } from "../storage";
import type { VideoAnalysis, EditPlan, TranscriptSegment, StockMediaItem, ReviewData, ProjectChatMessage } from "@shared/schema";

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

// In-memory cache for project contexts (lightweight, can be rebuilt from project data)
const projectContexts = new Map<number, ProjectContext>();

// Track which projects have been initialized to avoid duplicate welcome messages
const initializedProjects = new Set<number>();

const MAX_MESSAGES_PER_PROJECT = 100;

function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Convert DB message to ChatMessage format
function dbMessageToChatMessage(dbMsg: ProjectChatMessage): ChatMessage {
  return {
    id: dbMsg.messageId,
    projectId: dbMsg.projectId,
    role: dbMsg.role as MessageRole,
    type: dbMsg.type as MessageType,
    content: dbMsg.content,
    timestamp: dbMsg.createdAt,
    stage: dbMsg.stage || undefined,
    metadata: dbMsg.metadata as Record<string, any> | undefined,
  };
}

// Load full project context from DB (used when in-memory cache is empty, e.g. after server restart)
async function ensureContextFromDB(projectId: number): Promise<void> {
  const cached = projectContexts.get(projectId);
  // If we have a rich context (has editPlan or transcript), no need to reload
  if (cached && (cached.editPlan || cached.transcript)) return;

  try {
    const project = await storage.getVideoProject(projectId);
    if (!project) return;

    const reviewData = project.reviewData as any;
    const existing = cached || { projectId };

    projectContexts.set(projectId, {
      ...existing,
      title: project.originalFileName || undefined,
      status: project.status,
      duration: project.duration || undefined,
      prompt: project.prompt || undefined,
      videoAnalysis: (project.analysis as VideoAnalysis) || undefined,
      transcript: (project.transcript as TranscriptSegment[]) || undefined,
      editPlan: (project.editPlan as EditPlan) || undefined,
      stockMedia: (project.stockMedia as StockMediaItem[]) || undefined,
      reviewData: reviewData || undefined,
      selfReviewScore: reviewData?.selfReviewScore || undefined,
    });

    chatLogger.debug(`[Project ${projectId}] Context loaded from DB (${project.status})`);
  } catch (err) {
    chatLogger.warn(`[Project ${projectId}] Failed to load context from DB: ${err}`);
  }
}

export async function initializeProjectChat(projectId: number, title?: string): Promise<void> {
  if (initializedProjects.has(projectId)) return;

  const existingMessages = await storage.getChatMessages(projectId, 1);
  if (existingMessages.length > 0) {
    initializedProjects.add(projectId);
    const existing = projectContexts.get(projectId) || { projectId };
    projectContexts.set(projectId, { ...existing, title });
    return;
  }

  projectContexts.set(projectId, { projectId, title });
  initializedProjects.add(projectId);

  await addCompanionMessage(projectId, "milestone",
    `Hey there! I'm your AI editing companion. I'll guide you through the entire video editing process and explain what I'm doing at each step. Feel free to ask me anything along the way!`,
    "initialization"
  );
}

export function updateProjectContext(projectId: number, updates: Partial<ProjectContext>): void {
  const existing = projectContexts.get(projectId) || { projectId };
  projectContexts.set(projectId, { ...existing, ...updates });
}

export function getProjectContext(projectId: number): ProjectContext | undefined {
  return projectContexts.get(projectId);
}

export async function addCompanionMessage(
  projectId: number,
  type: MessageType,
  content: string,
  stage?: string,
  metadata?: Record<string, any>
): Promise<ChatMessage> {
  const messageId = generateMessageId();

  try {
    await storage.addChatMessage({
      projectId,
      messageId,
      role: "companion",
      type,
      content,
      stage: stage || null,
      metadata: metadata || null,
    });
  } catch (error) {
    chatLogger.error(`Failed to persist companion message: ${error}`);
  }

  const message: ChatMessage = {
    id: messageId,
    projectId,
    role: "companion",
    type,
    content,
    timestamp: new Date(),
    stage,
    metadata,
  };

  chatLogger.debug(`[Project ${projectId}] Companion: ${content.substring(0, 80)}...`);
  return message;
}

export async function addUserMessage(projectId: number, content: string): Promise<ChatMessage> {
  const messageId = generateMessageId();

  try {
    await storage.addChatMessage({
      projectId,
      messageId,
      role: "user",
      type: "question",
      content,
      stage: null,
      metadata: null,
    });
  } catch (error) {
    chatLogger.error(`Failed to persist user message: ${error}`);
  }

  return {
    id: messageId,
    projectId,
    role: "user",
    type: "question",
    content,
    timestamp: new Date(),
  };
}

export async function getProjectMessages(projectId: number, limit?: number): Promise<ChatMessage[]> {
  try {
    const dbMessages = await storage.getChatMessages(projectId, limit || MAX_MESSAGES_PER_PROJECT);
    return dbMessages.map(dbMessageToChatMessage);
  } catch (error) {
    chatLogger.error(`Failed to get chat messages: ${error}`);
    return [];
  }
}

export async function clearProjectChat(projectId: number): Promise<void> {
  try {
    await storage.deleteChatMessages(projectId);
  } catch (error) {
    chatLogger.error(`Failed to clear chat messages: ${error}`);
  }
  projectContexts.delete(projectId);
  initializedProjects.delete(projectId);
}

// ─── Re-edit detection & execution ────────────────────────────────────────────

// Detects if the user is trying to confirm/trigger a re-edit
export function detectReEditTrigger(question: string, recentMessages: ChatMessage[]): boolean {
  const normalized = question.trim().toLowerCase();

  // Trigger keywords — user is saying "go ahead"
  const triggerPattern = /^(start|go|yes|apply|do it|begin|proceed|ok|okay|sure|confirm|re.?edit|let'?s go|make it happen|sounds good|looks good|perfect|great|do that|execute|run it|yeah|yep|do this|start it|kick it off|start re-?edit)/i;

  if (!triggerPattern.test(normalized)) return false;

  // Only trigger if there's a pending re-edit plan in the conversation
  return recentMessages.some(m => m.role === "companion" && m.metadata?.pendingReEdit);
}

// Extracts all accumulated instructions from the conversation plan messages
export function buildReEditInstructions(messages: ChatMessage[]): string | null {
  const planMessages = messages
    .filter(m => m.role === "companion" && m.metadata?.pendingReEdit)
    .map(m => m.metadata!.pendingReEdit as string);

  if (planMessages.length === 0) return null;

  // Merge all plan messages (user may have refined plan over multiple messages)
  return planMessages.join("\n");
}

// Executes re-edit: updates prompt, sends chat message
// Returns { success, newPrompt } — caller is responsible for calling retryProcessingFromStage
export async function executeReEdit(projectId: number): Promise<{ success: boolean; newPrompt: string | null }> {
  try {
    const messages = await getProjectMessages(projectId, 30);
    const instructions = buildReEditInstructions(messages);

    if (!instructions) {
      chatLogger.warn(`[Project ${projectId}] executeReEdit called but no pending plan found`);
      return { success: false, newPrompt: null };
    }

    const project = await storage.getVideoProject(projectId);
    if (!project) return { success: false, newPrompt: null };

    // Build new prompt: keep original intent + append re-edit instructions
    const originalPrompt = project.prompt || "Edit my video";
    const newPrompt = `${originalPrompt}\n\n[RE-EDIT INSTRUCTIONS — User requested changes after reviewing the first edit]\n${instructions}`.trim();

    // Update prompt in DB
    await storage.updateVideoProject(projectId, { prompt: newPrompt });

    // Update in-memory context so the AI has fresh data
    updateProjectContext(projectId, { prompt: newPrompt, status: "pending" });

    // Post confirmation chat message
    await addCompanionMessage(
      projectId,
      "milestone",
      "Starting the re-edit now! I'll re-plan all the cuts and B-roll based on our conversation, then render a fresh version. This takes a few minutes — I'll send updates as I work.",
      "re_edit"
    );

    chatLogger.info(`[Project ${projectId}] Re-edit triggered. New prompt length: ${newPrompt.length}`);
    return { success: true, newPrompt };
  } catch (err) {
    chatLogger.error(`[Project ${projectId}] executeReEdit failed: ${err}`);
    return { success: false, newPrompt: null };
  }
}

// ─── Rich context builder ──────────────────────────────────────────────────────

function buildTranscriptSummary(transcript?: TranscriptSegment[]): string {
  if (!transcript || transcript.length === 0) return "Transcript not available.";

  const lines = transcript.slice(0, 30).map((seg: any) => {
    const start = typeof seg.start === "number" ? `${seg.start.toFixed(1)}s` : "?";
    const end = typeof seg.end === "number" ? `${seg.end.toFixed(1)}s` : "?";
    const text = seg.text || seg.content || "";
    return `  ${start}-${end}: "${text.trim()}"`;
  });

  const suffix = transcript.length > 30 ? `\n  ... (${transcript.length - 30} more segments)` : "";
  return lines.join("\n") + suffix;
}

function buildEditPlanSummary(editPlan?: EditPlan): string {
  if (!editPlan || !editPlan.actions || editPlan.actions.length === 0) {
    return "Edit plan not available.";
  }

  const lines = editPlan.actions.map((action: any) => {
    const start = typeof action.start === "number" ? `${action.start.toFixed(1)}s` : "";
    const end = typeof action.end === "number" ? `-${action.end.toFixed(1)}s` : "";
    const duration = typeof action.duration === "number" ? ` for ${action.duration.toFixed(1)}s` : "";
    const reason = action.reason ? ` — "${action.reason}"` : "";
    const query = action.searchQuery || action.query ? ` (search: "${action.searchQuery || action.query}")` : "";

    switch (action.type) {
      case "cut":
        return `  CUT ${start}${end}${reason}`;
      case "keep":
        return `  KEEP ${start}${end}${reason}`;
      case "insert_stock":
        return `  B-ROLL (stock) at ${start}${duration}${query}${reason}`;
      case "insert_ai_image":
        return `  B-ROLL (AI image) at ${start}${duration}${query}${reason}`;
      case "add_caption":
        return `  CAPTION at ${start}: "${action.text || ""}"`;
      default:
        return `  ${action.type?.toUpperCase() || "ACTION"} at ${start}${reason}`;
    }
  });

  return lines.join("\n");
}

function buildQualityIssueSummary(reviewData?: any): string {
  if (!reviewData) return "No quality review data available.";

  const score = reviewData.selfReviewScore;
  const result = reviewData.selfReviewResult;

  if (!score && !result) return "Quality review not yet run.";

  const lines: string[] = [];
  if (score != null) lines.push(`  Overall score: ${score}/100`);

  if (result?.issues && result.issues.length > 0) {
    lines.push("  Issues found:");
    result.issues.forEach((issue: any, idx: number) => {
      const at = issue.timestamp != null ? ` at ${issue.timestamp}s` : "";
      const sev = issue.severity ? ` [${issue.severity.toUpperCase()}]` : "";
      const fix = issue.fix ? `\n    → Fix: ${issue.fix}` : "";
      const desc = issue.description || issue.message || String(issue);
      lines.push(`  [${idx + 1}]${sev} ${issue.category || ""}${at}: ${desc}${fix}`);
    });
  } else if (score != null) {
    lines.push("  No major issues found.");
  }

  if (result?.suggestions && result.suggestions.length > 0) {
    lines.push("  AI suggestions:");
    result.suggestions.slice(0, 3).forEach((s: string) => lines.push(`  • ${s}`));
  }

  return lines.join("\n");
}

function buildContextSummary(context?: ProjectContext): string {
  if (!context) return "No project context available yet.";

  const parts: string[] = [];

  if (context.title) parts.push(`Video: "${context.title}"`);
  if (context.duration) parts.push(`Duration: ${context.duration}s`);
  if (context.status) parts.push(`Status: ${context.status}`);
  if (context.prompt) parts.push(`User's editing goal: "${context.prompt}"`);

  if (context.videoAnalysis?.context) {
    const vc = context.videoAnalysis.context;
    parts.push(`Genre: ${vc.genre}, Tone: ${vc.tone}, Pacing: ${vc.pacing}`);
  }

  return parts.join("\n") || "Project is being initialized...";
}

// ─── Main AI response function ─────────────────────────────────────────────────

export async function answerUserQuestion(
  projectId: number,
  question: string
): Promise<{ message: ChatMessage; reEditStarted: false }> {
  // Always ensure we have full context (handles server restarts / history loads)
  await ensureContextFromDB(projectId);

  const context = projectContexts.get(projectId);
  const recentMessages = await getProjectMessages(projectId, 15);

  const conversationHistory = recentMessages
    .filter(m => m.role === "user" || m.role === "companion")
    .slice(-10)
    .map(m => {
      const role = m.role === "companion" ? "AI Editor" : "User";
      // Strip [PLAN]...[/PLAN] blocks from history display so AI doesn't re-show them
      const content = m.content.replace(/\[PLAN\][\s\S]*?\[\/PLAN\]/g, "[plan was proposed]");
      return `${role}: ${content}`;
    })
    .join("\n");

  const transcriptSummary = buildTranscriptSummary(context?.transcript);
  const editPlanSummary = buildEditPlanSummary(context?.editPlan);
  const qualitySummary = buildQualityIssueSummary(context?.reviewData);
  const contextOverview = buildContextSummary(context);

  const aiPrompt = `You are MalikaEditor's AI video editing assistant — intelligent, specific, and deeply knowledgeable about this project.

PROJECT OVERVIEW:
${contextOverview}

TRANSCRIPT (every spoken segment with exact timestamps):
${transcriptSummary}

EDIT PLAN APPLIED TO THIS VIDEO:
${editPlanSummary}

AI QUALITY REVIEW RESULTS:
${qualitySummary}

RECENT CONVERSATION:
${conversationHistory || "(no prior messages)"}

USER'S MESSAGE: "${question}"

INSTRUCTIONS — Read carefully:

1. You have FULL knowledge of this project. Reference specific timestamps, clip descriptions, and spoken words.

2. If the user asks a QUESTION (why did you cut X, what is the quality score, explain the B-roll, etc.):
   → Answer directly and specifically. 2-4 sentences. Reference exact timestamps and reasons.

3. If the user expresses a DESIRE TO CHANGE something (different B-roll, different cuts, faster pacing, different style, fix an issue, etc.):
   → Acknowledge what they want to change in 1-2 sentences
   → Explain how you'll address it specifically (reference exact timestamps)
   → Then output a PLAN block at the end of your message using EXACTLY this format:
   
[PLAN]
- Replace B-roll at 23.0s: search for "hair coloring barbershop tutorial" instead
- Remove cut at 47.5s-49.2s: user wants to keep this segment
- [any other specific changes...]
[/PLAN]

   IMPORTANT: The [PLAN] block must contain bullet points with SPECIFIC, ACTIONABLE instructions the AI can use to re-plan the edit.

4. If the user is giving GENERAL FEEDBACK ("looks good", "nice work", "I like it") or asking a yes/no question:
   → Respond conversationally without a plan block.

5. NEVER be generic. Every response must reference specifics from the project above.
6. Keep responses concise. Don't repeat what the user said.
7. Don't include the [PLAN] block if there's nothing specific to change.

Your response:`;

  try {
    const gemini = getGeminiClient();
    const response = await gemini.models.generateContent({
      model: AI_CONFIG.models.editPlanning,
      contents: [{ role: "user", parts: [{ text: aiPrompt }] }],
    });

    const rawText = response.text || "I'm not sure how to answer that. Could you rephrase?";

    // Parse [PLAN]...[/PLAN] block out of the response
    const planMatch = rawText.match(/\[PLAN\]([\s\S]*?)\[\/PLAN\]/);
    const pendingReEdit = planMatch ? planMatch[1].trim() : null;

    // Clean display text — strip the [PLAN] block from what user sees
    const displayText = rawText.replace(/\[PLAN\][\s\S]*?\[\/PLAN\]/g, "").trim();

    const metadata: Record<string, any> | undefined = pendingReEdit
      ? { pendingReEdit }
      : undefined;

    const answerMessage = await addCompanionMessage(
      projectId,
      pendingReEdit ? "explanation" : "answer",
      displayText,
      context?.status || undefined,
      metadata
    );

    if (pendingReEdit) {
      chatLogger.info(`[Project ${projectId}] AI proposed re-edit plan: ${pendingReEdit.substring(0, 120)}...`);
    }

    return { message: answerMessage, reEditStarted: false };

  } catch (error) {
    chatLogger.error(`Failed to answer user question: ${error}`);

    const fallback = await addCompanionMessage(
      projectId,
      "answer",
      "I'm having a moment of difficulty — please try rephrasing your question and I'll do my best to help!"
    );
    return { message: fallback, reEditStarted: false };
  }
}

// ─── Processing stage companion messages ───────────────────────────────────────

export async function sendUploadUpdate(projectId: number, fileName: string, duration: number): Promise<void> {
  await addCompanionMessage(projectId, "update",
    `Great! I've received your video "${fileName}". It's ${duration} seconds long. Let me start analyzing it to understand what we're working with...`,
    "upload"
  );
}

export async function sendTranscriptionUpdate(projectId: number, segmentCount: number, language?: string): Promise<void> {
  const langNote = language ? ` I detected that the video is in ${language}.` : "";
  await addCompanionMessage(projectId, "update",
    `I've transcribed the audio and found ${segmentCount} speech segments.${langNote} This transcript will help me understand the content and time my edits precisely.`,
    "transcription"
  );
}

export async function sendAnalysisUpdate(projectId: number, analysis: VideoAnalysis): Promise<void> {
  const genre = analysis.context?.genre || "general";
  const tone = analysis.context?.tone || "casual";
  const sceneCount = analysis.scenes?.length || 0;

  await addCompanionMessage(projectId, "insight",
    `I've analyzed your video! It appears to be a ${genre} video with a ${tone} tone. I identified ${sceneCount} distinct scenes. Based on this, I'll tailor the editing style to match the content.`,
    "analysis",
    { genre, tone, sceneCount }
  );
}

export async function sendEditPlanningUpdate(projectId: number, actionCounts: { cuts: number; keeps: number; broll: number }): Promise<void> {
  await addCompanionMessage(projectId, "explanation",
    `I've created an edit plan! Here's what I'm thinking: ${actionCounts.cuts} segments to cut (removing filler or repetitive parts), ${actionCounts.keeps} segments to keep (the important content), and ${actionCounts.broll} spots where I'll add B-roll footage to make it more engaging.`,
    "edit_planning",
    actionCounts
  );
}

export async function sendMediaFetchingUpdate(projectId: number, queriesCount: number): Promise<void> {
  await addCompanionMessage(projectId, "update",
    `Now I'm searching for the perfect B-roll footage. I've identified ${queriesCount} different topics where visual support would enhance your video. I'll analyze thumbnails to pick the most relevant ones!`,
    "media_fetching"
  );
}

export async function sendMediaSelectionUpdate(projectId: number, selectedCount: number, aiImageCount: number): Promise<void> {
  const aiNote = aiImageCount > 0 ? ` I also generated ${aiImageCount} custom AI images for unique visuals.` : "";
  await addCompanionMessage(projectId, "insight",
    `I've selected ${selectedCount} pieces of stock media for your B-roll.${aiNote} Each one was chosen based on visual relevance to your content.`,
    "media_selection",
    { selectedCount, aiImageCount }
  );
}

export async function sendReviewReadyUpdate(projectId: number, summary?: { totalCuts: number; totalKeeps: number; totalBroll: number; totalAiImages: number }): Promise<void> {
  const summaryText = summary
    ? ` I've planned ${summary.totalCuts} cuts, ${summary.totalKeeps} segments to keep, and ${summary.totalBroll + summary.totalAiImages} B-roll insertions.`
    : "";
  await addCompanionMessage(projectId, "milestone",
    `Everything is ready for your review!${summaryText} Take a look at the transcript and my edit suggestions. You can approve, reject, or modify any of my decisions. I'll explain my reasoning if you click on any edit action.`,
    "review_ready",
    summary
  );
}

export async function sendRenderingUpdate(projectId: number): Promise<void> {
  await addCompanionMessage(projectId, "update",
    `You've approved the edits — now I'm rendering your final video. This involves applying all the cuts, adding B-roll overlays, syncing captions, and creating smooth transitions. This might take a few minutes...`,
    "rendering"
  );
}

export async function sendSelfReviewUpdate(projectId: number, score: number, issueCount: number): Promise<void> {
  const quality = score >= 90 ? "excellent" : score >= 70 ? "good" : score >= 50 ? "acceptable" : "needs improvement";
  const issueNote = issueCount > 0 ? ` I found ${issueCount} potential issues that could be improved.` : " No major issues detected!";

  await addCompanionMessage(projectId, "insight",
    `I just watched the rendered video to check my own work. Quality score: ${score}/100 (${quality}).${issueNote} You can ask me about any specific part of the edit, or tell me what you'd like to change.`,
    "self_review",
    { score, issueCount, quality }
  );
}

export async function sendCorrectionUpdate(projectId: number, iteration: number, correctionCount: number): Promise<void> {
  await addCompanionMessage(projectId, "explanation",
    `I noticed some issues in my self-review, so I'm making ${correctionCount} corrections and re-rendering. This is iteration ${iteration} of my self-improvement loop — I want to get this right for you!`,
    "correction",
    { iteration, correctionCount }
  );
}

export async function sendCompletionUpdate(projectId: number, finalScore?: number): Promise<void> {
  const scoreNote = finalScore ? ` Final quality score: ${finalScore}/100.` : "";
  await addCompanionMessage(projectId, "milestone",
    `Your video is complete and ready to download!${scoreNote} Feel free to ask me any questions about the edits I made, or tell me what you'd like to change — I can re-edit it based on your feedback.`,
    "complete"
  );
}

export async function sendErrorUpdate(projectId: number, stage: string, userFriendlyMessage: string): Promise<void> {
  await addCompanionMessage(projectId, "update",
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
    case "insert_stock":
      return `I'm adding stock footage here to: ${action.reason || "visually support the content being discussed"}`;
    case "insert_ai_image":
      return `I'm adding an AI-generated image here to: ${action.reason || "illustrate the concept being discussed"}`;
    case "add_caption":
      return `Adding a caption at this point to highlight: ${action.text || "key information"}`;
    case "add_broll":
      return `I'm adding B-roll here to: ${action.reason || "visually support the content being discussed"}`;
    default:
      return `This action helps improve the overall video quality.`;
  }
}
