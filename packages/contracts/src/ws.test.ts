import { describe, expect, it } from "vitest";

import { WS_EVENT_CHANNELS, wsClientMessageSchema, wsServerMessageSchema } from "./ws";

describe("wsClientMessageSchema", () => {
  it("accepts request messages", () => {
    const parsed = wsClientMessageSchema.parse({
      type: "request",
      id: "req-1",
      method: "providers.startSession",
      params: { provider: "codex" },
    });

    expect(parsed.method).toBe("providers.startSession");
  });
});

describe("wsServerMessageSchema", () => {
  it("accepts successful response messages", () => {
    const parsed = wsServerMessageSchema.parse({
      type: "response",
      id: "req-1",
      ok: true,
      result: { sessionId: "sess-1" },
    });

    expect(parsed.type).toBe("response");
  });

  it("requires errors for failed responses", () => {
    expect(() =>
      wsServerMessageSchema.parse({
        type: "response",
        id: "req-1",
        ok: false,
      }),
    ).toThrow();
  });

  it("accepts typed event channels", () => {
    const parsed = wsServerMessageSchema.parse({
      type: "event",
      channel: WS_EVENT_CHANNELS.providerEvent,
      payload: { id: "evt-1" },
    });

    expect(parsed.type).toBe("event");
  });
});
