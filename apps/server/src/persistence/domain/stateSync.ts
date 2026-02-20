import {
  type StateBootstrapResult,
  type StateBootstrapThread,
  type StateCatchUpResult,
  type StateEvent,
  type StateListMessagesResult,
  type StateMessage,
  type StateProject,
  stateBootstrapResultSchema,
  stateCatchUpResultSchema,
  stateListMessagesResultSchema,
} from "@t3tools/contracts";

export function buildStateBootstrapResult(input: {
  projects: StateProject[];
  threads: StateBootstrapThread[];
  lastStateSeq: number;
}): StateBootstrapResult {
  return stateBootstrapResultSchema.parse(input);
}

export function buildStateCatchUpResult(input: {
  events: StateEvent[];
  lastStateSeq: number;
}): StateCatchUpResult {
  return stateCatchUpResultSchema.parse(input);
}

export function buildStateListMessagesResult(input: {
  messages: StateMessage[];
  total: number;
  offset: number;
  pageSize: number;
}): StateListMessagesResult {
  const nextOffset = input.offset + input.pageSize;
  return stateListMessagesResultSchema.parse({
    messages: input.messages,
    total: input.total,
    nextOffset: nextOffset < input.total ? nextOffset : null,
  });
}
