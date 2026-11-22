import { definePlugin } from "@oxlint/plugins";

import noCrossAppImport from "./rules/no-cross-app-import.ts";
import noEmDashCopy from "./rules/no-em-dash-copy.ts";
import noPollingLoopInTests from "./rules/no-polling-loop-in-tests.ts";
import noRealTimeInTests from "./rules/no-real-time-in-tests.ts";
import noTestTimeoutOrRetry from "./rules/no-test-timeout-or-retry.ts";
import noUnreasonedSkip from "./rules/no-unreasoned-skip.ts";

// Repo-specific rules. Each one encodes a mistake we don't want to review by hand twice.
export default definePlugin({
  meta: { name: "brainiac" },
  rules: {
    "no-cross-app-import": noCrossAppImport,
    "no-em-dash-copy": noEmDashCopy,
    "no-polling-loop-in-tests": noPollingLoopInTests,
    "no-real-time-in-tests": noRealTimeInTests,
    "no-test-timeout-or-retry": noTestTimeoutOrRetry,
    "no-unreasoned-skip": noUnreasonedSkip,
  },
});
