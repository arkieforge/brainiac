import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

// Reference repos (`.repos/`) and generated state are read by agents, never linted, formatted or tested.
// Fixture notes are kept the way people write them, which is what the core tests check we never reformat.
// TanStack Router writes the route tree on every build, in its own format.
const IGNORED = [
  ".repos/**",
  ".alchemy/**",
  "**/node_modules/**",
  "**/dist/**",
  "pnpm-lock.yaml",
  "fixtures/**",
  "**/routeTree.gen.ts",
];

export default defineConfig({
  test: {
    environment: "node",
    // Browser tests run in Chromium from apps/web's own config (`vp run test:browser`), never in node.
    exclude: [...IGNORED, "**/*.browser.test.{ts,tsx}"],
    allowOnly: !process.env.CI,
    // Flaky tests are fixed, not retried.
    retry: 0,
  },
  staged: {
    // In order, so lint reads the formatted file.
    "*": ["vp fmt --no-error-on-unmatched-pattern", "vp lint --no-error-on-unmatched-pattern"],
  },
  fmt: {
    ignorePatterns: IGNORED,
    printWidth: 110,
  },
  lint: {
    ignorePatterns: IGNORED,
    plugins: ["eslint", "oxc", "typescript", "unicorn"],
    jsPlugins: ["./oxlint-plugin-brainiac/index.ts"],
    categories: { correctness: "error", suspicious: "warn" },
    rules: {
      "brainiac/no-cross-app-import": "error",
      "brainiac/no-em-dash-copy": "error",
      "brainiac/no-polling-loop-in-tests": "error",
      "brainiac/no-real-time-in-tests": "error",
      "brainiac/no-test-timeout-or-retry": "error",
      "brainiac/no-unreasoned-skip": "error",
    },
    overrides: [
      {
        // Copied from T3 Code and kept as upstream wrote it, so taking their fixes stays a plain diff.
        files: ["packages/render/src/office/**"],
        rules: {
          "eslint/no-shadow": "off",
          "unicorn/consistent-function-scoping": "off",
          "unicorn/no-array-sort": "off",
        },
      },
    ],
  },
});
