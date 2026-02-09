import {
  type NativeApi,
  WS_CHANNELS,
  WS_METHODS,
  type WsWelcomePayload,
} from "@acme/contracts";

import { WsTransport } from "./wsTransport";

let instance: { api: NativeApi; transport: WsTransport } | null = null;
const welcomeListeners = new Set<(payload: WsWelcomePayload) => void>();

export function onServerWelcome(
  listener: (payload: WsWelcomePayload) => void,
): () => void {
  welcomeListeners.add(listener);
  return () => {
    welcomeListeners.delete(listener);
  };
}

export function createWsNativeApi(): NativeApi {
  if (instance) return instance.api;

  const transport = new WsTransport();

  // Listen for server welcome and forward to registered listeners
  transport.subscribe(WS_CHANNELS.serverWelcome, (data) => {
    const payload = data as WsWelcomePayload;
    for (const listener of welcomeListeners) {
      try {
        listener(payload);
      } catch {
        // Swallow listener errors
      }
    }
  });

  const api: NativeApi = {
    todos: {
      list: async () => [],
      add: async () => [],
      toggle: async () => [],
      remove: async () => [],
    },
    dialogs: {
      pickFolder: async () => null,
    },
    terminal: {
      run: async () => ({
        stdout: "",
        stderr: "Terminal not available in web mode",
        code: 1,
        signal: null,
        timedOut: false,
      }),
    },
    agent: {
      spawn: async () => "",
      kill: async () => {},
      write: async () => {},
      onOutput: () => () => {},
      onExit: () => () => {},
    },
    providers: {
      startSession: (input) =>
        transport.request(WS_METHODS.providersStartSession, input),
      sendTurn: (input) =>
        transport.request(WS_METHODS.providersSendTurn, input),
      interruptTurn: (input) =>
        transport.request(WS_METHODS.providersInterruptTurn, input),
      respondToRequest: (input) =>
        transport.request(WS_METHODS.providersRespondToRequest, input),
      stopSession: (input) =>
        transport.request(WS_METHODS.providersStopSession, input),
      listSessions: () =>
        transport.request(WS_METHODS.providersListSessions),
      onEvent: (callback) =>
        transport.subscribe(WS_CHANNELS.providerEvent, callback as (data: unknown) => void),
    },
    shell: {
      openInEditor: (cwd, editor) =>
        transport.request(WS_METHODS.shellOpenInEditor, { cwd, editor }),
    },
  };

  instance = { api, transport };
  return api;
}
