// A file's text by page, for the vault's checks and for search. Extraction is Workers AI `toMarkdown` for a PDF's
// text layer, in the jobs consumer, and OCR (apps/ocr) for photos and a PDF's JPEG images, whose text only the
// checks and the MRZ parse read; what they return, and whether it can be all the file says, is judged here.
import { inflateSync } from "node:zlib";

/**
 * Which extraction produced a file's checks. A file at a lower version is extracted again (`reindex`); bump it
 * when extraction reads more than it did (OCR for scans, say), so files it couldn't read get another look, and
 * when `pdfHidesText` or `needsReading` gets stricter, so files they cleared are judged again.
 */
export const PIPELINE = 2;

/** A MIME type without its parameters, lower case: `text/plain; charset=utf-8` is `text/plain`. */
export const mediaType = (mime: string) => mime.split(";")[0]?.trim().toLowerCase() ?? "";

/** Photos and scans OCR reads (through Cloudflare Images, which decodes each of these). */
const IMAGES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/avif",
]);

/**
 * Whether OCR reads a type: a photo or a scan. Its text goes to the checks and the MRZ parse, so what they find
 * keeps it in the vault, but it never counts as all the image says: OCR vouches only for text it can lay out, and
 * a tilted, faint or blurred corner beside it goes unseen. So a photo is never cleared by the checks.
 */
export const isImage = (mime: string) => IMAGES.has(mediaType(mime));

/** Whether a `file` job extracts a type's text: a PDF (its text layer, and OCR of its JPEGs) or a photo. */
export const extracts = (mime: string) => mediaType(mime) === "application/pdf" || isImage(mime);

/**
 * A PDF's pages from `toMarkdown`'s output (`## Contents`, then `### Page 1`, `### Page 2`, ...), or `undefined`
 * when it isn't in that shape, which the checks must treat as unread. A page that prints `### Page 3` itself
 * only moves text between pages, so every byte still reaches the checks.
 */
export function splitPages(markdown: string): string[] | undefined {
  const contents = markdown.indexOf("\n## Contents\n");
  if (contents === -1) return undefined;
  const pages: string[] = [];
  let rest = markdown.slice(contents + "\n## Contents\n".length);
  for (let n = 1; ; n++) {
    const marker = `### Page ${n}\n`;
    if (!rest.startsWith(marker)) return pages.length > 0 && rest.trim() === "" ? pages : undefined;
    rest = rest.slice(marker.length);
    const next = rest.indexOf(`\n### Page ${n + 1}\n`);
    pages.push(next === -1 ? rest : rest.slice(0, next));
    rest = next === -1 ? "" : rest.slice(next + 1);
  }
}

/**
 * Whether a page's text can't be trusted as all it says: garbled text (replacement characters, or mostly symbols),
 * or a table with no numbers in it. The checks never clear a file with such a page, since what they didn't read
 * may print a secret. A page with no text at all is blank unless something on it draws (a scan is an image, which
 * `pdfHidesText` finds), so it counts as read.
 */
export function needsReading(page: string): boolean {
  const ink = page.replaceAll(/\s+/g, "");
  if (ink.includes("\uFFFD")) return true;
  // Vowel signs and viramas (Bangla, Hindi) and Arabic's vowel marks are part of words; an empty page has none.
  const words = ink.match(/[\p{L}\p{M}\p{N}]/gu)?.length ?? 0;
  if (ink.length > 0 && words / ink.length < 0.5) return true;
  const table = page.split("\n").filter((line) => line.trimStart().startsWith("|"));
  return table.length >= 2 && !table.some((line) => /\p{N}/u.test(line));
}

