// A zip of a packet's files (docs/product/features/applications.md, "Packets"). Stored, not deflated: the files
// are PDFs, already compressed, and a portal only needs them named its way.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const crc32 = (bytes: Uint8Array) => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

/** `files` as one zip, each under its name (UTF-8), in order. */
export function zip(files: readonly { readonly name: string; readonly bytes: Uint8Array }[]): Uint8Array {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const { name, bytes } of files) {
    const path = new TextEncoder().encode(name);
    const crc = crc32(bytes);
    // Version 2.0, general purpose bit 11 (the name is UTF-8), stored, no time.
    const fields = (view: DataView, at: number) => {
      view.setUint16(at, 20, true);
      view.setUint16(at + 2, 0x0800, true);
      view.setUint16(at + 4, 0, true);
      view.setUint32(at + 6, 0, true);
      view.setUint32(at + 10, crc, true);
      view.setUint32(at + 14, bytes.length, true);
      view.setUint32(at + 18, bytes.length, true);
      view.setUint16(at + 22, path.length, true);
    };
    const head = new Uint8Array(30 + path.length);
    const headView = new DataView(head.buffer);
    headView.setUint32(0, 0x04034b50, true);
    fields(headView, 4);
    head.set(path, 30);
    const entry = new Uint8Array(46 + path.length);
    const entryView = new DataView(entry.buffer);
    entryView.setUint32(0, 0x02014b50, true);
    entryView.setUint16(4, 20, true);
    fields(entryView, 6);
    entryView.setUint32(42, offset, true);
    entry.set(path, 46);
    local.push(head, bytes);
    central.push(entry);
    offset += head.length + bytes.length;
  }
  const size = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, size, true);
  endView.setUint32(16, offset, true);
  const out = new Uint8Array(offset + size + end.length);
  let at = 0;
  for (const part of [...local, ...central, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
