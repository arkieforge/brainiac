import { history, undo } from "@codemirror/commands";
import { EditorState, type Transaction } from "@codemirror/state";
import type { ClientMessage } from "@brainiac/core";
import { emptyState, SyncClient } from "@brainiac/sync";
import { describe, expect, it } from "vite-plus/test";

import { BodyDraft, fromRecord, recordChange, type SaveFrom } from "./editing.ts";
import { bodyOf, withBody, type Base } from "./fields.ts";

/** Runs a command against a state, as a keymap would, and returns the state it leads to. */
function run(state: EditorState, command: typeof undo): EditorState {
  let next = state;
  command({ state, dispatch: (tr: Transaction) => (next = tr.state) });
  return next;
}

describe("body editor", () => {
  it("undo takes back the person's typing, never another tab's edit", () => {
    let state = EditorState.create({ doc: "Line one.\n", extensions: [history()] });
    state = state.update({ changes: { from: state.doc.length, insert: "Mine.\n" } }).state;
    // Another tab added a line at the top while the person was typing below.
    const remote = recordChange(state, "From the other tab.\nLine one.\nMine.\n");
    if (!remote) throw new Error("expected a change");
    const applied = state.update(remote);
    expect(applied.annotation(fromRecord)).toBe(true);
    state = applied.state;
    state = run(state, undo);
    expect(state.doc.toString()).toBe("From the other tab.\nLine one.\n");
    // Nothing left to undo: the remote edit was never a step.
    expect(run(state, undo).doc.toString()).toBe("From the other tab.\nLine one.\n");
  });

  it("keeps the cursor where it was when a change lands before it", () => {
    let state = EditorState.create({ doc: "abc", selection: { anchor: 3 } });
    state = state.update(recordChange(state, "xxabc")!).state;
    expect(state.selection.main.head).toBe(5);
    expect(recordChange(state, "xxabc")).toBeUndefined();
  });
});

const ID = "01M6AGSCW0VCVQ4638KZVD05RK";
const PATH = "facts/roles/acme-intern-2025.md";
const R3 = `---\nid: ${ID}\ntype: Role\ntitle: Intern\n---\nLine one.\n`;
const THEIRS = withBody(R3, "Theirs on top.\nLine one.\n");

/** A tab holding the note at rev 3, and a way to deliver another tab's change to it as the record's push. */
function tab(cls: "normal" | "sensitive") {
  const sent: ClientMessage[] = [];
  const state = emptyState("tab");
  state.remote.set(ID, { rev: 3, path: PATH, raw: R3, class: cls });
  state.cursor = 10;
  const client = new SyncClient(state, {
    send: (message) => sent.push(message),
    newClientId: () => "tab-2",
    schemaVersion: 0,
    appVersion: "test",
  });
  client.receive({ type: "welcome", clientId: "tab", highWater: 0, ackedUpTo: 0 });
  const push = (raw: string) =>
    client.receive({
      type: "changes",
      from: 10,
      to: 11,
      items: [{ noteId: ID, seq: 11, deleted: false, rev: 4, path: PATH, raw, class: cls }],
    });
  return { client, sent, push };
}

/** The record's side of `POST /api/notes/<id>`: a put on a revision the note has moved past is a conflict. */
function record(start: Base) {
  const state = { note: start };
  const settled: (() => void)[] = [];
  const save: SaveFrom = async (_id, base, raw) => {
    if (base.rev !== state.note.rev) return { error: "This note changed since you started editing it." };
    state.note = { rev: state.note.rev + 1, raw };
    return state.note;
  };
  /** Resolves once the draft has handled a save's answer. */
  const answered = () => new Promise<void>((resolve) => settled.push(resolve));
  const changed = () => settled.splice(0).forEach((resolve) => resolve());
  return { state, save, answered, changed };
}

describe("body draft", () => {
  it("sends a normal note's typing on the text it was typed over, so another tab's edit is kept", () => {
    const { client, sent, push } = tab("normal");
    const draft = new BodyDraft(
      client,
      ID,
      async () => undefined,
      () => {},
    );
    draft.type("Line one.\nMine below.\n");
    push(THEIRS); // another tab's body change lands before this tab's typing went out
    const shown = draft.fromRecord();
    expect(sent.at(-1)).toMatchObject({ type: "mutate", change: { kind: "put", base: R3 } });
    expect(shown).toBe("Theirs on top.\nLine one.\nMine below.\n");
    expect(bodyOf(client.working(ID) ?? "")).toBe(shown);
  });

  it("sends a sensitive note's typing on its old revision, so a body changed elsewhere is a conflict, not lost", async () => {
    const { client, push } = tab("sensitive");
    const server = record({ rev: 3, raw: R3 });
    const draft = new BodyDraft(client, ID, server.save, server.changed);
    draft.type("Line one.\nMine below.\n");
    server.state.note = { rev: 4, raw: THEIRS }; // another tab saved first
    push(THEIRS);
    const answered = server.answered();
    expect(draft.fromRecord()).toBeUndefined(); // the person's text stays in the editor
    await answered;
    expect(server.state.note).toEqual({ rev: 4, raw: THEIRS });
    expect(draft.conflict).toMatch(/changed/);
    expect(draft.body).toBe("Line one.\nMine below.\n");
    // Taking the record's version shows the other tab's text.
    expect(draft.takeRecord()).toBe(bodyOf(THEIRS));
  });

  it("lets a sensitive note's typing through when only its front-matter moved meanwhile", async () => {
    const { client, push } = tab("sensitive");
    const server = record({ rev: 3, raw: R3 });
    const draft = new BodyDraft(client, ID, server.save, server.changed);
    draft.type("Line one.\nMine below.\n");
    const retitled = R3.replace("title: Intern", "title: Summer intern");
    server.state.note = { rev: 4, raw: retitled }; // a field edit, from this tab's form or another
    push(retitled);
    const answered = server.answered();
    draft.fromRecord();
    await answered;
    expect(draft.conflict).toBeUndefined();
    expect(server.state.note).toEqual({ rev: 5, raw: withBody(retitled, "Line one.\nMine below.\n") });
  });
});
