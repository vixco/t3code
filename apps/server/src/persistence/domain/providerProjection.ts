import type { ProviderEvent } from "@t3tools/contracts";

export function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function normalizeProviderItemType(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  return normalized.replace(/[_\-\s]+/g, "").toLowerCase();
}

export function parseThreadIdFromEventPayload(payload: unknown): string | null {
  const record = asObject(payload);
  const threadId = asString(record?.threadId) ?? asString(record?.thread_id);
  if (threadId) return threadId;
  const thread = asObject(record?.thread);
  return asString(thread?.id) ?? null;
}

export function parseTurnIdFromEvent(event: ProviderEvent): string | null {
  if (event.turnId) return event.turnId;
  const payload = asObject(event.payload);
  const turn = asObject(payload?.turn);
  return asString(turn?.id) ?? null;
}

export function parseAssistantItemId(event: ProviderEvent): string | null {
  const payload = asObject(event.payload);
  const item = asObject(payload?.item);
  const itemType = asString(item?.type);
  if (itemType !== "agentMessage") return null;
  return asString(item?.id) ?? event.itemId ?? null;
}
