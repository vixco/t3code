import { useEffect, useRef } from "react";

import ChatView from "./components/ChatView";
import DiffPanel from "./components/DiffPanel";
import Sidebar from "./components/Sidebar";
import { readNativeApi } from "./session-logic";
import { StoreProvider, useStore } from "./store";

function EventRouter() {
  const api = readNativeApi();
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

function BootstrapRouter() {
  const api = readNativeApi();
  const { dispatch } = useStore();

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void api.app
      .bootstrap()
      .then((bootstrap) => {
        if (cancelled) return;
        dispatch({
          type: "BOOTSTRAP_FROM_SERVER",
          bootstrap,
        });
      })
      .catch(() => {
        // Keep existing renderer state if bootstrap is unavailable.
      });

    return () => {
      cancelled = true;
    };
  }, [api, dispatch]);

  return null;
}

function Layout() {
  const api = readNativeApi();
  const { state } = useStore();

  if (!api) {
    return (
      <div className="flex h-screen flex-col bg-background text-foreground">
        <div className="drag-region h-[52px] shrink-0" />
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">Local t3 runtime unavailable.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <BootstrapRouter />
      <EventRouter />
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
