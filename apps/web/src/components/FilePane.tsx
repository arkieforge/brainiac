import { ImageViewer, MediaPlayer, SandboxedFrame, TableViewer } from "@brainiac/render";
import { lazy, Suspense, useEffect, useState } from "react";
import { Skeleton } from "skullet/react";

import { sign } from "../approve.ts";
import { api, refresh, useRecord, type FileItem } from "../record.ts";
import { ApproveButton } from "./Approval.tsx";
import { fileLabel } from "./Files.tsx";

const PdfViewer = lazy(() => import("@brainiac/render/pdf").then((m) => ({ default: m.PdfViewer })));
const OfficeViewer = lazy(() => import("@brainiac/render/office").then((m) => ({ default: m.OfficeViewer })));

/** The Office Open XML types the Office viewer draws. */
const OFFICE = new Map<string, "docx" | "xlsx" | "pptx">([
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"],
]);
const TABLES = new Map<string, "," | "\t">([
  ["text/csv", ","],
  ["text/tab-separated-values", "\t"],
]);

const KINDS = [
  "transcript",
  "test-report",
  "certificate",
  "letter",
  "cv",
  "photo",
  "passport",
  "national-id",
  "visa",
  "bank-statement",
];

/**
 * A passkey check, as the account page does it: Better Auth's passkey sign-in, which marks this session as having
 * proved a passkey for the next 10 minutes (apps/worker/src/auth/recovery.ts).
 */
async function checkPasskey() {
  const options = await (await api("/api/auth/passkey/generate-authenticate-options")).json();
  const credential = await navigator.credentials.get({
    publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options),
  });
  if (!(credential instanceof PublicKeyCredential)) throw new Error("No passkey answered.");
  const res = await api("/api/auth/passkey/verify-authentication", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ response: credential.toJSON() }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? "The passkey check failed.");
}

type Opened =
  | { readonly state: "loading" }
  | { readonly state: "locked" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "open"; readonly url: string };

/** A single-use link for this file on the usercontent origin, or why there isn't one. */
async function open(sha256: string): Promise<Opened> {
  const res = await api(`/api/files/${sha256}/token`, { method: "POST" });
  const body = await res.json().catch(() => ({}));
  if (res.ok) return { state: "open", url: body.url };
  if (body.needsPasskey) return { state: "locked" };
  return { state: "error", message: body.error ?? "This file can't be shown." };
}

/**
 * Stand-in for a file while it loads, in the shape its type will take: one block for pictures and video, a page of
 * text otherwise. Fictional, so Skullet never measures or remembers the file itself.
 */
function FileSample({ mime }: { readonly mime: string }) {
  if (mime.startsWith("image/") || mime.startsWith("video/"))
    return <div className="file-sample" skullet-block="" />;
  return (
    <div className="file-sample page">
      <h3>Transcript of records</h3>
      <p>
        This sample page holds the place of the file while it opens. It has a heading and a few lines of text,
        about as long as the first lines of a transcript, a letter or a certificate, so the page keeps its
        size when the real one arrives.
      </p>
      <p>Issued by the registrar, with grades for each term and the final result.</p>
    </div>
  );
}

/** The file's place while it opens, as still bars (Skullet, DESIGN.md). */
function FileLoading({ mime }: { readonly mime: string }) {
  return (
    <Skeleton loading label="Opening the file">
      <FileSample mime={mime} />
    </Skeleton>
  );
}

function Bytes({
  url,
  mime,
  children,
}: {
  readonly url: string;
  readonly mime: string;
  readonly children: (bytes: Uint8Array) => React.ReactNode;
}) {
  const [bytes, setBytes] = useState<Uint8Array>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    // Once: the link works a single time. No cookies go to the usercontent origin.
    fetch(url, { mode: "cors", credentials: "omit" })
      .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error("This file is gone."))))
      .then((buffer) => setBytes(new Uint8Array(buffer)))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "This file can't load."));
  }, [url]);
  if (error) return <p role="alert">{error}</p>;
  return bytes ? children(bytes) : <FileLoading mime={mime} />;
}

