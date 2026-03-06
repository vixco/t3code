import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildBootstrapInput,
  resolveTurnBootstrapMessages,
  selectBootstrapMessages,
} from "./historyBootstrap";

const messageId = (value: string) => MessageId.makeUnsafe(value);

describe("buildBootstrapInput", () => {
  it("includes full transcript when under budget", () => {
    const result = buildBootstrapInput(
      [
        {
          id: messageId("u-1"),
          role: "user",
          text: "hello",
          createdAt: "2026-02-09T00:00:00.000Z",
          streaming: false,
        },
        {
          id: messageId("a-1"),
          role: "assistant",
          text: "world",
          createdAt: "2026-02-09T00:00:01.000Z",
          streaming: false,
        },
      ],
      "what's next?",
      1_500,
    );

    expect(result.includedCount).toBe(2);
    expect(result.omittedCount).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.text).toContain("USER:\nhello");
    expect(result.text).toContain("ASSISTANT:\nworld");
    expect(result.text).toContain("Latest user request (answer this now):");
    expect(result.text).toContain("what's next?");
  });

  it("truncates older transcript messages when over budget", () => {
    const result = buildBootstrapInput(
      [
        {
          id: messageId("u-1"),
          role: "user",
          text: "first question with details",
          createdAt: "2026-02-09T00:00:00.000Z",
          streaming: false,
        },
        {
          id: messageId("a-1"),
          role: "assistant",
          text: "first answer with details",
          createdAt: "2026-02-09T00:00:01.000Z",
          streaming: false,
        },
        {
          id: messageId("u-2"),
          role: "user",
          text: "second question with details",
          createdAt: "2026-02-09T00:00:02.000Z",
          streaming: false,
        },
      ],
      "final request",
      320,
    );

    expect(result.truncated).toBe(true);
    expect(result.omittedCount).toBeGreaterThan(0);
    expect(result.includedCount).toBeLessThan(3);
    expect(result.text).toContain("omitted to stay within input limits");
    expect(result.text.length).toBeLessThanOrEqual(320);
  });

  it("preserves the latest prompt when prompt-only fallback is required", () => {
    const latestPrompt = "Please keep this exact latest prompt.";
    const result = buildBootstrapInput(
      [
        {
          id: messageId("u-1"),
          role: "user",
          text: "old context",
          createdAt: "2026-02-09T00:00:00.000Z",
          streaming: false,
        },
      ],
      latestPrompt,
      latestPrompt.length + 3,
    );

    expect(result.text).toBe(latestPrompt);
    expect(result.includedCount).toBe(0);
    expect(result.omittedCount).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it("captures user image attachment context in transcript blocks", () => {
    const result = buildBootstrapInput(
      [
        {
          id: messageId("u-image"),
          role: "user",
          text: "",
          attachments: [
            {
              type: "image",
              id: "img-1",
              name: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: 2_048,
            },
          ],
          createdAt: "2026-02-09T00:00:00.000Z",
          streaming: false,
        },
      ],
      "What does this error mean?",
      1_500,
    );

    expect(result.text).toContain("Attached image");
    expect(result.text).toContain("screenshot.png");
  });

  it("labels system messages distinctly in transcript blocks", () => {
    const result = buildBootstrapInput(
      [
        {
          id: messageId("sys-1"),
          role: "system",
          text: "Follow repository rules.",
          createdAt: "2026-02-09T00:00:00.000Z",
          streaming: false,
        },
      ],
      "continue",
      1_500,
    );

    expect(result.text).toContain("SYSTEM:\nFollow repository rules.");
  });
});

describe("selectBootstrapMessages", () => {
  it("returns the newest fitting suffix in chronological order", () => {
    const result = selectBootstrapMessages(
      [
        {
          id: messageId("u-1"),
          role: "user",
          text: "first question with details",
          createdAt: "2026-02-09T00:00:00.000Z",
          streaming: false,
        },
        {
          id: messageId("a-1"),
          role: "assistant",
          text: "first answer with details",
          createdAt: "2026-02-09T00:00:01.000Z",
          streaming: false,
        },
        {
          id: messageId("u-2"),
          role: "user",
          text: "second question with details",
          createdAt: "2026-02-09T00:00:02.000Z",
          streaming: false,
        },
      ],
      "final request",
      320,
    );

    expect(result.omittedCount).toBeGreaterThan(0);
    expect(result.messages.map((message) => message.id)).toEqual([messageId("u-2")]);
  });
});

describe("resolveTurnBootstrapMessages", () => {
  it("prefers explicit draft bootstrap messages", () => {
    const draftBootstrapMessages = [
      {
        id: messageId("draft-1"),
        role: "user" as const,
        text: "draft bootstrap",
        createdAt: "2026-02-09T00:00:00.000Z",
        streaming: false,
      },
    ];
    const threadMessages = [
      {
        id: messageId("thread-1"),
        role: "assistant" as const,
        text: "visible history",
        createdAt: "2026-02-09T00:00:01.000Z",
        streaming: false,
      },
    ];

    expect(
      resolveTurnBootstrapMessages({
        draftBootstrapMessages,
        threadMessages,
        providerThreadId: null,
      }),
    ).toEqual(draftBootstrapMessages);
  });

  it("reuses visible thread history when no provider thread exists yet", () => {
    const threadMessages = [
      {
        id: messageId("thread-1"),
        role: "assistant" as const,
        text: "visible history",
        createdAt: "2026-02-09T00:00:01.000Z",
        streaming: false,
      },
    ];

    expect(
      resolveTurnBootstrapMessages({
        draftBootstrapMessages: [],
        threadMessages,
        providerThreadId: null,
      }),
    ).toEqual(threadMessages);
  });

  it("skips bootstrap when the provider thread already exists", () => {
    expect(
      resolveTurnBootstrapMessages({
        draftBootstrapMessages: [],
        threadMessages: [
          {
            id: messageId("thread-1"),
            role: "assistant" as const,
            text: "visible history",
            createdAt: "2026-02-09T00:00:01.000Z",
            streaming: false,
          },
        ],
        providerThreadId: "provider-thread-1",
      }),
    ).toEqual([]);
  });
});
