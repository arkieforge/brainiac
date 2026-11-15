// Copied from T3 Code (apps/web/src/components/files/office/slide-protocol.ts), MIT License, Copyright (c) 2026 T3 Tools Inc. See packages/render/NOTICE.md.
// Adapted from opencode (MIT). Copyright (c) 2025 opencode. See packages/render/LICENSE-opencode.
import type { VectorBitmap, VectorRequest } from "./vector-pictures.ts";
import type { Method } from "./worker-rpc.ts";

/** What the window shows of one slide besides its bitmap. */
export type SlideSummary = {
  /** In CSS pixels. */
  readonly width: number;
  readonly height: number;
  readonly hidden: boolean;
  readonly notes: string | undefined;
};

export type SlidePainted =
  | {
      readonly kind: "painted";
      /** The slide at the requested density, or less when that would exceed the bitmap caps. */
      readonly bitmap: ImageBitmap;
      /** SVG pictures the slide drew without, or too coarse: paint again once the worker has them. */
      readonly vectors: readonly VectorRequest[];
    }
  /** The slide does not lay out, or does not paint even without shadows. */
  | { readonly kind: "failed" }
  /** The caller aborted the paint while it ran. */
  | { readonly kind: "cancelled" };

/** The PowerPoint worker's methods. */
export type SlideMethods = {
  /** Opens the deck once per worker, its fonts included. Rejects when the engine cannot read it. */
  readonly open: Method<{ readonly bytes: ArrayBuffer }, readonly SlideSummary[]>;
  /** Paints one slide at `density` device pixels per CSS pixel. */
  readonly paint: Method<{ readonly index: number; readonly density: number }, SlidePainted>;
  /** Hands over SVG pictures rasterized for `VectorRequest`s. */
  readonly vectors: Method<readonly VectorBitmap[], void>;
};
