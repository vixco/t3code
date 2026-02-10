# Unified Provider WebSocket API

This document defines the canonical provider stream API used by T3 Code.

## Goals

- Keep the UI provider-agnostic (`codex` now, `claudeCode` next).
- Stream only canonical events needed by product behavior.
- Support reconnect/resume safely with cursor replay.
- Keep raw provider noise out of default UI paths.

## Request Methods

Provider RPC methods:

- `providers.startSession`
- `providers.sendTurn`
- `providers.interruptTurn`
- `providers.respondToApproval`
- `providers.stopSession`
- `providers.listSessions`
- `providers.openStream`
- `providers.closeStream`

## Push Channel

- `providers.stream`

This is the only provider push channel.

## Stream Open Contract

`providers.openStream` input:

- `afterSeq?: number` (exclusive cursor)
- `sessionIds?: string[]` (optional session filter)
- `eventKinds?: Array<"session" | "turn" | "message" | "approval" | "activity" | "error" | "debug.raw">`
- `includeExtensions?: string[]` (namespaced extension allowlist)
- `includeDebugRaw?: boolean` (default `false`)

Result:

- `mode: "snapshot" | "replay" | "snapshot_resync"`
- `currentSeq: number`
- `oldestSeq: number`
- `replayedCount: number`

## Stream Frames

`providers.stream` frames:

- `snapshot`: authoritative state baseline
- `event`: canonical delta event
- `gap`: cursor invalid/stale/ahead/replay-limit signal

Frame shape:

- `kind`
- `seq` (global monotonic sequence)
- `at` (server timestamp)
- `data` (snapshot/event/gap payload)

## Canonical Snapshot

`ProviderSnapshot`:

- `sessions: CanonicalSessionState[]`
- `activeTurns: CanonicalTurnState[]`
- `activeMessages: CanonicalMessageState[]`
- `pendingApprovals: CanonicalApprovalState[]`

## Canonical Event Union

`ProviderCoreEvent` variants:

- `session.updated`
- `turn.started`
- `turn.completed`
- `message.delta`
- `message.completed`
- `approval.requested`
- `approval.resolved`
- `activity`
- `error`
- `debug.raw` (opt-in)

## Codex Normalization Map

Codex raw events are normalized by allowlist in `apps/server/src/providerEventNormalizer.ts`.

Mapped examples:

- `thread/started` -> `session.updated`
- `turn/started` -> `turn.started` + `session.updated`
- `turn/completed` -> `turn.completed` + `session.updated`
- `item/agentMessage/delta` -> `message.delta`
- `item/completed` (agent message) -> `message.completed`
- `item/commandExecution/requestApproval` -> `approval.requested` (`command`)
- `item/fileChange/requestApproval` -> `approval.requested` (`file_change`)
- `item/tool/requestUserInput` -> `approval.requested` (`user_input`)
- `item/requestApproval/decision` -> `approval.resolved`
- actionable `item/started` / `item/completed` -> `activity`
- `turn/plan/updated` -> `activity` (`plan` + extension)
- process/protocol/runtime errors -> `error`

Unmapped raw methods are omitted from core stream. They are available only through `debug.raw` when `includeDebugRaw=true`.

## Replay, Retention, and Gaps

Server stream store behavior:

- global monotonic `seq`
- replay retention: up to `20_000` events
- replay memory cap: `64MB`
- replay max age: `60m`
- per-open replay cap: `10_000` events

Gap reasons:

- `cursor_too_old`
- `cursor_ahead`
- `replay_limit_exceeded`

When a gap is detected, server sends:

1. `gap` frame
2. `snapshot` frame

and `providers.openStream` returns `mode="snapshot_resync"`.

## Backpressure and Reliability

Per socket:

- if `bufferedAmount > 2MB` for more than `5s`, server closes the socket with `1013`
- canonical events are not silently dropped
- clients reconnect and resume with `afterSeq`

## Client Consumption Rules

- Keep `lastAppliedSeq` per connection.
- Ignore any frame with `seq <= lastAppliedSeq`.
- Treat `snapshot` as authoritative baseline.
- Apply `event` frames in `seq` order.
- On `gap`, expect immediate `snapshot` resync.

## Claude Compatibility Contract

Claude adapter must emit only canonical events (`ProviderCoreEvent`).

Adding Claude support must not require UI protocol changes.
