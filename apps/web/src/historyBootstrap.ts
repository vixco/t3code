import type { ChatMessage } from "./types";

export interface BootstrapInputResult {
  text: string;
  includedCount: number;
  omittedCount: number;
  truncated: boolean;
}

export interface BootstrapMessageSelectionResult {
  messages: ChatMessage[];
  omittedCount: number;
  promptTruncated: boolean;
}

export function resolveTurnBootstrapMessages(input: {
  draftBootstrapMessages: ChatMessage[];
  threadMessages: ChatMessage[];
  providerThreadId: string | null;
}): ChatMessage[] {
  if (input.draftBootstrapMessages.length > 0) {
    return input.draftBootstrapMessages;
  }

  if (input.providerThreadId === null && input.threadMessages.length > 0) {
    return input.threadMessages;
  }

  return [];
}

const BOOTSTRAP_PREAMBLE =
  "Continue this conversation using the transcript context below. The final section is the latest user request to answer now.";
const TRANSCRIPT_HEADER = "Transcript context:";
const LATEST_PROMPT_HEADER = "Latest user request (answer this now):";
const OMITTED_SUMMARY = (count: number) =>
  `[${count} earlier message(s) omitted to stay within input limits.]`;

function messageRoleLabel(message: ChatMessage): "USER" | "ASSISTANT" | "SYSTEM" {
  if (message.role === "assistant") {
    return "ASSISTANT";
  }
  if (message.role === "system") {
    return "SYSTEM";
  }
  return "USER";
}

function attachmentSummary(message: ChatMessage): string | null {
  const imageAttachments = message.attachments?.filter((attachment) => attachment.type === "image");
  const count = imageAttachments?.length ?? 0;
  if (count === 0) {
    return null;
  }

  const names = imageAttachments?.slice(0, 3).map((image) => image.name) ?? [];
  const namesSummary = names.join(", ");
  const extraCount = count - names.length;
  const extraSummary = extraCount > 0 ? ` (+${extraCount} more)` : "";
  return `[Attached image${count === 1 ? "" : "s"}: ${namesSummary}${extraSummary}]`;
}

function buildMessageBlock(message: ChatMessage): string {
  const text = message.text;
  const attachments = attachmentSummary(message);

  if (text && attachments) {
    return `${messageRoleLabel(message)}:\n${text}\n${attachments}`;
  }
  if (text) {
    return `${messageRoleLabel(message)}:\n${text}`;
  }
  if (attachments) {
    return `${messageRoleLabel(message)}:\n${attachments}`;
  }
  return `${messageRoleLabel(message)}:\n(empty message)`;
}

function finalizeWithPrompt(
  transcriptBody: string,
  latestPrompt: string,
  maxChars: number,
): string | null {
  const text = `${BOOTSTRAP_PREAMBLE}\n\n${TRANSCRIPT_HEADER}\n${transcriptBody}\n\n${LATEST_PROMPT_HEADER}\n${latestPrompt}`;
  return text.length <= maxChars ? text : null;
}

function buildTranscriptBody(messages: ReadonlyArray<ChatMessage>, omittedCount: number): string {
  const transcript = messages.map(buildMessageBlock).join("\n\n");
  if (omittedCount === 0) {
    return transcript;
  }
  if (transcript.length === 0) {
    return OMITTED_SUMMARY(omittedCount);
  }
  return `${OMITTED_SUMMARY(omittedCount)}\n\n${transcript}`;
}

export function selectBootstrapMessages(
  previousMessages: ChatMessage[],
  latestPrompt: string,
  maxChars: number,
): BootstrapMessageSelectionResult {
  const budget = Number.isFinite(maxChars) ? Math.max(1, Math.floor(maxChars)) : 1;
  const promptOnly = latestPrompt.length <= budget ? latestPrompt : latestPrompt.slice(0, budget);
  const promptTruncated = latestPrompt.length !== promptOnly.length;

  if (previousMessages.length === 0) {
    return {
      messages: [],
      omittedCount: 0,
      promptTruncated,
    };
  }

  const newestFirstMessages: ChatMessage[] = [];
  for (let index = previousMessages.length - 1; index >= 0; index -= 1) {
    const message = previousMessages[index];
    if (!message) continue;
    newestFirstMessages.push(message);
  }

  if (newestFirstMessages.length === 0) {
    return {
      messages: [],
      omittedCount: previousMessages.length,
      promptTruncated: true,
    };
  }

  let includedNewestFirst: ChatMessage[] = [];
  for (const message of newestFirstMessages) {
    const nextNewestFirst = [...includedNewestFirst, message];
    const nextChronological = nextNewestFirst.toReversed();
    const omittedCount = newestFirstMessages.length - nextChronological.length;
    const transcriptBody = buildTranscriptBody(nextChronological, omittedCount);
    if (!finalizeWithPrompt(transcriptBody, latestPrompt, budget)) {
      break;
    }
    includedNewestFirst = nextNewestFirst;
  }

  let includedChronological = includedNewestFirst.toReversed();
  while (true) {
    const omittedCount = newestFirstMessages.length - includedChronological.length;
    const transcriptBody = buildTranscriptBody(includedChronological, omittedCount);
    if (finalizeWithPrompt(transcriptBody, latestPrompt, budget)) {
      return {
        messages: includedChronological,
        omittedCount,
        promptTruncated,
      };
    }

    if (includedChronological.length === 0) {
      return {
        messages: [],
        omittedCount: previousMessages.length,
        promptTruncated: true,
      };
    }

    includedChronological = includedChronological.slice(1);
  }
}

export function buildBootstrapInput(
  previousMessages: ChatMessage[],
  latestPrompt: string,
  maxChars: number,
): BootstrapInputResult {
  const budget = Number.isFinite(maxChars) ? Math.max(1, Math.floor(maxChars)) : 1;
  const promptOnly = latestPrompt.length <= budget ? latestPrompt : latestPrompt.slice(0, budget);

  if (previousMessages.length === 0) {
    return {
      text: promptOnly,
      includedCount: 0,
      omittedCount: 0,
      truncated: promptOnly.length !== latestPrompt.length,
    };
  }
  const selection = selectBootstrapMessages(previousMessages, latestPrompt, budget);
  if (selection.messages.length === 0) {
    return {
      text: promptOnly,
      includedCount: 0,
      omittedCount: previousMessages.length,
      truncated: true,
    };
  }

  const transcriptBody = buildTranscriptBody(selection.messages, selection.omittedCount);
  const finalized = finalizeWithPrompt(transcriptBody, latestPrompt, budget);
  if (!finalized) {
    return {
      text: promptOnly,
      includedCount: 0,
      omittedCount: previousMessages.length,
      truncated: true,
    };
  }

  return {
    text: finalized,
    includedCount: selection.messages.length,
    omittedCount: selection.omittedCount,
    truncated: selection.omittedCount > 0 || selection.promptTruncated,
  };
}
