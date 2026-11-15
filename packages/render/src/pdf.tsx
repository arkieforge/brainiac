// Adapted from T3 Code (apps/web/src/components/files/pdfDocument.ts and PdfViewer.tsx), MIT License,
// Copyright (c) 2026 T3 Tools Inc. See packages/render/NOTICE.md.
//
// A PDF is untrusted input. pdf.js parses it in a worker and paints pages to canvas; nothing in it runs: PDF
// JavaScript only runs through pdf.js' viewer scripting manager, which this never loads, XFA forms stay off, and
// pdf.js 6 dropped its `eval` font path (the `isEvalSupported` option is gone).
import { getDocument, GlobalWorkerOptions, PDFWorker, TextLayer, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import fallbackUrl from "pdfjs-dist/wasm/openjpeg_nowasm_fallback.js?url";
import { useEffect, useRef, useState } from "react";

import "./pdf.css";

GlobalWorkerOptions.workerSrc = workerUrl;

const standardFonts = import.meta.glob<string>("../node_modules/pdfjs-dist/standard_fonts/*", {
  query: "?url",
  import: "default",
  eager: true,
});
const cMaps = import.meta.glob<string>("../node_modules/pdfjs-dist/cmaps/*.bcmap", {
  query: "?url",
  import: "default",
  eager: true,
});
const wasm = import.meta.glob<string>("../node_modules/pdfjs-dist/wasm/*.{wasm,js}", {
  query: "?url",
  import: "default",
  eager: true,
});

/** Serves pdf.js' fonts, character maps and decoders from the site's own build. */
class BinaryDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }) {
    const assets = kind === "cMapUrl" ? cMaps : kind === "wasmUrl" ? wasm : standardFonts;
    const directory = kind === "cMapUrl" ? "cmaps" : kind === "wasmUrl" ? "wasm" : "standard_fonts";
    const url = assets[`../node_modules/pdfjs-dist/${directory}/${filename}`];
    if (!url) throw new Error(`Unsupported PDF ${directory} asset.`);
    const response = await fetch(url);
    if (!response.ok || response.headers.get("content-type")?.startsWith("text/html"))
      throw new Error(`PDF ${directory} asset unavailable.`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

// Without a shared worker, pdf.js starts a worker and recompiles its 1.3 MB script for every document.
let worker: PDFWorker | undefined;

function openPdf(bytes: Uint8Array) {
  worker ??= new PDFWorker();
  return getDocument({
    worker,
    data: bytes,
    enableXfa: false,
    useSystemFonts: true,
    useWorkerFetch: false,
    BinaryDataFactory,
    // pdf.js imports its JavaScript decoders directly, bypassing BinaryDataFactory.
    wasmUrl: new URL(".", new URL(fallbackUrl, window.location.href)).href,
    canvasMaxAreaInBytes: 32 * 1024 * 1024,
    useWasm: true,
  });
}

/** Pages past this aren't drawn; the viewer says how many it left out. */
const MAX_PAGES = 200;

function PdfPage({ pdf, index, width }: { pdf: PDFDocumentProxy; index: number; width: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    let paint: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | undefined;
    let layer: TextLayer | undefined;
    let loaded: Awaited<ReturnType<PDFDocumentProxy["getPage"]>> | undefined;
    void (async () => {
      const page = await pdf.getPage(index + 1);
      loaded = page;
      if (cancelled || !canvas.current || !text.current) return;
      const natural = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: width / natural.width });
      const ratio = Math.min(
        2,
        window.devicePixelRatio || 1,
        Math.sqrt((8 * 1024 * 1024) / (viewport.width * viewport.height)),
      );
      canvas.current.width = Math.ceil(viewport.width * ratio);
      canvas.current.height = Math.ceil(viewport.height * ratio);
      canvas.current.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
      paint = page.render({
        canvas: canvas.current,
        viewport,
        transform: [ratio, 0, 0, ratio, 0, 0],
        background: "white",
      });
      text.current.replaceChildren();
      text.current.style.setProperty("--total-scale-factor", String(viewport.scale));
      layer = new TextLayer({
        container: text.current,
        viewport,
        textContentSource: page.streamTextContent(),
      });
      await Promise.all([paint.promise, layer.render()]);
    })().catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : "This page could not render.");
    });
    return () => {
      cancelled = true;
      paint?.cancel();
      layer?.cancel();
      void Promise.allSettled([paint?.promise]).then(() => loaded?.cleanup());
    };
  }, [pdf, index, width]);
  return (
    <div className="pdf-page" aria-label={`Page ${index + 1}`}>
      <canvas ref={canvas} />
      <div ref={text} data-pdf-text-layer />
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

/** A PDF's pages, drawn to fit the pane's width, with selectable text. */
export function PdfViewer({ bytes }: { readonly bytes: Uint8Array }) {
  const box = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [error, setError] = useState<string>();
  const [width, setWidth] = useState(0);
  useEffect(() => {
    // pdf.js takes ownership of the buffer it's given, so it gets a copy.
    const task = openPdf(bytes.slice());
    task.promise.then(setPdf, (cause: unknown) =>
      setError(cause instanceof Error ? cause.message : "This PDF could not open."),
    );
    return () => void task.destroy();
  }, [bytes]);
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const measure = () => setWidth(Math.floor(node.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const pages = Math.min(pdf?.numPages ?? 0, MAX_PAGES);
  return (
    <div className="pdf" ref={box}>
      {error && <p role="alert">{error}</p>}
      {!pdf && !error && <p className="muted">Opening the PDF…</p>}
      {pdf &&
        width > 0 &&
        Array.from({ length: pages }, (_, index) => (
          <PdfPage key={index} pdf={pdf} index={index} width={width} />
        ))}
      {pdf && pdf.numPages > MAX_PAGES && (
        <p className="muted">
          Showing the first {MAX_PAGES} of {pdf.numPages} pages.
        </p>
      )}
    </div>
  );
}
