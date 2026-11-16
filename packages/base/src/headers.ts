// Its own entry point with no imports, so `brainiac mcp serve` can name it without loading the record's code.

/** Sent as `1` by `brainiac mcp serve --background`, the bridge the daemon's headless filer runs. */
export const BACKGROUND_HEADER = "brainiac-background";
