// OCR for the vault's checks (contract §5): the text of a photo or a scanned page, so the checks find what it prints
// (an account number keeps the file in the vault) and a passport's MRZ is parsed. It never clears a file: OCR can't
// vouch it saw all an image says. Nothing it reads reaches search or an agent; the main Worker's jobs consumer
// calls `read` and hands the text to the checks and the MRZ parse only.
//
// Its own Worker, called over RPC, because Tesseract holds about 60 MB of wasm heap for the life of an isolate:
// beside the record's Durable Objects that would crowd the 128 MB limit, and its 2 MB of wasm would slow every
// cold start of the main Worker. Calls in one isolate run one at a time for the same reason.
//
// Models (apps/ocr/models, served as this Worker's assets):
// - eng.traineddata: tesseract-ocr/tessdata_fast@923915d4 (Apache-2.0), for a page's text.
// - mrz.traineddata: DoubangoTelecom/tesseractMRZ@0f039b6d tessdata_best (BSD-3-Clause), for OCR-B machine-readable
//   zones, which the English model misreads (`<` as `c` or `e`).
import { WorkerEntrypoint } from "cloudflare:workers";
import { decode } from "fast-png";
import { createOCREngine, type OCREngine } from "tesseract-wasm";
import wasmModule from "tesseract-wasm/tesseract-core.wasm";

import { refused } from "./refused.ts";
import { printedZone } from "./zone.ts";

export interface Env {
  /** This Worker's assets: the two models. */
  ASSETS: Fetcher;
  /** Cloudflare Images: decodes any photo format and scales it down before Tesseract sees it. */
  IMAGES: ImagesBinding;
}

// A 12 MP phone photo scaled to 4 MP still reads a passport's MRZ verbatim, and keeps the decoded pixels (16 MB)
// and Tesseract's heap well inside the isolate's memory.
const MAX_PIXELS = 4_000_000;
// White around the image: Tesseract finds no lines in text cropped to its edges (an account number's crop).
const MARGIN = 32;

let turn: Promise<unknown> = Promise.resolve();

/**
 * What OCR read in an image: all of its text, for the checks and the MRZ parse, and its printed zone
 * (`printedZone`), for confirming what the MRZ says that no check digit covers.
 */
export interface Reading {
  readonly text: string;
  readonly printed: string;
}

export default class Ocr extends WorkerEntrypoint<Env> {
  /** What OCR reads in an image (JPEG, PNG, HEIC, WebP or AVIF), or `undefined` when it isn't one Images decodes. */
  read(image: Uint8Array): Promise<Reading | undefined> {
    const reading = turn.then(() => this.#read(image));
    turn = reading.catch(() => undefined);
    return reading;
  }

  async #read(image: Uint8Array): Promise<Reading | undefined> {
    const pixels = await this.#pixels(image);
    if (!pixels) return undefined;
    const lines = (ocr: OCREngine) =>
      ocr
        .getTextBoxes("line")
        .map((line) => ({ text: line.text.trim(), top: line.rect.top, bottom: line.rect.bottom }));
    const page = await this.#pass("eng", pixels, lines);
    // The MRZ model reads only what an MRZ prints: its lines with a filler are added for the checks and the parse.
    const mrz = (await this.#pass("mrz", pixels, lines)).filter((line) => line.text.includes("<"));
    return {
      text: [...page, ...mrz].map((line) => line.text).join("\n"),
      printed: printedZone(page, mrz),
    };
  }

  /**
   * One model over the image, in an engine of its own: one engine loading a second model keeps reading with the
   * first. Models are fetched for each pass rather than kept, since 15 MB of them held in JS would crowd the
   * isolate.
   */
  async #pass<T>(model: "eng" | "mrz", pixels: Pixels, read: (ocr: OCREngine) => T): Promise<T> {
    const response = await this.env.ASSETS.fetch(`https://ocr.assets/${model}.traineddata`);
    if (!response.ok) throw new Error(`${model}.traineddata: ${response.status}`);
    const ocr = await createOCREngine({ wasmModule });
    try {
      ocr.loadModel(await response.arrayBuffer());
      ocr.loadImage(pixels);
      return read(ocr);
    } finally {
      ocr.destroy();
    }
  }

