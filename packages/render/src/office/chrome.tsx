// The small pieces of T3 Code's file surface chrome (apps/web/src/components/files/fileSurfaceChrome.tsx) the Office
// viewer uses, as plain elements styled by office.css. MIT License, Copyright (c) 2026 T3 Tools Inc. See
// packages/render/NOTICE.md.
import type { ReactNode } from "react";

/** An icon-sized button, labelled for screen readers and hover. */
export function Action(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled ?? false}
      onClick={props.onPress}
    >
      {props.children}
    </button>
  );
}

export function Notice(props: { readonly children: ReactNode }) {
  return (
    <div role="status" className="office-notice small">
      {props.children}
    </div>
  );
}

export function Loading() {
  return (
    <p role="status" className="muted">
      Loading
    </p>
  );
}
