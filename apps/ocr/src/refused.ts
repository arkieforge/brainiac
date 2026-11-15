// Cloudflare Images' error codes (https://developers.cloudflare.com/images/reference/troubleshooting/), sorted into
// the input's own faults, which the same bytes always hit, and everything else (its quota, a binding set up wrong,
// an outage), which a later try may not.
const INPUT = new Set([
  // Not an image.
  9412,
  // Over 100 megapixels.
  9413,
  // A format it doesn't take.
  9520,
  // Bytes it couldn't decode: the OCR Worker has already checked they open as an image, so they're corrupt.
  9523,
]);

/** Whether Images refused the input itself, by its error's code or, from the local binding, the code in its message. */
export function refused(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code =
    "code" in error && typeof error.code === "number"
      ? error.code
      : Number(/\b(9\d{3})\b/.exec(error.message)?.[1]);
  return INPUT.has(code);
}