  /**
   * The image as RGBA, scaled down to at most `MAX_PIXELS`. `undefined` when Images refuses the input (not an
   * image, a format or size it doesn't take), which then stays unread rather than retried: the same bytes fail the
   * same way. Any other failure (Images down, its quota spent) throws, so the job tries again later.
   */
  async #pixels(image: Uint8Array): Promise<Pixels | undefined> {
    if (!signed(image)) return undefined;
    let png: Uint8Array;
    try {
      const info = await this.env.IMAGES.info(stream(image));
      // An SVG has no size: its text is markup, not pixels, and stays unread.
      if (!("width" in info)) return undefined;
      const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (info.width * info.height)));
      const scaled = await this.env.IMAGES.input(stream(image))
        .transform({ width: Math.floor(info.width * scale), height: Math.floor(info.height * scale) })
        .output({ format: "image/png" });
      png = new Uint8Array(await scaled.response().arrayBuffer());
    } catch (error) {
      if (!refused(error)) throw error;
      return undefined;
    }
    return rgba(decode(png));
  }
}

const stream = (bytes: Uint8Array) => new Blob([bytes]).stream();

/** Whether bytes open as an image Images takes: JPEG, PNG, WebP, or an ISO media file (AVIF, HEIC). */
function signed(bytes: Uint8Array): boolean {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  return (
    (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    ascii(0, 8) === "\x89PNG\r\n\x1a\n" ||
    (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") ||
    ascii(4, 8) === "ftyp"
  );
}

/** What `loadImage` takes: the DOM's `ImageData`, which Workers don't have, by its shape. */
interface Pixels {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
  readonly colorSpace: "srgb";
}

/**
 * A decoded PNG as the opaque RGBA Tesseract takes, on a white margin: gray, RGB or a palette, 8 or 16 bits, with
 * what is transparent laid over white as a page shows it. Tesseract ignores alpha, so dark text on transparent
 * pixels (which are often black underneath) would read as a black block.
 */
function rgba(png: ReturnType<typeof decode>): Pixels | undefined {
  const { width, height, data, channels, depth, palette, transparency } = png;
  if (depth !== 8 && depth !== 16) return undefined;
  const stride = width + 2 * MARGIN;
  const out = new Uint8ClampedArray(stride * (height + 2 * MARGIN) * 4).fill(255);
  const shift = depth === 16 ? 8 : 0;
  const max = depth === 16 ? 0xffff : 0xff;
  const colors = palette ? 1 : channels >= 3 ? 3 : 1;
  const hasAlpha = !palette && (channels === 2 || channels === 4);
  for (let i = 0; i < width * height; i++) {
    const at = i * channels;
    const color = palette?.[data[at] ?? 0];
    const sample = (c: number) => data[at + (colors === 3 ? c : 0)] ?? 0;
    // A color key (tRNS on gray or RGB) makes pixels of exactly that color transparent.
    const keyed =
      !palette &&
      transparency !== undefined &&
      [0, 1, 2].slice(0, colors).every((c) => sample(c) === transparency[c]);
    const alpha = keyed
      ? 0
      : color
        ? (color[3] ?? 255) / 255
        : hasAlpha
          ? (data[at + channels - 1] ?? max) / max
          : 1;
    const to = ((Math.floor(i / width) + MARGIN) * stride + (i % width) + MARGIN) * 4;
    for (let c = 0; c < 3; c++) {
      const value = color ? (color[c] ?? 0) : sample(c) >> shift;
      out[to + c] = Math.round(value * alpha + 255 * (1 - alpha));
    }
  }
  return { width: stride, height: height + 2 * MARGIN, data: out, colorSpace: "srgb" };
}
