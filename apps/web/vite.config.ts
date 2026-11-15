import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

// SPA mode: the build prerenders one shell (no record data in it) that the Worker serves for every page, so
// the edge caches only the shell and static assets (docs/internals/architecture.md) and the client renders the
// record from sync.
export default defineConfig({
  plugins: [tanstackStart({ spa: { enabled: true, prerender: { outputPath: "/index.html" } } }), react()],
});
