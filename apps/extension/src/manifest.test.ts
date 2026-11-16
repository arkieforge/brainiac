// The site lets exactly one extension origin press Fill (EXTENSION_ORIGIN): the id Chrome derives from the public
// key in the manifest. A new key without the constant, or the other way round, would lock the extension out.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { EXTENSION_ORIGIN } from "@brainiac/core";
import { expect, it } from "vite-plus/test";

it("the manifest's key gives the extension the origin the site trusts", () => {
  const manifest: { key: string } = JSON.parse(
    readFileSync(new URL("../public/manifest.json", import.meta.url), "utf8"),
  );
  // Chrome's id: the key's SHA-256, first 16 bytes, each hex digit written as a letter from a to p.
  const hex = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32);
  const id = [...hex].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");
  expect(`chrome-extension://${id}`).toBe(EXTENSION_ORIGIN);
});
