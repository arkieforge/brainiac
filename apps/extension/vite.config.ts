import { defineConfig } from "vite-plus";

// Chrome loads the built folder as it is: the manifest from public/, each page and the service worker by a fixed
// name, since the manifest names them.
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Readable as shipped, for the person and the store's review; Chrome has no use for the preload polyfill.
    minify: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: { popup: "popup.html", options: "options.html", background: "src/background.ts" },
      output: { entryFileNames: "[name].js", chunkFileNames: "[name].js", assetFileNames: "[name][extname]" },
    },
  },
});
