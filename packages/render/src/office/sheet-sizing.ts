// Copied from T3 Code (apps/web/src/components/files/office/sheet-sizing.ts), MIT License, Copyright (c) 2026 T3 Tools Inc. See packages/render/NOTICE.md.
// Excel's 255-character column width and 409.5-point row height, in the renderer's CSS pixels.
export const maximumTrackSize = { column: 255 * 7 + 5, row: (409.5 * 4) / 3 };
export const minimumTrackSize = 16;
