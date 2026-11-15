// Copied from T3 Code (apps/web/src/components/chat/MathTypeset.tsx), MIT License, Copyright (c) 2026 T3 Tools Inc.
// See packages/render/NOTICE.md. KaTeX lives in this lazily loaded chunk, fetched only once a formula renders.
import katex from "katex";
import "katex/dist/katex.min.css";
import type { ReactNode } from "react";

const cache = new Map<string, string>();
const MAX_CACHED = 1000;

function typeset(tex: string, display: boolean): string {
  const key = `${display ? "display" : "inline"}:${tex}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let html = "";
  try {
    html = katex.renderToString(tex, {
      displayMode: display,
      output: "htmlAndMathml",
      throwOnError: true,
      // No \href, \url, \htmlClass, or other commands that emit active HTML.
      trust: false,
      strict: "ignore",
      maxSize: 20,
      maxExpand: 1000,
    });
  } catch {
    // TeX KaTeX can't read stays readable as its source.
  }
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value ?? "");
  cache.set(key, html);
  return html;
}

export default function Typeset(props: {
  readonly tex: string;
  readonly display: boolean;
  readonly fallback: ReactNode;
}) {
  const html = typeset(props.tex, props.display);
  if (!html) return props.fallback;
  // KaTeX escapes the TeX it renders, and `trust: false` keeps it from emitting links or attributes.
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}
