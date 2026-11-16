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
  const push = (raw: string, rev = 4) =>
    client.receive({
      type: "changes",
      from: 10,
      to: 11,
      items: [{ noteId: ID, seq: 11, deleted: false, rev, path: PATH, raw, class: cls }],
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

  it("catches up with a push that came while a sensitive save was on its way, whichever arrived first", async () => {
    const { client, push } = tab("sensitive");
    const answer = Promise.withResolvers<Base>();
    const shown: (string | undefined)[] = [];
    const settled = Promise.withResolvers<void>();
    const draft = new BodyDraft(
      client,
      ID,
      () => answer.promise,
      (body) => {
        shown.push(body);
        settled.resolve();
      },
    );
    const mine = withBody(R3, "Line one.\nMine below.\n");
    draft.type(bodyOf(mine));
    draft.flush(); // the save is on its way and will land as rev 4
    // Another tab edits on top of it (rev 5), and that push reaches this tab before the save's own answer.
    const rev5 = withBody(mine, "Theirs on top.\nLine one.\nMine below.\n");
    push(rev5, 5);
    expect(draft.fromRecord()).toBeUndefined(); // held back while the save is on its way
    answer.resolve({ rev: 4, raw: mine });
    await settled.promise;
    expect(shown).toEqual([bodyOf(rev5)]);
    expect(draft.body).toBe(bodyOf(rev5));
  });

  it("holds a sensitive save the record wants a passkey for, and sends the same text on the same base once approved", async () => {
    const { client } = tab("sensitive");
    const server = record({ rev: 3, raw: R3 });
    const resent: { approvalId: string; base: Base; raw: string }[] = [];
    const sends: Base[] = [];
    // The record holds every send for approval; a resend cites the approval and lands.
    const save: SaveFrom = async (id, base, raw) => (
      sends.push(base),
      {
        error: "This change needs your passkey approval.",
        approval: {
          planHash: "hash",
          items: [],
          resend: async (approvalId) => {
            resent.push({ approvalId, base, raw });
            return server.save(id, base, raw);
          },
        },
      }
    );
    const draft = new BodyDraft(client, ID, save, server.changed);
    draft.type("Line one.\nMine below.\n");
    const held = server.answered();
    draft.flush();
    await held;
    expect(draft.approval?.planHash).toBe("hash");
    expect(server.state.note.rev).toBe(3);
    draft.type("Line one.\nMine below.\nAnd more.\n"); // typed while the plan waits: not sent under it
    const landed = server.answered();
    await draft.approved("ap-1");
    await landed;
    const mine = withBody(R3, "Line one.\nMine below.\n");
    expect(resent).toEqual([{ approvalId: "ap-1", base: { rev: 3, raw: R3 }, raw: mine }]);
    expect(server.state.note).toEqual({ rev: 4, raw: mine });
    // The later typing follows on what the approved save wrote, as an edit of its own with its own plan.
    expect(sends).toEqual([
      { rev: 3, raw: R3 },
      { rev: 4, raw: mine },
    ]);
    expect(draft.body).toBe("Line one.\nMine below.\nAnd more.\n");
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
