import { history, undo } from "@codemirror/commands";
import { EditorState, type Transaction } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";

import { fromRecord, recordChange } from "./editing.ts";

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