function Viewer({ file, url }: { readonly file: FileItem; readonly url: string }) {
  const mime = file.mime;
  if (mime === "application/pdf")
    return (
      <Bytes url={url} mime={mime}>
        {(bytes) => (
          <Suspense fallback={<FileLoading mime={mime} />}>
            <PdfViewer bytes={bytes} />
          </Suspense>
        )}
      </Bytes>
    );
  const office = OFFICE.get(mime);
  if (office)
    return (
      <Bytes url={url} mime={mime}>
        {(bytes) => (
          <Suspense fallback={<FileLoading mime={mime} />}>
            <OfficeViewer bytes={bytes} kind={office} />
          </Suspense>
        )}
      </Bytes>
    );
  const delimiter = TABLES.get(mime);
  if (delimiter)
    return (
      <Bytes url={url} mime={mime}>
        {(bytes) => <TableViewer bytes={bytes} delimiter={delimiter} name={fileLabel(file)} />}
      </Bytes>
    );
  if (mime.startsWith("audio/") || mime.startsWith("video/"))
    return (
      <Bytes url={url} mime={mime}>
        {(bytes) => <MediaPlayer bytes={bytes} mime={mime} label={fileLabel(file)} />}
      </Bytes>
    );
  if (mime === "text/html" || mime === "image/svg+xml")
    return <SandboxedFrame src={url} title={fileLabel(file)} />;
  if (mime.startsWith("image/")) return <ImageViewer src={url} alt={fileLabel(file)} />;
  if (mime.startsWith("text/"))
    return (
      <Bytes url={url} mime={mime}>
        {(bytes) => <pre className="value">{new TextDecoder().decode(bytes)}</pre>}
      </Bytes>
    );
  return <p className="muted">There is no viewer for {mime} files yet.</p>;
}

