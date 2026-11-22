// Mounts a component for one browser test (`*.browser.test.tsx`), the way T3 Code's apps/web/test/render.tsx does.
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
  type AnyRouter,
} from "@tanstack/react-router";
import { act as reactAct, createContext, use, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { page, utils, type Locator, type LocatorSelectors } from "vite-plus/test/browser";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// React warns about every update outside act() while this flag is on, and a real browser drives updates from
// userEvent, timers and sync that act() can't wrap. So it is on only while act() runs.
async function act(callback: () => void): Promise<void> {
  const previous = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await reactAct(async () => callback());
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous;
  }
}

/** Queries are scoped to the container; use `page` for portals such as the palette's dialog. */
export interface Screen extends LocatorSelectors, AsyncDisposable {
  readonly container: HTMLElement;
  readonly locator: Locator;
  /** The test's memory router, at "/" to start; read `router.state.location` to see where the component went. */
  readonly router: AnyRouter;
  /** Renders `ui` in place of the last tree, as a parent re-rendering with new props would. Pass a fresh element. */
  readonly rerender: (ui: ReactNode) => Promise<void>;
}

const RoutedUi = createContext<ReactNode>(null);

function RoutedUiOutlet() {
  return use(RoutedUi);
}

/**
 * Renders `ui` for one test inside a router (the site's components link and navigate). Acquire it with
 * `await using screen = await render(...)` so the tree unmounts and the container goes away when the test ends,
 * pass or fail.
 */
export async function render(ui: ReactNode): Promise<Screen> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const router = createRouter({
    routeTree: createRootRoute({ component: RoutedUiOutlet }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    // The router's error UI would otherwise turn a crash into a passing negative assertion.
    disableGlobalCatchBoundary: true,
  });
  // Created once, so a rerender updates the tree instead of remounting it.
  const routerElement = <RouterProvider router={router} />;
  const screen: Screen = {
    ...utils.getElementLocatorSelectors(container),
    container,
    locator: page.elementLocator(container),
    router,
    rerender: (next) => act(() => root.render(<RoutedUi value={next}>{routerElement}</RoutedUi>)),
    async [Symbol.asyncDispose]() {
      try {
        await act(() => root.unmount());
      } finally {
        container.remove();
      }
    },
  };
  try {
    await screen.rerender(ui);
  } catch (error) {
    await screen[Symbol.asyncDispose]();
    throw error;
  }
  return screen;
}
