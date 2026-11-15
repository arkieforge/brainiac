import { describe, expect, it } from "vite-plus/test";

import { refused } from "../src/refused.ts";

const images = (code: number) => Object.assign(new Error(`ERROR ${code}`), { code });

describe("refused", () => {
  it("leaves unread only what the input itself caused", () => {
    for (const code of [9412, 9413, 9520, 9523]) expect(refused(images(code)), String(code)).toBe(true);
    // The account's quota, a binding set up wrong, a dropped connection: a later try may read it.
    for (const code of [9422, 9432, 9402, 9424]) expect(refused(images(code)), String(code)).toBe(false);
    expect(refused(new Error("ERROR 9520: Unsupported image type"))).toBe(true);
    expect(refused(new Error("fetch failed"))).toBe(false);
  });
});