/** What the person says a file is. */
export function KindForm({ file }: { readonly file: FileItem }) {
  const [kind, setKind] = useState(file.kind ?? "");
  const [message, setMessage] = useState<string>();
  /** The kind change waiting for the person's passkey, and the challenge the record gave for it. */
  const [asked, setAsked] = useState<{ readonly kind: string; readonly challenge: string }>();
  const send = async (body: { readonly kind: string; readonly response?: unknown }) => {
    const res = await api(`/api/files/${file.sha256}/kind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => undefined);
    const answer = await res?.json().catch(() => ({}));
    await refresh();
    return { res, answer };
  };
  const save = async () => {
    setAsked(undefined);
    const { res, answer } = await send({ kind });
    if (res?.status === 409 && typeof answer?.challenge === "string")
      return setAsked({ kind, challenge: answer.challenge });
    setMessage(res?.ok ? undefined : (answer?.error ?? "That didn't save."));
  };
  const approve = async () => {
    if (!asked) return undefined;
    const signed = await sign(asked.challenge);
    if ("error" in signed) return signed;
    const { res, answer } = await send({ kind: asked.kind, response: signed.response });
    if (!res?.ok) return { error: answer?.error ?? "Your passkey's answer didn't check out." };
    setAsked(undefined);
    setMessage(undefined);
    return undefined;
  };
  return (
    <form
      className="fields"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label>
        What is this file?
        <input list="file-kinds" value={kind} onChange={(event) => setKind(event.currentTarget.value)} />
        <datalist id="file-kinds">
          {KINDS.map((k) => (
            <option key={k} value={k} />
          ))}
        </datalist>
      </label>
      <button type="submit" disabled={!kind}>
        {file.confirmed ? "Change kind" : "Confirm kind"}
      </button>
      {message && <p role="alert">{message}</p>}
      {asked && (
        <div className="approval" role="status">
          <p>
            You confirmed this file as {file.kind}. Changing it to {asked.kind} lets agents read more of it,
            so it needs your passkey.
          </p>
          <ApproveButton approve={approve} />
        </div>
      )}
    </form>
  );
}

/**
 * Whether the person's Claude may see this photo itself, to file it and fill in what it says. Turning that on hands
 * an unread photo to their agents, so it needs their passkey; turning it off never does.
 */
export function ShareForm({ file }: { readonly file: FileItem }) {
  const [message, setMessage] = useState<string>();
  const [challenge, setChallenge] = useState<string>();
  const send = async (body: { readonly on: boolean; readonly response?: unknown }) => {
    const res = await api(`/api/files/${file.sha256}/share`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => undefined);
    const answer = await res?.json().catch(() => ({}));
    await refresh();
    return { res, answer };
  };
  const toggle = async () => {
    setChallenge(undefined);
    const { res, answer } = await send({ on: !file.shared });
    if (res?.status === 409 && typeof answer?.challenge === "string") return setChallenge(answer.challenge);
    setMessage(res?.ok ? undefined : (answer?.error ?? "That didn't save."));
  };
  const approve = async () => {
    if (!challenge) return undefined;
    const signed = await sign(challenge);
    if ("error" in signed) return signed;
    const { res, answer } = await send({ on: true, response: signed.response });
    if (!res?.ok) return { error: answer?.error ?? "Your passkey's answer didn't check out." };
    setChallenge(undefined);
    setMessage(undefined);
    return undefined;
  };
  return (
    <div className="fields">
      <p className="small muted">
        {file.shared
          ? "Your Claude can see this photo, to file it and fill in what it shows."
          : "Your Claude can't see this photo. Let it, and it can file the photo and fill in what it shows."}
      </p>
      <button type="button" onClick={() => void toggle()}>
        {file.shared ? "Stop your Claude seeing it" : "Let your Claude see it"}
      </button>
      {message && <p role="alert">{message}</p>}
      {challenge && (
        <div className="approval" role="status">
          <p>
            This hands the photo itself to your agents, whatever it shows
            {file.class === "vault" ? ", and the checks found something secret in it" : ""}. It needs your
            passkey.
          </p>
          <ApproveButton approve={approve} />
        </div>
      )}
    </div>
  );
}

/** The file itself, once the record hands this page a link to it; an unclassified or vault one after a passkey check. */
export function FileView({ file }: { readonly file: FileItem }) {
  const [opened, setOpened] = useState<Opened>({ state: "loading" });
  const [checking, setChecking] = useState<string>();
  const { sha256, class: cls } = file;
  useEffect(() => {
    setOpened({ state: "loading" });
    let current = true;
    void open(sha256).then((result) => current && setOpened(result));
    return () => {
      current = false;
    };
  }, [sha256, cls]);
  const unlock = async () => {
    setChecking(undefined);
    try {
      await checkPasskey();
      setOpened(await open(sha256));
    } catch (cause) {
      setChecking(cause instanceof Error ? cause.message : "The passkey check failed.");
    }
  };
  return (
    <div className="file-view">
      {opened.state === "loading" && <FileLoading mime={file.mime} />}
      {opened.state === "error" && <p role="alert">{opened.message}</p>}
      {opened.state === "locked" && (
        <div className="locked">
          <p>
            {file.class === "vault" ? "This is a vault document." : "This file isn't classified yet."} Viewing
            the original needs a passkey check.
          </p>
          <button type="button" onClick={() => void unlock()}>
            Check with your passkey
          </button>
          {checking && <p role="alert">{checking}</p>}
        </div>
      )}
      {opened.state === "open" && <Viewer key={opened.url} file={file} url={opened.url} />}
    </div>
  );
}

/** What the checks made of a file and what agents may see of it. */
export function FileFacts({ file }: { readonly file: FileItem }) {
  return (
    <>
      <span className={`badge ${file.class}`}>{file.class}</span>
      <span className="badge">{file.mime}</span>
      <span className="badge">{(file.bytes / 1024).toFixed(1)} KB</span>
      <p className="small muted">
        {file.checks === "found"
          ? `The checks found ${file.findings.join(", ")} in it, so it stays in the vault: agents never see it.`
          : file.checks === "unreadable"
            ? "The checks can't read this kind of file yet, so it stays unclassified: agents see only that it exists."
            : file.confirmed
              ? "The checks found nothing secret, and you confirmed what it is."
              : "The checks found nothing secret. Confirm what it is to clear it."}
      </p>
    </>
  );
}

/** An upload from before files had sidecar notes: what the record knows about it, its kind, and the file. */
export function FilePane({ fileId }: { readonly fileId: string }) {
  const { files } = useRecord();
  const file = files.find((f) => f.sha256 === fileId);
  // The file list comes with the record; until then the whole pane is a sample.
  if (!file)
    return (
      <Skeleton loading label="Opening the file">
        <article>
          <header className="pane-head">
            <div className="path">{"0".repeat(64)}</div>
            <h1>transcript-of-records.pdf</h1>
            <span className="badge">application/pdf</span>
          </header>
          <div className="file-view">
            <FileSample mime="application/pdf" />
          </div>
        </article>
      </Skeleton>
    );
  return (
    <article>
      <header className="pane-head">
        <div className="path">{file.sha256}</div>
        <h1>{fileLabel(file)}</h1>
        <FileFacts file={file} />
      </header>
      <div className="note-grid">
        <FileView file={file} />
        <KindForm key={file.sha256} file={file} />
      </div>
    </article>
  );
}
