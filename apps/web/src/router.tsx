import { createRouter } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen.ts";

/** TanStack Start calls this once per page load to make the app's router. */
export function getRouter() {
  return createRouter({ routeTree, scrollRestoration: true });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
