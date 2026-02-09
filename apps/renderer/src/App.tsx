import { useEffect, useMemo, useRef } from "react";

import ChatView from "./components/ChatView";
import DiffPanel from "./components/DiffPanel";
import Sidebar from "./components/Sidebar";
import { DEFAULT_MODEL } from "./model-logic";
import { readNativeApi } from "./session-logic";
import { StoreProvider, useStore } from "./store";
import { onServerWelcome } from "./wsNativeApi";

function EventRouter() {
  const api = useMemo(() => readNativeApi(), []);
  const { dispatch } = useStore();
  const activeAssistantItemRef = useRef<string | null>(null);

  useEffect(() => {
    if (!api) return;
    return api.providers.onEvent((event) => {
      dispatch({
        type: "APPLY_EVENT",
        event,
        activeAssistantItemRef,
      });
    });
  }, [api, dispatch]);

  return null;
}

function AutoProjectBootstrap() {
  const { state, dispatch } = useStore();

  useEffect(() => {
    return onServerWelcome((payload) => {
      // Don't create duplicate projects for the same cwd
      const existing = state.projects.find((p) => p.cwd === payload.cwd);
      if (existing) {
        // If there are threads, ensure one is active
        const existingThread = state.threads.find(
          (t) => t.projectId === existing.id,
        );
        if (existingThread && !state.activeThreadId) {
          dispatch({
            type: "SET_ACTIVE_THREAD",
            threadId: existingThread.id,
          });
        }
        return;
      }

      // Create project + thread from server cwd
      const projectId = crypto.randomUUID();
      dispatch({
        type: "ADD_PROJECT",
        project: {
          id: projectId,
          name: payload.projectName,
          cwd: payload.cwd,
          model: DEFAULT_MODEL,
          expanded: true,
        },
      });
      dispatch({
        type: "ADD_THREAD",
        thread: {
          id: crypto.randomUUID(),
          codexThreadId: null,
          projectId,
          title: "New thread",
          model: DEFAULT_MODEL,
          session: null,
          messages: [],
          events: [],
          error: null,
          createdAt: new Date().toISOString(),
        },
      });
    });
  }, [state.projects, state.threads, state.activeThreadId, dispatch]);

  return null;
}

function Layout() {
  const api = useMemo(() => readNativeApi(), []);
  const { state } = useStore();

  if (!api) {
    return (
      <div className="flex h-screen flex-col bg-background text-foreground">
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">
            Connecting to CodeThing server...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <EventRouter />
      <AutoProjectBootstrap />
      <Sidebar />
      <ChatView />
      {state.diffOpen && <DiffPanel />}
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Layout />
    </StoreProvider>
  );
}
