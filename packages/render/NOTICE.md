# Notice

Parts of this package are copied or adapted from [T3 Code](https://github.com/pingdotgg/t3code), under the MIT
License (`LICENSE-t3code`), Copyright (c) 2026 T3 Tools Inc. Each such file says so at its top:

- `src/alerts.ts`: GitHub alerts (`markdownGithubAlerts.ts`)
- `src/markdown.tsx`: the sanitize schema and the cached renderer (`markdownPipeline.ts`, `markdownRenderer.ts`)
- `src/math.tsx` and `src/typeset.tsx`: KaTeX typesetting (`MarkdownMath.tsx`, `MathTypeset.tsx`)
- `src/pdf.tsx` and `src/pdf.css`: the pdf.js document and page glue and its text layer (`pdfDocument.ts`,
  `PdfViewer.tsx`, `pdfViewer.css`)
- `src/office/`: the Office Open XML viewer (`apps/web/src/components/files/OpenXmlOfficeViewer.tsx`,
  `officeArchive.ts`, `officePreview.worker.ts`, `officePreviewProtocol.ts`, `office/*`), with the helpers it
  needs from `packages/shared` (`imageDimensions.ts`), `packages/client-runtime` (`zip/zipDirectory.ts`) and
  `apps/web/src/lib` and `hooks` (`observeResize.ts`, `useStableCallback.ts`). `officeArchive.ts` also leaves
  out a file's VBA project, so macros never reach an engine.
- `src/delimited.ts`: the CSV and TSV parser (`packages/shared/src/delimitedPreview.ts`)

Some of the Office viewer's files are in turn adapted from [opencode](https://github.com/sst/opencode), under
the MIT License (`LICENSE-opencode`), Copyright (c) 2025 opencode, and say so at their top. The engines
themselves are the `@betteroffice/*` packages (Apache-2.0; the bundled fonts are under their own open licenses).
