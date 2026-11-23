// The jobs consumer on a stage without Workers AI (`vp run dev:standalone`): its jobs still finish, keyword only.
import type { ChunkInput, Extracted, NoteRow } from "@brainiac/base";
import { expect, it } from "vite-plus/test";

import type { JobMessage, JobWork } from "./base.ts";
import { consume } from "./jobs.ts";

// The fixture student's (fictional) award.
const NOTE: NoteRow = {
  id: "01M7AAAAAAAAAAAAAAAAAAAAAA",
  path: "facts/awards/deans-list.md",
  raw: "---\ntype: Award\ntitle: Dean's list\n---\nAwarded for the 2024 spring term.\n",
  fm: "{}",
  rev: 1,
  hash: "h",
  seq: 1,
  class: "normal",
  deletedAt: null,
  type: "Award",
  title: "Dean's list",
  kind: null,
  status: null,
  date: null,
  deadline: null,
  expires: null,
};
const WORK: Record<string, JobWork> = {
  note: { kind: "index", note: NOTE },
  pdf: {
    kind: "file",
    sha256: "ab".repeat(32),
    mime: "application/pdf",
    fileKind: null,
    bytes: new TextEncoder().encode("%PDF-1.7\n"),
    embed: true,
  },
};

it("without Workers AI, installs a note's chunks without vectors and leaves a PDF unread", async () => {
  const installed: unknown[] = [];
  const record = {
    jobInput: async (jobId: string) => WORK[jobId],
    installIndex: async (jobId: string, chunks: readonly ChunkInput[]) =>
      void installed.push([jobId, chunks.length > 0, chunks.some((chunk) => chunk.vector)]),
    installFile: async (jobId: string, extracted: Extracted, vectors: readonly Uint8Array[]) =>
      void installed.push([jobId, extracted, vectors]),
  };
  const acked: string[] = [];
  const batch = {
    messages: Object.keys(WORK).map((jobId) => ({
      body: { base: "ada", jobId },
      ack: () => void acked.push(jobId),
      retry: () => void acked.push(`retry ${jobId}`),
    })),
  } as unknown as MessageBatch<JobMessage>;
  // OCR is never reached: a PDF's images are read only beside its text layer.
  const env = { BASE: { idFromString: (id: string) => id, get: () => record }, OCR: {} };
  await consume(batch, env as unknown as Parameters<typeof consume>[1]);
  expect(acked.toSorted()).toEqual(["note", "pdf"]);
  expect(installed).toContainEqual(["note", true, false]);
  expect(installed).toContainEqual(["pdf", { text: undefined, pages: undefined }, []]);
});
