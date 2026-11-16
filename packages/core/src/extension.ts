// The browser extension (apps/extension) as the site knows it. Its id is fixed by the public key in its
// manifest, so the one origin besides the site's own that may POST to the site is known ahead of time.

/** The extension's origin: what Chrome sends as `Origin` on the extension's own requests. */
export const EXTENSION_ORIGIN = "chrome-extension://niijgpfhnkhiighhbojkmndcklcjppbi";