// What a PDF's names may say without letting it pass: a `/Subtype` outside these (an image, a Type3 font, any
// annotation but a link or its popup) can show text the text layer doesn't hold.
const SHOWN = new Set([
  "Link",
  "Popup",
  "Form",
  "XML",
  "Type1",
  "MMType1",
  "TrueType",
  "Type0",
  "CIDFontType0",
  "CIDFontType2",
  "Type1C",
  "CIDFontType0C",
  "OpenType",
]);
// Attached files, forms, appearance streams, encryption, and every filter but Flate: a stream under one of those
// can't be opened here. A filter is always named somewhere in the file or in one of its streams.
const HIDING = new Set([
  "EmbeddedFile",
  "EmbeddedFiles",
  "AcroForm",
  "AP",
  "Encrypt",
  "Crypt",
  "LZWDecode",
  "LZW",
  "RunLengthDecode",
  "RL",
  "ASCII85Decode",
  "A85",
  "ASCIIHexDecode",
  "AHx",
  "DCTDecode",
  "DCT",
  "JPXDecode",
  "JBIG2Decode",
  "CCITTFaxDecode",
  "CCF",
]);
// What all of a PDF's streams may inflate to, together, before it counts as hiding text: well under the Worker's
// memory, since each inflated stream is held as bytes and as text while it is judged.
const INFLATED_MAX = 16 * 1024 * 1024;

// Latin-1 keeps one character per byte, so offsets in the text are offsets in the bytes. No copy of the bytes.
const latin1 = (data: Uint8Array) =>
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("latin1");

/** `#xx` in a name is the byte it escapes: `/Im#61ge` is `/Image`. */
const unescaped = (text: string) =>
  text.includes("#")
    ? text.replaceAll(/#([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    : text;

// PDF's own whitespace and delimiters: they end a token (NUL is whitespace there, unlike `\s`).
const TOKEN_EDGE = "[\\x00\\t\\n\\f\\r ()<>[\\]{}/%]";
// An inline image: the `BI` operator, then `ID` anywhere after it. Readers split `8BI` and `8ID` after the number
// and take `ID` straight before the image data, so only a letter before either keeps it a word, and only a
// regular character after `BI`. Matched without backtracking, so no file is slow to check.
const BI = new RegExp(`(?<![A-Za-z])BI(?=$|${TOKEN_EDGE})`);
const ID = /(?<![A-Za-z])ID/;
// A name runs to the next whitespace or delimiter; a subtype's value is the name after it, if one is.
const NAME = new RegExp(`/((?:(?!${TOKEN_EDGE}).)+)`, "gs");
const SUBTYPE = new RegExp(
  `/Subtype(?=$|${TOKEN_EDGE})[\\x00\\t\\n\\f\\r ]*(?:/((?:(?!${TOKEN_EDGE}).)+))?`,
  "gs",
);

const inlineImage = (text: string) => {
  const at = BI.exec(text)?.index;
  return at !== undefined && ID.test(text.slice(at + 2));
};

/** What `lex` makes of PDF text: its syntax, with what a page prints blanked out, and where its streams are. */
interface Lexed {
  /** Literal strings, hex strings and comments blanked out, and stream data left out. */
  readonly syntax: string;
  /** Each stream's data, as offsets into the text, and where its `stream` keyword is. */
  readonly streams: readonly (readonly [start: number, end: number, keyword: number])[];
  /** `%%EOF` markers: one per revision (two in a linearized file). */
  readonly eofs: number;
  /**
   * A stream it can't account for: a `stream` keyword whose data can't be found (no line break after it, or no
   * `endstream`), or an `endstream` that closed no stream it found, as when a string a writer left unclosed (a
   * Windows path's last backslash escaping its parenthesis) runs on over the streams after it.
   */
  readonly lost: boolean;
  /**
   * A string still open at the end of the text, which a valid PDF never is: it ran on over whatever came after it
   * (a form field's dictionary, say), so that was never read.
   */
  readonly unclosed: boolean;
}

/**
 * Reads PDF text the way a reader tokenizes it, in one pass: strings (nesting and backslash escapes honored), hex
 * strings and comments are skipped, so the words a page prints (`SAT/AP`, `Data stream processing`) are never
 * taken for names, operators or stream keywords. With `streams`, a `stream` keyword's data is skipped to its
 * `endstream` and recorded.
 */
function lex(text: string, streams: boolean): Lexed {
  const parts: string[] = [];
  const found: [number, number, number][] = [];
  let eofs = 0;
  let from = 0;
  let unclosed = false;
  const skip = (i: number, end: number) => {
    parts.push(text.slice(from, i), " ");
    from = end;
    return end - 1;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "%") {
      if (text.startsWith("%%EOF", i)) eofs++;
      let end = i;
      while (end < text.length && text[end] !== "\n" && text[end] !== "\r") end++;
      i = skip(i, end);
    } else if (c === "<" && text[i + 1] === "<") {
      i++;
    } else if (c === "<") {
      const close = text.indexOf(">", i);
      if (close === -1) unclosed = true;
      i = skip(i, close === -1 ? text.length : close + 1);
    } else if (c === "(") {
      let depth = 0;
      let at = i;
      for (; at < text.length; at++) {
        const d = text[at];
        if (d === "\\") at++;
        else if (d === "(") depth++;
        else if (d === ")" && --depth === 0) break;
      }
      if (at >= text.length) unclosed = true;
      i = skip(i, Math.min(at + 1, text.length));
    } else if (streams && c === "s" && text.startsWith("stream", i) && !/[A-Za-z]/.test(text[i - 1] ?? "")) {
      const after = text.slice(i + 6, i + 8);
      if (/^[A-Za-z]/.test(after)) continue;
      // The keyword's line break is required; a bare CR or anything else leaves where its data starts unknown.
      const eol = after.startsWith("\r\n") ? 2 : after.startsWith("\n") ? 1 : 0;
      const start = i + 6 + eol;
      const end = eol === 0 ? -1 : text.indexOf("endstream", start);
      if (end === -1) return { syntax: "", streams: found, eofs, lost: true, unclosed };
      found.push([start, end, i]);
      i = skip(i, end + "endstream".length);
    }
  }
  parts.push(text.slice(from));
  const lost = streams && (unclosed || text.split("endstream").length - 1 !== found.length);
  return { syntax: parts.join(""), streams: found, eofs, lost, unclosed };
}

