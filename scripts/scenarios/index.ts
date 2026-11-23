import passkeySignIn from "./passkey-sign-in.ts";
import type { Scenario } from "./scenario.ts";
import seededRecord from "./seeded-record.ts";

/** Every scenario by the name `vp run e2e --scenario` and `vp run scenarios:prove` take. Add a new one here. */
export const SCENARIOS = {
  "passkey-sign-in": passkeySignIn,
  "seeded-record": seededRecord,
} satisfies Record<string, Scenario>;
