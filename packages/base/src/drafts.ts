// Drafts as the person takes them away (docs/product/features/applications.md, "CV and resume" and "Packets"): a
// saved Draft as Typst source for the Typst Worker, and the files an application's portal takes, each under the
// name it wants. Only the site's routes call these, for the person: an agent writes and checks a draft with the
// `draft` tool (tools.ts) and never gets a PDF or a packet.
import { splitNote, typstOf } from "@brainiac/core";

import { relationTarget } from "./approvals.ts";
import { getNote, type NoteRow } from "./notes.ts";
import type { Sql } from "./sql.ts";
import { checkDraft } from "./tools.ts";
import { fileOf, type FileRow } from "./vault.ts";

const PERSON_CTX = (now: number) => ({ actor: "human", now });

/** A draft ready to render: its Typst source and the file name it downloads under. */
export interface Rendering {
  readonly name: string;
  readonly source: string;
}

const fileName = (title: string) =>
  `${title.replaceAll(/[^\p{L}\p{N}]+/gu, "_").replaceAll(/^_+|_+$/g, "") || "draft"}.pdf`;

/** Why a draft can't be rendered, or its rendering: only one whose every claim matches the record now. */
function renderingOf(sql: Sql, note: NoteRow, now: number): Rendering | { readonly error: string } {
  const checked = checkDraft(sql, PERSON_CTX(now), note);
  const status =
    checked.ok && typeof checked.value === "object" && checked.value !== null && "status" in checked.value
      ? checked.value.status
      : undefined;
  if (status !== "ok")
    return { error: `${note.path} doesn't pass verify: ask your Claude to check it with draft {verify}.` };
  const title = note.title ?? note.path;
  return { name: fileName(title), source: typstOf(title, splitNote(note.raw).body) };
}

/** The live Draft `id` as the person renders it. */
export function draftRendering(sql: Sql, id: string, now: number): Rendering | { readonly error: string } {
  const note = getNote(sql, id);
  if (!note || note.deletedAt !== null || note.type !== "Draft") return { error: "No such draft." };
  return renderingOf(sql, note, now);
}

/** One file of a packet: a draft to render, or a stored file. */
export type PacketPart =
  | ({ readonly kind: "draft" } & Rendering)
  | { readonly kind: "file"; readonly name: string; readonly file: FileRow };

/** An application's packet: what goes in the zip, and what the person adds by hand, with why. */
export interface Packet {
  readonly name: string;
  readonly parts: readonly PacketPart[];
  readonly missing: readonly { readonly name: string; readonly why: string }[];
}

/**
 * The most stored file bytes one packet carries: the zip is built in memory, and the record and the Worker each
 * hold a copy, inside an isolate's 128 MB. Past it, a file is left for the person to add.
 * shortcut: a portal that wants more than this in one upload needs the zip streamed.
 */
export const PACKET_BYTES = 30 * 1024 * 1024;

const isMapping = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * What application `id`'s `packet` lists, in its order: each Draft rendered (once it passes verify) and each
 * Document's file, under the name the portal wants. A file still unclassified or in the vault never leaves in a
 * zip: the person opens it on the site with their passkey and adds it themselves.
 */
export function packetOf(sql: Sql, id: string, now: number): Packet | { readonly error: string } {
  const application = getNote(sql, id);
  if (!application || application.deletedAt !== null || application.type !== "Application")
    return { error: "No such application." };
  const items = [JSON.parse(application.fm)["packet"] ?? []].flat();
  if (items.length === 0)
    return { error: `${application.path} has no packet yet: list its files in packet.` };
  const parts: PacketPart[] = [];
  const missing: { name: string; why: string }[] = [];
  const names = new Set<string>();
  let bytes = 0;
  for (const item of items) {
    const name = isMapping(item) && typeof item["name"] === "string" ? item["name"].trim() : "";
    const label = name || "(no name)";
    const note = isMapping(item) ? relationTarget(sql, application, item["item"]) : undefined;
    // A zip can't hold two files of one name, and a name with a path in it would land outside the folder.
    if (!/^[^/\\]+\.[A-Za-z0-9]+$/.test(name) || names.has(name.toLowerCase()))
      missing.push({ name: label, why: "needs a file name of its own, like Karim_Nadia_CV.pdf" });
    else if (!note) missing.push({ name, why: "names no note in the record" });
    else if (note.type === "Draft") {
      const rendering = renderingOf(sql, note, now);
      if ("error" in rendering) missing.push({ name, why: rendering.error });
      else parts.push({ kind: "draft", name, source: rendering.source });
    } else {
      const file = fileOf(sql, note);
      if (!file) missing.push({ name, why: `${note.path} has no stored file` });
      else if (file.class === "unclassified" || file.class === "vault")
        missing.push({
          name,
          why: `${note.path} opens only with your passkey: download it from the site and add it`,
        });
      else if (bytes + file.bytes > PACKET_BYTES)
        missing.push({
          name,
          why: `${note.path} doesn't fit in one zip with the rest: download it from the site`,
        });
      else {
        bytes += file.bytes;
        parts.push({ kind: "file", name, file });
      }
    }
    names.add(name.toLowerCase());
  }
  return { name: fileName(application.title ?? "packet").replace(/\.pdf$/, ".zip"), parts, missing };
}
