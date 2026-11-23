import {
  chunkFile,
  chunkNote,
  EMBED_MODEL,
  extracts,
  isImage,
  needsReading,
  pdfHidesText,
  pdfJpegs,
  quantize,
  mediaType,
  readText,
  splitPages,
  type ChunkInput,
  type Extracted,
  type OcrReading,
} from "@brainiac/base";

import { scan } from "@brainiac/core";

import type { JobMessage, JobWork } from "./base.ts";
import { lookupDoi, type Web } from "./connectors/doi.ts";
import { readLink } from "./connectors/links.ts";
import { readProfile } from "./connectors/profiles.ts";
import type { Env } from "./env.ts";
import type { Remind } from "./reminders.ts";

/** The OCR Worker (apps/ocr): what it read in an image, for the checks and the MRZ parse only. */
export interface Ocr {
  read(image: Uint8Array): Promise<OcrReading | undefined>;
}

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
  env: Pick<Env, "BASE" | "TREG_TOKEN" | "BROWSER"> & { readonly AI?: Models; readonly OCR: Ocr },
  /** The outside world, for lookups: a test answers in its place. */
  web: Web = fetch,
  /** Sends a record's expiry reminder email; a stage that sends no email sends nothing, and counts them sent. */
  remind: Remind = async () => {},
): Promise<void> {
  // A batch's jobs run side by side, so a re-index backlog doesn't hold a fresh upload behind it one at a time. Its
  // OCR calls go one at a time: each holds an image's bytes in the OCR Worker's memory while it waits its turn.
  const ocr = oneAtATime(env.OCR);
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
        } else if (work?.kind === "doi") {
          await base.installLookup(message.body.jobId, await lookupDoi(work.doi, web));
        } else if (work?.kind === "drift") {
          await base.installProfile(message.body.jobId, await readProfile(work.work, env.TREG_TOKEN, web));
        } else if (work?.kind === "link") {
          const { BROWSER } = env;
          const print = BROWSER && ((url: string) => BROWSER.quickAction("pdf", { url }));
          const read = await readLink(work.work, { token: env.TREG_TOKEN, print }, web);
          await base.installLink(message.body.jobId, read.seen, read.pdf);
        } else if (work?.kind === "remind") {
          await remind(message.body.base, work.reminder);
          await base.installReminders(message.body.jobId, work.reminder.covered);
        } else if (work?.kind === "file") {
          const extracted = await extract(env.AI, ocr, work);
          // Only pages that can be indexed are embedded: none, while a page needs reading.
          // A page that needs reading, or text the checks will find something in, keeps the file from clearing.
          const unread = extracts(work.mime) && extracted.pages?.some(needsReading);
          const found =
            (extracted.text !== undefined && scan(extracted.text).length > 0) ||
            (extracted.ocr ?? []).some((image) => scan(image.text, "ocr").length > 0);
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
 * All of a file's text and its pages: a PDF's text layer through `toMarkdown`, plain text as it is. OCR reads a
 * photo and a PDF's JPEGs for the checks and the MRZ parse only (`ocr`): a photo gets no pages, so it stays unread,
 * and a PDF with an image stays unread by `pdfHidesText` whatever OCR found in it. Anything else is unread.
 */
async function extract(
  ai: Models | undefined,
  ocr: Ocr,
  file: Extract<JobWork, { kind: "file" }>,
): Promise<Extracted> {
  if (isImage(file.mime)) {
    const reading = await ocr.read(file.bytes);
    return { text: undefined, pages: undefined, ...(reading && { ocr: [reading] }) };
  }
  if (mediaType(file.mime) !== "application/pdf") {
    const text = readText(file.bytes, file.mime);
    return { text, pages: text === undefined ? undefined : [text] };
  }
  // Without Workers AI nothing reads a PDF's text layer, so it stays unread, as one it can't convert does.
  if (!ai) return { text: undefined, pages: undefined };
  const result = await ai.toMarkdown(
    // Named by its id, never the person's filename.
    { name: `${file.sha256.slice(0, 16)}.pdf`, blob: new Blob([file.bytes], { type: "application/pdf" }) },
    // Metadata (title, keywords) comes before `## Contents`: the checks read it, search never holds it.
    { conversionOptions: { pdf: { metadata: true } } },
  );
  // A PDF it can't convert (encrypted, corrupt) stays unread for good, which the person sees; a failed call throws.
  if (result.format === "error") return { text: undefined, pages: undefined };
  // Its JPEGs (a scan's pages, a photo of a passport) are read one at a time: each holds the OCR Worker's memory.
  const readings: OcrReading[] = [];
  for (const jpeg of pdfJpegs(file.bytes)) {
    const reading = await ocr.read(jpeg);
    if (reading) readings.push(reading);
  }
  // A PDF that may show more than its text layer: all of the text is checked, but no page counts as read.
  return {
    text: result.data,
    pages: pdfHidesText(file.bytes) ? undefined : splitPages(result.data),
    ...(readings.length > 0 && { ocr: readings }),
  };
}

/** `ocr`, its calls made one after another. */
function oneAtATime(ocr: Ocr): Ocr {
  let turn: Promise<unknown> = Promise.resolve();
  return {
    read(image) {
      const reading = turn.then(() => ocr.read(image));
      turn = reading.catch(() => undefined);
      return reading;
    },
  };
}

// Workers AI takes up to 100 texts per bge-m3 call.
const BATCH = 100;

/**
 * One int8 vector per chunk, in order: the header and text together, as search will match them. None without
 * Workers AI: the chunks install without vectors, and search over them is keyword only.
 */
async function embed(
  ai: Models | undefined,
  chunks: readonly Pick<ChunkInput, "header" | "text">[],
): Promise<Uint8Array[]> {
  const vectors: Uint8Array[] = [];
  if (!ai) return vectors;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const text = chunks.slice(i, i + BATCH).map((chunk) => `${chunk.header}\n${chunk.text}`);
    // Too long for the model is cut, not refused: the chunk's text is still searchable whole by keyword.
    const { data } = await ai.run(EMBED_MODEL, { text, truncate_inputs: true });
    if (data?.length !== text.length) throw new Error(`${EMBED_MODEL} returned ${data?.length} vectors`);
    vectors.push(...data.map(quantize));
  }
  return vectors;
}
