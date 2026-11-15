/** A line OCR read, and where it lies on the image (pixels from the top). */
export interface Line {
  readonly text: string;
  readonly top: number;
  readonly bottom: number;
}

// A TD3 line is 44 characters, though the English pass may read a few more; two side by side, read across as one
// line, are about 88.
const ONE_MRZ = 66;
// Fewer than the checks count as an MRZ line: a long line below this is a stray.
const LONG = 28;

/**
 * A line with its spaces gone and guillemets read as fillers (`«` as `<<`, `‹` as `<`), as the checks read it: not
 * in a line that also closes one (`»`, `›`), which is quoting.
 */
const compact = (line: Line) => {
  const text = line.text.replaceAll(/\s/g, "");
  return /[\u00bb\u203a]/.test(text) ? text : text.replaceAll("\u2039", "<").replaceAll("\u00ab", "<<");
};

/**
 * A passport's printed zone, which alone may confirm what its MRZ says that no check digit covers: the English
 * pass's lines above where the MRZ starts, the first line of either pass with a filler pair however short. The MRZ
 * must not confirm itself, however OCR spelled, spaced or broke up its lines, so nothing is printed when the MRZ
 * isn't found, or when there may be two passports: either pass reading more MRZ lines from the start down than one
 * passport has, or one too wide for one MRZ. Which printed zone is whose is then unknown, and the parse may pair one
 * passport's top line with the other's bottom.
 */
export function printedZone(page: readonly Line[], mrz: readonly Line[]): string {
  const start = Math.min(
    ...[...page, ...mrz].filter((line) => compact(line).includes("<<")).map((line) => line.top),
  );
  if (!Number.isFinite(start)) return "";
  // An MRZ line: long, with a filler or a long run of MRZ characters (capitals and digits, and the `c` and `e` the
  // English pass reads fillers as), reaching below where the MRZ starts. Labels above it don't count, however
  // long, nor prose below it (a copy's certification, the facing page).
  const lines = (pass: readonly Line[]) =>
    pass.filter(
      (line) => line.bottom > start && compact(line).length >= LONG && /<|[A-Z0-9ce]{20}/.test(compact(line)),
    );
  for (const pass of [page, mrz]) {
    const found = lines(pass);
    if (found.length > 2 || found.some((line) => compact(line).length > ONE_MRZ)) return "";
  }
  return page
    .filter((line) => line.bottom <= start && !/[<\u00ab\u2039]/.test(line.text))
    .map((line) => line.text)
    .join("\n");
}
