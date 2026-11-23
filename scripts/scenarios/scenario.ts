import type { Page } from "playwright";

import type { Agent } from "./agent.ts";

/**
 * One behaviour shown in the real site: a deployed stage or `vp run dev`, a real browser, and a fresh fixture
 * account per run. Each file beside this one default-exports one; scripts/e2e.ts runs them, and
 * scripts/prove-scenario.ts shows one failing before a fix and passing after it.
 */
export interface Scenario {
  /** Start from an empty record instead of the fixture student's seeded one (fixtures/nadia). */
  readonly empty?: boolean;
  /** Where the dev sign-in link lands. */
  readonly next?: string;
  /** In order. Each waits for what it shows; with `--evidence` the runner screenshots the page after it. */
  readonly steps: readonly Step[];
}

export interface Step {
  readonly name: string;
  readonly run: (page: Page, account: Account) => Promise<void>;
}

/** The fresh fixture account a run signs in as. */
export interface Account {
  /** What makes this run's account its own: the `+<tag>` in its address (dev.ts). */
  readonly tag: string;
  /** Its scripted agent (agent.ts): MCP calls on this account's record, as an agent connected at the floor. */
  readonly agent: Agent;
}
