import { createRouter } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen.ts";

/** TanStack Start calls this once per page load to make the app's router. */
export function getRouter() {
  // Page changes run as view transitions: the pane cross-fades with a short rise, and a note's title morphs between
  // the overview row, the review card and the note (styles.css, ::view-transition).
  return createRouter({ routeTree, scrollRestoration: true, defaultViewTransition: true });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
