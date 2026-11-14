import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

// Reference repos (`.repos/`) and generated state are read by agents, never linted, formatted or tested.
// Fixture notes are kept the way people write them, which is what the core tests check we never reformat.
const IGNORED = [
  ".repos/**",
  ".alchemy/**",
  "**/node_modules/**",
  "**/dist/**",
  "pnpm-lock.yaml",
  "fixtures/**",
];

export default defineConfig({
  test: {
    environment: "node",
    exclude: IGNORED,
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
      "brainiac/no-em-dash-copy": "error",
      "brainiac/no-unreasoned-skip": "error",
    },
  },
});
