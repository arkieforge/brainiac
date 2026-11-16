// Drafts and packets as the person downloads them (docs/product/features/applications.md): a draft rendered to a
// PDF by the Typst Worker (apps/typst), and an application's packet as a zip, each file named the portal's way.
// Only the site's session routes (site.ts) call these, for the person. They answer as attachments, never as a page
// on the site's origin, though Typst escapes what a draft says and its PDFs carry no script.
import type { Rendering } from "@brainiac/base";

import { zip } from "./zip.ts";

/** The Typst Worker's RPC (apps/typst/src/index.ts). */
export interface Typst {
  pdf(source: string): Promise<{ readonly pdf: Uint8Array } | { readonly error: string }>;
}

const failed = (status: number, error: string) =>
  Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

const attachment = (bytes: Uint8Array, type: string, name: string) =>
  new Response(bytes, {
    headers: {
      "content-type": type,
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      "cache-control": "no-store",
    },
  });

/** A PDF of `source`, or why Typst refused it, which means a bug in `typstOf`: a draft's text is escaped. */
async function render(typst: Typst, source: string): Promise<Uint8Array | string> {
  const out = await typst.pdf(source);
  if ("error" in out) {
    console.error("typst refused a draft", out.error);
    return "Brainiac couldn't render this draft. It's a bug on our side, and it's logged.";
  }
  return out.pdf;
}

/** A saved draft as a PDF download. */
export async function draftDownload(
  rendering: Rendering | { readonly error: string },
  typst: Typst | undefined,
): Promise<Response> {
  if ("error" in rendering) return failed(409, rendering.error);
  if (!typst) return failed(503, "PDFs aren't set up on this stage.");
  const pdf = await render(typst, rendering.source);
  return typeof pdf === "string" ? failed(500, pdf) : attachment(pdf, "application/pdf", rendering.name);
}

/** A packet's files as the record hands them over: drafts as Typst source, stored files as their bytes. */
export type PacketParts = (
  | { readonly name: string; readonly source: string }
  | { readonly name: string; readonly bytes: Uint8Array }
)[];

/** What the record hands over for a packet, and what the person adds by hand. */
export type PacketFiles =
  | {
      readonly name: string;
      readonly parts: PacketParts;
      readonly missing: readonly { readonly name: string; readonly why: string }[];
    }
  | { readonly error: string };

/**
 * An application's packet as a zip, its files in the packet's order. What couldn't go in (a vault document, a
 * draft that doesn't pass verify) is listed in a MISSING.txt inside it, for the person to add by hand.
 */
export async function packetDownload(packet: PacketFiles, typst: Typst | undefined): Promise<Response> {
  if ("error" in packet) return failed(409, packet.error);
  if (!typst && packet.parts.some((part) => "source" in part))
    return failed(503, "PDFs aren't set up on this stage.");
  const files: { name: string; bytes: Uint8Array }[] = [];
  for (const part of packet.parts) {
    if ("bytes" in part) files.push({ name: part.name, bytes: part.bytes });
    else if (typst) {
      const pdf = await render(typst, part.source);
      if (typeof pdf === "string") return failed(500, pdf);
      files.push({ name: part.name, bytes: pdf });
    }
  }
  if (packet.missing.length > 0)
    files.push({
      name: "MISSING.txt",
      bytes: new TextEncoder().encode(
        `Add these yourself before you upload:\n${packet.missing.map((m) => `- ${m.name}: ${m.why}`).join("\n")}\n`,
      ),
    });
  return attachment(zip(files), "application/zip", packet.name);
}
