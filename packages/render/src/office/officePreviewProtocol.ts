// Adapted from T3 Code (apps/web/src/components/files/officePreviewProtocol.ts), MIT License, Copyright (c) 2026
// T3 Tools Inc. See packages/render/NOTICE.md.

export const OFFICE_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;
export const OFFICE_PREVIEW_MAX_ROWS = 250_000;
export const OFFICE_PREVIEW_MAX_COLUMNS = 1024;

/** The Office Open XML formats the viewer opens. */
export type OfficeKind = "docx" | "xlsx" | "pptx";

/** What a workbook's views ask of the preview that its engine does not read. */
export type WorkbookView = {
  /** The sheets, by index in workbook order, whose view hides gridlines. */
  readonly hiddenGridlines: readonly number[];
  /** The theme's heading and body fonts, which chart text names as `+mj-lt` and `+mn-lt`. */
  readonly themeFonts: { readonly major: string; readonly minor: string };
};

export type OfficeWorkerRequest = {
  readonly type: "open";
  readonly kind: OfficeKind;
  readonly bytes: ArrayBuffer;
};

export type OfficeWorkerResult =
  | { readonly type: "error"; readonly message: string }
  | {
      readonly type: OfficeKind;
      readonly bytes: ArrayBuffer;
      readonly truncated: boolean;
      /** For a workbook; undefined for other files. */
      readonly view: WorkbookView | undefined;
    };
