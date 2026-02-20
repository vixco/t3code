import { createFileRoute } from "@tanstack/react-router";

import { isElectron } from "../env";
import { Separator } from "../components/ui/separator";
import { SidebarTrigger } from "../components/ui/sidebar";

function ChatIndexRouteView() {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-muted-foreground/40">
      {!isElectron && (
        <header className="sticky top-0 z-20 flex h-11 shrink-0 items-center gap-2 border-b border-border/70 bg-background/95 px-2 backdrop-blur md:hidden">
          <SidebarTrigger className="size-8" />
          <Separator orientation="vertical" className="data-[orientation=vertical]:h-4" />
          <span className="truncate text-xs text-muted-foreground/75">Threads</span>
        </header>
      )}
      {isElectron && (
        <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5">
          <span className="text-xs text-muted-foreground/50">No active thread</span>
        </div>
      )}

      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <p className="text-sm">Select a thread or create a new one to get started.</p>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
