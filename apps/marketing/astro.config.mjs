// The public site (#52): static pages, deployed as a Worker's assets by alchemy.run.ts.
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "static",
  // Inline small stylesheets: one request less on a page that has to load fast on a phone.
  build: { inlineStylesheets: "auto" },
});
