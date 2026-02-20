import {
  type ProviderSendTurnInput,
  type StateMessage,
  stateMessageSchema,
} from "@t3tools/contracts";

export function messageDocId(threadId: string, messageId: string): string {
  return `message:${threadId}:${messageId}`;
}

export function buildUserTurnMessage(input: {
  turn: ProviderSendTurnInput;
  threadId: string;
  messageId: string;
  createdAt: string;
}): StateMessage {
  const text = input.turn.clientMessageText ?? input.turn.input ?? "";
  const inputAttachments = input.turn.attachments ?? [];
  const attachments =
    inputAttachments.length > 0
      ? inputAttachments.map((attachment, index) => ({
          type: "image" as const,
          id: `${input.messageId}:image:${index + 1}`,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        }))
      : undefined;
  return stateMessageSchema.parse({
    id: input.messageId,
    threadId: input.threadId,
    role: "user",
    text,
    ...(attachments ? { attachments } : {}),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    streaming: false,
  });
}