// Text a stream may hold as it is: valid UTF-8 (an XMP packet opens with a byte order mark) with no control
// characters but line breaks and tabs. Raw pixels or a compressed font almost never are.
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
function isText(data: Uint8Array): boolean {
  let text: string;
  try {
    text = UTF8.decode(data);
  } catch {
    return false;
  }
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // Tab, line feed, form feed and carriage return are text; other C0 controls and DEL aren't.
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0c && code !== 0x0d) || code === 0x7f)
      return false;
  }
  return true;
}

/** An XMP metadata packet: XML, not PDF syntax, which draws nothing, so its words (`SAT/AP`) are only words. */
const isXmp = (text: string) => /^(?:\uFEFF|\xEF\xBB\xBF)?\s*<(?:\?xpacket|\?xml|x:xmpmeta)\b/.test(text);

/** Whether a stream's text, read as PDF, leaves a string open or names anything that hides text. */
const opens = (text: string) => lex(text, false).unclosed || names(text);

/** Whether text from a PDF names anything in `HIDING`, a `/Subtype` outside `SHOWN`, or an inline image. */
function names(text: string): boolean {
  const plain = unescaped(lex(text, false).syntax);
  if (inlineImage(plain)) return true;
  for (const [, name = ""] of plain.matchAll(NAME)) if (HIDING.has(name)) return true;
  // A subtype that isn't a plain name (a comment or a reference in its place) isn't one of `SHOWN` either.
  for (const [, subtype = ""] of plain.matchAll(SUBTYPE)) if (!SHOWN.has(subtype)) return true;
  return false;
}

/**
 * Whether a PDF may show text its text layer doesn't hold, so `toMarkdown`'s output can't be all of it: an image
 * (an XObject or inline), an attached file, form fields, an annotation other than a link, a Type3 font, or a
 * stream it can't open. No dictionary is trusted to say what a stream holds: every stream is inflated if it can
 * be and its contents judged in turn (object streams hold dictionaries too), and one that neither inflates nor is
 * plain text counts as hiding text. It errs toward true: a transcript with its university's logo stays
 * unclassified, which is safe.
 *
 * What it guards against is ordinary software output: a scan, a photo or a filled form inside an otherwise text
 * PDF. A file crafted to slip past it can only hide what its maker already knew, so it stops at what writers do
 * and doesn't decode everything a reader could: a predictor (writers put one on xref streams and images) is left
 * encoded.
 * shortcut: text drawn as vector outlines, and XMP metadata, aren't read.
 */
