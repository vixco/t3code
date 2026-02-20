import type {
  NativeApi,
  StateBootstrapResult,
  StateCatchUpInput,
  StateCatchUpResult,
  StateEvent,
} from "@t3tools/contracts";

export interface StateSource {
  bootstrap(): Promise<StateBootstrapResult>;
  catchUp(input: StateCatchUpInput): Promise<StateCatchUpResult>;
  onEvent(listener: (event: StateEvent) => void): () => void;
}

export function createStateSource(api: NativeApi): StateSource {
  return {
    bootstrap: () => api.state.bootstrap(),
    catchUp: (input) => api.state.catchUp(input),
    onEvent: (listener) => api.state.onEvent(listener),
  };
}
