import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../types";
import { selectBranchedMessages } from "./threadBranching";

function messageId(value: string): MessageId {
  return MessageId.makeUnsafe(value);
}

function makeMessage(input: {
  id: string;
  role: ChatMessage["role"];
  text: string;
  createdAt?: string;
}): ChatMessage {
  return {
    id: messageId(input.id),
    role: input.role,
    text: input.text,
    createdAt: input.createdAt ?? "2026-03-05T00:00:00.000Z",
    streaming: false,
  };
}

describe("selectBranchedMessages", () => {
  it("returns the full transcript when no target message is provided", () => {
    const messages = [
      makeMessage({ id: "msg-1", role: "user", text: "first" }),
      makeMessage({ id: "msg-2", role: "assistant", text: "second" }),
    ];

    expect(selectBranchedMessages({ messages })).toEqual(messages);
  });

  it("returns messages up to and including the targeted assistant message", () => {
    const messages = [
      makeMessage({ id: "msg-1", role: "user", text: "first" }),
      makeMessage({ id: "msg-2", role: "assistant", text: "second" }),
      makeMessage({ id: "msg-3", role: "user", text: "third" }),
      makeMessage({ id: "msg-4", role: "assistant", text: "fourth" }),
    ];

    expect(
      selectBranchedMessages({
        messages,
        targetMessageId: messageId("msg-2"),
      }).map((message) => message.id),
    ).toEqual([messageId("msg-1"), messageId("msg-2")]);
  });

  it("rejects non-assistant branch targets", () => {
    expect(() =>
      selectBranchedMessages({
        messages: [makeMessage({ id: "msg-1", role: "user", text: "first" })],
        targetMessageId: messageId("msg-1"),
      }),
    ).toThrow("Can only branch from an assistant message.");
  });

  it("rejects missing branch targets", () => {
    expect(() =>
      selectBranchedMessages({
        messages: [makeMessage({ id: "msg-1", role: "assistant", text: "first" })],
        targetMessageId: messageId("missing"),
      }),
    ).toThrow("Branch target message was not found.");
  });
});
