// Adapted from T3 Code (apps/web/src/components/files/officePreview.worker.ts), MIT License, Copyright (c) 2026
// T3 Tools Inc. See packages/render/NOTICE.md.
import { prepareOffice } from "./officeArchive.ts";
import type { OfficeWorkerRequest, OfficeWorkerResult } from "./officePreviewProtocol.ts";

function reply(result: OfficeWorkerResult) {
  self.postMessage(result, { transfer: "bytes" in result ? [result.bytes] : [] });
}

// The archive is unpacked and rebuilt here, off the page: only the parts the engines read go back, so macros
// (`vbaProject.bin`), ActiveX and embedded objects never reach them.
self.addEventListener("message", (event: MessageEvent<OfficeWorkerRequest>) => {
  const input = event.data;
  void prepareOffice(input.bytes, input.kind)
    .then((prepared) => reply({ type: input.kind, ...prepared }))
    .catch((cause: unknown) =>
      reply({
        type: "error",
        message: cause instanceof Error ? cause.message : "Could not parse this file.",
      }),
    );
});