export function pdfHidesText(bytes: Uint8Array): boolean {
  let budget = INFLATED_MAX;
  /** Whether stream data, at most `depth` inflations deep, hides anything. */
  const hides = (data: Uint8Array, depth: number): boolean => {
    let inflated: Uint8Array;
    try {
      inflated = inflateSync(data, { maxOutputLength: budget + 1 });
    } catch (error) {
      if (error instanceof RangeError) return true;
      // Not deflate: plain text is judged as it is; anything else is something it can't open.
      if (!isText(data)) return true;
      const raw = latin1(data);
      return !isXmp(raw) && opens(raw);
    }
    budget -= inflated.byteLength;
    if (budget < 0 || depth === 0) return true;
    const text = latin1(inflated);
    // A content or object stream that is UTF-8 text, left with a string open, may hide what follows it. Binary data
    // (a font) is full of unmatched parentheses and is judged by names; XMP is XML text, which draws nothing.
    if (isText(inflated) ? !isXmp(text) && opens(text) : names(text)) return true;
    // Only deflate again is opened; anything else (a font, an xref table) was judged by its names.
    try {
      inflateSync(inflated, { maxOutputLength: 1 });
    } catch (error) {
      if (!(error instanceof RangeError)) return false;
    }
    return hides(inflated, depth - 1);
  };
  // The text outside streams holds the dictionaries, judged first: an image XObject is found there with nothing
  // inflated. Then each stream's data is judged by what it holds.
  const { syntax, streams, eofs, lost } = lex(latin1(bytes), true);
  if (lost || names(syntax)) return true;
  // An incremental save keeps what it replaced, which `toMarkdown` doesn't read: one revision only, or two in a
  // linearized file, whose first object says so and which writes its first page's cross-reference separately.
  const first = /\d+\s+\d+\s+obj\s*<<([\s\S]*?)>>/.exec(syntax)?.[1] ?? "";
  if (eofs > (/\/Linearized\b/.test(unescaped(first)) ? 2 : 1)) return true;
  return streams.some(([start, end]) => hides(bytes.subarray(start, end), 3));
}

// A passport's page, an ID card's two sides: more than a few JPEGs would hold a batch's other jobs behind OCR (one
// at a time, a second or more each), and only the first are read.
const MAX_JPEGS = 4;

/**
 * The JPEG images a PDF holds (a scan's pages, a photo), for OCR to look for what the checks find: a passport's
 * MRZ, an account number. Only finding: a PDF with any image stays unread whatever OCR makes of it
 * (`pdfHidesText`), so this needn't account for every image, only hand over what it easily can.
 */
export function pdfJpegs(bytes: Uint8Array): Uint8Array[] {
  const raw = latin1(bytes);
  const jpegs: Uint8Array[] = [];
  for (const [start, end, keyword] of lex(raw, true).streams) {
    const object = raw.lastIndexOf("obj", keyword);
    const dictionary = object === -1 ? "" : unescaped(lex(raw.slice(object + 3, keyword), false).syntax);
    if (!/\/Filter\s*(?:\/DCTDecode|\[\s*\/DCTDecode\s*\])/.test(dictionary)) continue;
    // Without the line break a writer puts before `endstream`.
    let last = end;
    if (last > start && bytes[last - 1] === 0x0a) last--;
    if (last > start && bytes[last - 1] === 0x0d) last--;
    // A copy, not a view (a Buffer's `slice` is one too): RPC sends a view's whole buffer, which is the whole PDF.
    jpegs.push(new Uint8Array(bytes.subarray(start, last)));
    if (jpegs.length === MAX_JPEGS) break;
  }
  return jpegs;
}
