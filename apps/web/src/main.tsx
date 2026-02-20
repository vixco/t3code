import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { createHashHistory, createRouter, createBrowserHistory } from "@tanstack/react-router";
import { StoreProvider } from "./store";

import "@xterm/xterm/css/xterm.css";
import "highlight.js/styles/github-dark.css";
import "./index.css";

import { APP_DISPLAY_NAME } from "./branding";
import { isElectron } from "./env";
import { routeTree } from "./routeTree.gen";

if (!globalThis.crypto.randomUUID) {
  // https://stackoverflow.com/a/2117523/2800218
  // LICENSE: https://creativecommons.org/licenses/by-sa/4.0/legalcode
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  crypto.randomUUID = function randomUUID() {
    // @ts-expect-error -- Some cryptic stuff that this polyfill uses
    return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
      (c ^ (crypto.getRandomValues(new Uint8Array(1))[0]! & (15 >> (c / 4)))).toString(16),
    );
  };
}

const history = isElectron ? createHashHistory() : createBrowserHistory();

const queryClient = new QueryClient();
document.title = APP_DISPLAY_NAME;

const router = createRouter({
  routeTree,
  history,
  context: {
    queryClient,
  },
  Wrap: ({ children }) => (
    <QueryClientProvider client={queryClient}>
      <StoreProvider>{children}</StoreProvider>
    </QueryClientProvider>
  ),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
