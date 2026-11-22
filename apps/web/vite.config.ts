import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { playwright } from "vite-plus/test/browser-playwright";
import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

// SPA mode: the build prerenders one shell (no record data in it) that the Worker serves for every page, so
// the edge caches only the shell and static assets (docs/internals/architecture.md) and the client renders the
// record from sync.
export default defineConfig({
  // `@/` is src/, the alias shadcn writes into the components it adds (components.json).
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  plugins: [
    tailwindcss(),
    tanstackStart({ spa: { enabled: true, prerender: { outputPath: "/index.html" } } }),
    react(),
  ],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.{ts,tsx}"],
          exclude: ["src/**/*.browser.test.{ts,tsx}"],
        },
      },
      // Behaviour that needs a real browser (focus, keyboard, pointer, layout), in headless Chromium.
      {
        extends: true,
        test: {
          name: "browser",
          include: ["src/**/*.browser.test.{ts,tsx}"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
            screenshotFailures: false,
          },
        },
      },
    ],
  },
});
