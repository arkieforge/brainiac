// Adapted from T3 Code (apps/web/src/components/chat/MarkdownMath.tsx), MIT License, Copyright (c) 2026 T3 Tools
// Inc. See packages/render/NOTICE.md.
import { lazy, Suspense } from "react";

const Typeset = lazy(() => import("./typeset.tsx"));

/** One formula from remark-math: its TeX until KaTeX loads, and whenever KaTeX can't read it. */
export function Formula({ tex, display }: { readonly tex: string; readonly display: boolean }) {
  const source = display ? `\\[\n${tex.trim()}\n\\]` : `\\(${tex.trim()}\\)`;
  const fallback = <span className="math-source">{source}</span>;
  return (
    <span className={display ? "math math-display" : "math math-inline"}>
      <Suspense fallback={fallback}>
        <Typeset tex={tex.trim()} display={display} fallback={fallback} />
      </Suspense>
    </span>
  );
}
