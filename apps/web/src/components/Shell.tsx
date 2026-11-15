import { Link } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";

import { notesOf, start, useRecord, type Status } from "../record.ts";
import { Files } from "./Files.tsx";
import { Tree } from "./Tree.tsx";

const STATUS: Record<Status, string> = {
  loading: "Loading",
  connecting: "Connecting",
  live: "Live",
  offline: "Offline: showing this device's copy",
  "signed-out": "Signed out",
};

/** The site's frame: a bar, the record's tree and files beside the open pane (a drawer on phones). */
export function Shell({
  noteId,
  fileId,
  children,
}: {
  readonly noteId?: string;
  readonly fileId?: string;
  readonly children: ReactNode;
}) {
  const { status, client, files } = useRecord();
  const [drawer, setDrawer] = useState(false);
  useEffect(() => void start(), []);
  if (status === "signed-out")
    return (
      <div className="empty">
        <p>Sign in to see your record.</p>
        <a href={`/sign-in?next=${encodeURIComponent(location.pathname)}`}>Sign in</a>
      </div>
    );
  return (
    <div className="app" data-drawer={drawer ? "open" : "closed"}>
      <header className="bar">
        <button
          type="button"
          className="drawer-toggle"
          aria-expanded={drawer}
          onClick={() => setDrawer(!drawer)}
        >
          {drawer ? "Close" : "Notes"}
        </button>
        <Link to="/" className="brand">
          Brainiac
        </Link>
        <span className="status" data-status={status}>
          {STATUS[status]}
        </span>
        <a href="/account" className="small">
          Account
        </a>
      </header>
      <aside className="side">
        <Tree notes={notesOf(client)} selected={noteId} onOpen={() => setDrawer(false)} />
        <Files files={files} selected={fileId} onOpen={() => setDrawer(false)} />
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
