// Copied from T3 Code (apps/web/src/components/files/office/Presentation.tsx), MIT License, Copyright (c) 2026 T3 Tools Inc. See packages/render/NOTICE.md.
/* oxlint-disable react/no-unstable-nested-components -- These callbacks return overlays, and are invoked as render functions. */
import { useEffect, useRef, useState } from "react";
import { Action, Loading } from "./chrome.tsx";
import { OfficePages, type PaintPage } from "./OfficePages.tsx";
import { createWorkerClient } from "./worker-rpc.ts";
import type { SlideMethods, SlideSummary } from "./slide-protocol.ts";
import { rasterize } from "./vector-pictures.ts";

type Opened = { slides: readonly SlideSummary[]; paint: PaintPage };
export default function Presentation(props: {
  bytes: ArrayBuffer;
  onDetails: (text: string) => void;
  onError: (cause: unknown) => void;
}) {
  const { onError, bytes: source, onDetails } = props;
  const [opened, setOpened] = useState<Opened>();
  const [page, setPage] = useState(0);
  const [failed, setFailed] = useState<Record<number, boolean>>({});
  const scroll = useRef<((index: number, y?: number) => void) | null>(null);
  // Open and paint slides through a worker whose requests and lifetime belong to this presentation.
  useEffect(() => {
    const controller = new AbortController();
    const worker = new Worker(new URL("./presentation.worker.ts", import.meta.url), {
      type: "module",
    });
    const engine = createWorkerClient<SlideMethods>(worker);
    const fail = (cause: unknown) => {
      if (!controller.signal.aborted) onError(cause);
    };
    worker.addEventListener("error", fail);
    worker.addEventListener("messageerror", fail);
    const paint = async (
      index: number,
      canvas: HTMLCanvasElement,
      scale: number,
      signal: AbortSignal,
      again = false,
    ): Promise<void> => {
      const result = await engine.call(
        "paint",
        { index, density: (window.devicePixelRatio || 1) * scale },
        { key: `slide:${index}`, signal },
      );
      if (signal.aborted || result.kind === "cancelled") {
        if (result.kind === "painted") result.bitmap.close();
        return;
      }
      setFailed((previous) => ({ ...previous, [index]: result.kind === "failed" }));
      if (result.kind === "failed") return;
      const context = canvas.getContext("bitmaprenderer");
      if (!context) {
        result.bitmap.close();
        throw new Error("This browser cannot draw slides.");
      }
      canvas.width = result.bitmap.width;
      canvas.height = result.bitmap.height;
      context.transferFromImageBitmap(result.bitmap);
      if (again || !result.vectors.length) return;
      const bitmaps = await Promise.all(result.vectors.map(rasterize));
      if (signal.aborted) {
        bitmaps.forEach((value) => value.bitmap?.close());
        return;
      }
      await engine.call("vectors", bitmaps, {
        transfer: bitmaps.flatMap((value) => (value.bitmap ? [value.bitmap] : [])),
        signal,
      });
      if (!signal.aborted) await paint(index, canvas, scale, signal, true);
    };
    const bytes = source.slice(0);
    void engine
      .call("open", { bytes }, { transfer: [bytes], signal: controller.signal })
      .then((slides) => {
        if (slides.length === 0 || slides.length > 500)
          throw new Error("Preview limited to presentations with 1 to 500 slides.");
        setOpened({ slides, paint });
        onDetails(`${slides.length} slide${slides.length === 1 ? "" : "s"}`);
      })
      .catch(fail);
    return () => {
      controller.abort();
      engine.close();
    };
  }, [source, onDetails, onError]);
  if (!opened) return <Loading />;
  const select = (index: number) => {
    setPage(index);
    scroll.current?.(index);
  };
  return (
    <div className="office">
      <div className="office-bar">
        <Action label="Previous slide" disabled={page === 0} onPress={() => select(page - 1)}>
          ‹
        </Action>
        <span className="office-count" aria-live="polite">
          Slide {page + 1} of {opened.slides.length}
        </span>
        <Action
          label="Next slide"
          disabled={page + 1 === opened.slides.length}
          onPress={() => select(page + 1)}
        >
          ›
        </Action>
      </div>
      <OfficePages
        pages={opened.slides}
        paint={opened.paint}
        label="Slide"
        scrollRef={scroll}
        onPageChange={setPage}
        onError={onError}
        overlay={(index) => (
          <>
            {opened.slides[index]?.hidden ? <div className="office-hidden-slide" /> : null}
            {failed[index] ? (
              <p role="status" className="office-slide-failed small">
                This slide could not be drawn.
              </p>
            ) : null}
          </>
        )}
        footer={(index) => {
          const slide = opened.slides[index];
          return slide?.notes || slide?.hidden ? (
            <div className="office-notes small muted">
              {slide.hidden ? <p>Hidden slide</p> : null}
              {slide.notes ? (
                <p role="note" aria-label="Speaker notes">
                  {slide.notes}
                </p>
              ) : null}
            </div>
          ) : null;
        }}
      />
    </div>
  );
}
