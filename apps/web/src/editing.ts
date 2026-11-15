// How a change from the record reaches the body editor: one minimal edit, so the cursor and anything typed but not
// yet sent map through it, kept out of undo history, so Ctrl+Z undoes only the person's own typing and never sends
// another tab's edit back as a revert.
import { Annotation, Transaction, type EditorState, type TransactionSpec } from "@codemirror/state";

/** Marks a change that came from the record, so it isn't sent back as the person's edit. */
export const fromRecord = Annotation.define<boolean>();

/** The smallest one-range change from `before` to `after`. */
function change(before: string, after: string) {
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from++;
  let end = 0;
  while (
    end < before.length - from &&
    end < after.length - from &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end++;
  return { from, to: before.length - end, insert: after.slice(from, after.length - end) };
}

/** The transaction that brings the editor to the record's `body`, or undefined when it already shows it. */
export function recordChange(state: EditorState, body: string): TransactionSpec | undefined {
  const before = state.doc.toString();
  if (before === body) return undefined;
  return {
    changes: change(before, body),
    annotations: [fromRecord.of(true), Transaction.addToHistory.of(false)],
  };
}
