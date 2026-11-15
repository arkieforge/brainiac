// Adapted from T3 Code (apps/web/src/components/files/OpenXmlOfficeViewer.tsx), MIT License, Copyright (c) 2026
// T3 Tools Inc. See packages/render/NOTICE.md.
import { lazy, Suspense, useEffect, useState } from "react";

import { Loading, Notice } from "./chrome.tsx";
import "./office.css";
import {
  OFFICE_PREVIEW_MAX_BYTES,
  type OfficeKind,
  type OfficeWorkerResult,
} from "./officePreviewProtocol.ts";
import { useStableCallback } from "./stable-callback.ts";

const WordDocument = lazy(() => import("./WordDocument.tsx"));
const Spreadsheet = lazy(() => import("./Spreadsheet.tsx"));
const Presentation = lazy(() => import("./Presentation.tsx"));

/**
 * A Word, Excel or PowerPoint file, drawn entirely in the browser. A worker first rebuilds the archive with only the
 * parts the engines read (no macros, ActiveX or embedded objects), then each format's engine lays it out and paints
 * it in a worker of its own.
 */
export function OfficeViewer(props: { readonly bytes: Uint8Array; readonly kind: OfficeKind }) {
  const [error, setError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<Extract<OfficeWorkerResult, { bytes: ArrayBuffer }>>();
  const [details, setDetails] = useState("");
  const fail = useStableCallback((cause: unknown) =>
    setError(cause instanceof Error ? cause.message : "Could not render this Office document."),
  );
  useEffect(() => {
    if (props.bytes.byteLength > OFFICE_PREVIEW_MAX_BYTES) {
      setError("Preview limited to files under 50 MB.");
      return;
    }
    let done = false;
    const worker = new Worker(new URL("./officePreview.worker.ts", import.meta.url), { type: "module" });
    const failure = (cause: unknown) => {
      if (!done) fail(cause);
      done = true;
      worker.terminate();
    };
    const timer = setTimeout(
      () => failure(new Error("This document took too long to preview. Download it to open it.")),
      30000,
    );
    worker.addEventListener("error", () => failure(new Error("Could not load the Office viewer.")));
    worker.addEventListener("messageerror", () =>
      failure(new Error("Could not read the Office viewer response.")),
    );
    worker.addEventListener("message", (event: MessageEvent<OfficeWorkerResult>) => {
      if (done) return;
      clearTimeout(timer);
      if (event.data.type === "error") failure(new Error(event.data.message));
      else {
        setPrepared(event.data);
        done = true;
        worker.terminate();
      }
    });
    // A copy: the worker takes its buffer, and the page keeps these bytes for a re-render.
    const bytes = props.bytes.slice().buffer;
    worker.postMessage({ type: "open", kind: props.kind, bytes }, [bytes]);
    return () => {
      done = true;
      worker.terminate();
      clearTimeout(timer);
    };
  }, [props.bytes, props.kind, fail]);
  if (error)
    return (
      <div role="alert" className="office-failure">
        <p>No preview for this file</p>
        <p className="small muted">{error} Download it to open it in another app.</p>
      </div>
    );
  if (!prepared) return <Loading />;
  const Viewer = props.kind === "docx" ? WordDocument : Presentation;
  return (
    <div className="office">
      {details ? (
        <div className="office-bar">
          <span className="small muted" aria-live="polite">
            {details}
            {props.kind !== "xlsx" ? " · Fit to width" : ""}
          </span>
        </div>
      ) : null}
      {prepared.truncated ? <Notice>Preview limited. Download the file to read all of it.</Notice> : null}
      <Suspense fallback={<Loading />}>
        {prepared.view ? (
          <Spreadsheet bytes={prepared.bytes} view={prepared.view} onDetails={setDetails} onError={fail} />
        ) : (
          <Viewer bytes={prepared.bytes} onDetails={setDetails} onError={fail} />
        )}
      </Suspense>
    </div>
  );
}
