import {
  chunkFile,
  chunkNote,
  EMBED_MODEL,
  extracts,
  needsReading,
  pdfHidesText,
  quantize,
  readText,
  splitPages,
  type ChunkInput,
  type Extracted,
} from "@brainiac/base";

import { scan } from "@brainiac/core";

import type { JobMessage, JobWork } from "./base.ts";
import type { Env } from "./env.ts";

/** The part of Workers AI ingest uses: document-to-text and embeddings, no generation. */
export interface Models {
  toMarkdown(file: MarkdownDocument, options?: ConversionRequestOptions): Promise<ConversionResponse>;
  run(
    model: typeof EMBED_MODEL,
    inputs: { text: string[]; truncate_inputs: boolean },
  ): Promise<{ readonly data?: number[][] }>;
}

/**
 * The jobs queue's consumer: does each job's work outside the record, then hands the result back, which the
 * record installs only if the note or file is still at the job's revision. A failure retries the message; the
 * record's lease also re-sends anything never acknowledged.
 */
export async function consume(
  batch: MessageBatch<JobMessage>,
  env: Pick<Env, "BASE"> & { readonly AI: Models },
): Promise<void> {
  // A batch's jobs run side by side, so a re-index backlog doesn't hold a fresh upload behind it one at a time.
  await Promise.all(
    batch.messages.map(async (message) => {
      try {
        const base = env.BASE.get(env.BASE.idFromString(message.body.base));
        const work = await base.jobInput(message.body.jobId);
        if (work?.kind === "index") {
          const chunks = chunkNote(work.note);
          const vectors = await embed(env.AI, chunks);
          await base.installIndex(
            message.body.jobId,
            chunks.map((chunk, i) => {
              const vector = vectors[i];
              return vector ? { ...chunk, vector } : chunk;
            }),
          );
        } else if (work?.kind === "file") {
          const extracted = await extract(env.AI, work);
          // Only pages that can be indexed are embedded: none, while a page needs reading.
          // A page that needs reading, or text the checks will find something in, keeps the file from clearing.
          const unread = extracts(work.mime) && extracted.pages?.some(needsReading);
          const found = extracted.text !== undefined && scan(extracted.text).length > 0;
          const readable = unread || found ? undefined : extracted.pages;
          const pages = work.embed && readable ? chunkFile({ ...work, kind: work.fileKind }, readable) : [];
          await base.installFile(message.body.jobId, extracted, await embed(env.AI, pages));
        }
        message.ack();
      } catch (error) {
        console.error("job failed", message.body.jobId, error);
        message.retry();
      }
    }),
  );
}

/**
 * All of a file's text and its pages: a PDF's text layer through `toMarkdown`, plain text as it is. Anything else
 * is unread.
 */
async function extract(ai: Models, file: Extract<JobWork, { kind: "file" }>): Promise<Extracted> {
  if (!extracts(file.mime)) {
    const text = readText(file.bytes, file.mime);
    return { text, pages: text === undefined ? undefined : [text] };
  }
  const result = await ai.toMarkdown(
    // Named by its id, never the person's filename.
    { name: `${file.sha256.slice(0, 16)}.pdf`, blob: new Blob([file.bytes], { type: "application/pdf" }) },
    // Metadata (title, keywords) comes before `## Contents`: the checks read it, search never holds it.
    { conversionOptions: { pdf: { metadata: true } } },
  );
  // A PDF it can't convert (encrypted, corrupt) stays unread for good, which the person sees; a failed call throws.
  if (result.format === "error") return { text: undefined, pages: undefined };
  // A PDF that may show more than its text layer: all of the text is checked, but no page counts as read.
  return { text: result.data, pages: pdfHidesText(file.bytes) ? undefined : splitPages(result.data) };
}

// Workers AI takes up to 100 texts per bge-m3 call.
const BATCH = 100;

/** One int8 vector per chunk, in order: the header and text together, as search will match them. */
async function embed(
  ai: Models,
  chunks: readonly Pick<ChunkInput, "header" | "text">[],
): Promise<Uint8Array[]> {
  const vectors: Uint8Array[] = [];
  for (let i = 0; i < chunks.length; i += BATCH) {
    const text = chunks.slice(i, i + BATCH).map((chunk) => `${chunk.header}\n${chunk.text}`);
    // Too long for the model is cut, not refused: the chunk's text is still searchable whole by keyword.
    const { data } = await ai.run(EMBED_MODEL, { text, truncate_inputs: true });
    if (data?.length !== text.length) throw new Error(`${EMBED_MODEL} returned ${data?.length} vectors`);
    vectors.push(...data.map(quantize));
  }
  return vectors;
}
