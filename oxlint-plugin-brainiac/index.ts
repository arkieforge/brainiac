import { definePlugin } from "@oxlint/plugins";

import noCrossAppImport from "./rules/no-cross-app-import.ts";
import noEmDashCopy from "./rules/no-em-dash-copy.ts";
import noUnreasonedSkip from "./rules/no-unreasoned-skip.ts";

// Repo-specific rules. Each one encodes a mistake we don't want to review by hand twice.
export default definePlugin({
  meta: { name: "brainiac" },
  rules: {
    "no-cross-app-import": noCrossAppImport,
    "no-em-dash-copy": noEmDashCopy,
    "no-unreasoned-skip": noUnreasonedSkip,
  },
});
