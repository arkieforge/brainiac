import { parseNote, type Manifest } from "@brainiac/core";
import type { SyncClient } from "@brainiac/sync";
import { useEffect, useRef, useState } from "react";

import { commitField, editField, inputOf, type Approval, type Field, type SaveOnline } from "../fields.ts";
import { calm } from "../motion.ts";
import { saveOnline } from "../record.ts";
import { HeldEdit } from "./Approval.tsx";

/** How long typing pauses before a text field's edit is sent. */
const TYPING_MS = 400;

function FieldInput({
  field,
  client,
  noteId,
  manifest,
  disabled,
}: {
  /** A sensitive note while offline: shown, not editable. */
  readonly disabled: boolean;
  readonly field: Field;
  readonly client: SyncClient;
  readonly noteId: string;
  readonly manifest: Manifest | null;
}) {
  const stored = inputOf(field.value);
  const [text, setText] = useState(stored);
  const [issue, setIssue] = useState<string>();
  /** The last edit, held by the record for the person's passkey, with its place in `queue`. Component state only. */
  const [held, setHeld] = useState<{
    readonly approval: Approval;
    readonly save?: { readonly value: string };
  }>();
  const editing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const row = useRef<HTMLLabelElement>(null);
  const seen = useRef(stored);
  /**
   * The person's saves still on their way, in the order they were made, each with the value it will read back as
   * in stored form (a date, select or number can differ from what was typed). An arriving value that matches one is
   * their own change, and it retires that save and every earlier one (they were overtaken). Anything else is from
   * elsewhere. A save that fails, or turns out to change nothing, is taken out.
   */
  const queue = useRef<{ readonly value: string }[]>([]);
  const drop = (save: { readonly value: string }) => {
    queue.current = queue.current.filter((queued) => queued !== save);
  };
  // A change from elsewhere shows at once, unless the person is typing in this field, and rings the field once.
  useEffect(() => {
    // Bookkeeping runs even while the person types, so a later commit compares against what the record holds.
    const own = queue.current.findIndex((save) => save.value === stored);
    const elsewhere = stored !== seen.current && own === -1;
    if (own !== -1) queue.current = queue.current.slice(own + 1);
    seen.current = stored;
    if (editing.current) return;
    setText(stored);
    if (!elsewhere || calm()) return;
    row.current?.animate([{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 0 }], {
      duration: 1100,
      easing: "cubic-bezier(0.23, 1, 0.32, 1)",
      pseudoElement: "::after",
    });
  }, [stored]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const commit = (input: string | boolean) => {
    clearTimeout(timer.current);
    editing.current = false;
    const raw = client.working(noteId);
    const edited = raw === undefined ? undefined : editField(raw, manifest, field, input);
    const value = edited && "raw" in edited ? inputOf(parseNote(edited.raw).data[field.name]) : undefined;
    // Compared with the newest save still on its way, so A, then B, then back to A counts the last A.
    const save =
      value !== undefined && value !== (queue.current.at(-1)?.value ?? seen.current) ? { value } : undefined;
    if (save) queue.current = [...queue.current, save];
    // An online save that turns out to change nothing (the record already had it) resolves to undefined.
    let unchanged = false;
    let approval: Approval | undefined;
    const online: SaveOnline = (id, edit, base) =>
      saveOnline(id, edit, base).then((saved) => {
        unchanged = saved === undefined;
        approval = saved && "approval" in saved ? saved.approval : undefined;
        return saved;
      });
    setHeld(undefined);
    void commitField(client, noteId, manifest, field, input, online).then((problem) => {
      // A held edit stays queued: approved, it arrives as the person's own value.
      if (save && (unchanged || (problem && !approval))) drop(save);
      setIssue(approval ? undefined : problem);
      setHeld(approval && { approval, ...(save && { save }) });
    });
  };
  const typed = (input: string) => {
    editing.current = true;
    setText(input);
    const raw = client.working(noteId);
    const checked = raw === undefined ? undefined : editField(raw, manifest, field, input);
    const problem = checked && "issue" in checked ? checked.issue : undefined;
    setIssue(problem);
    clearTimeout(timer.current);
    // Invalid input is never sent; valid input goes once typing pauses.
    if (!problem) timer.current = setTimeout(() => commit(input), TYPING_MS);
  };

  const id = `field-${field.name}`;
  const { spec } = field;
  let control;
  if (!field.editable)
    control = (
      <div className="value" id={id}>
        {inputOf(field.value) || "(empty)"}
      </div>
    );
  else if (spec.values)
    control = (
      <select
        id={id}
        value={text}
        disabled={disabled}
        onChange={(event) => commit(event.currentTarget.value)}
      >
        {!spec.required && <option value="">(none)</option>}
        {!spec.values.includes(text) && text !== "" && <option value={text}>{text}</option>}
        {spec.values.map((value) => (
          <option key={value}>{value}</option>
        ))}
      </select>
    );
  else if (spec.kind === "boolean")
    control = (
      <input
        id={id}
        type="checkbox"
        disabled={disabled}
        checked={field.value === true}
        onChange={(event) => commit(event.currentTarget.checked)}
      />
    );
  else
    control = (
      <input
        id={id}
        type={spec.kind === "date" ? "date" : "text"}
        readOnly={disabled}
        inputMode={spec.kind === "number" ? "decimal" : undefined}
        value={text}
        aria-invalid={issue ? true : undefined}
        aria-describedby={issue ? `${id}-issue` : undefined}
        placeholder={spec.example === undefined ? undefined : String(spec.example)}
        onChange={(event) =>
          spec.kind === "date" ? commit(event.currentTarget.value) : typed(event.currentTarget.value)
        }
        onBlur={() => editing.current && !issue && commit(text)}
        onKeyDown={(event) => event.key === "Enter" && !issue && commit(text)}
      />
    );
  const release = () => {
    if (held?.save) drop(held.save);
    setHeld(undefined);
  };
  const label = (
    <label htmlFor={id} ref={row}>
      <span>
        {field.name}
        {spec.required ? " *" : ""}
      </span>
      {control}
      {issue && (
        <span className="error" id={`${id}-issue`} role="alert">
          {issue}
        </span>
      )}
    </label>
  );
  if (!held) return label;
  return (
    <>
      {label}
      <HeldEdit
        approval={held.approval}
        send={async (approvalId) => {
          const saved = await held.approval.resend(approvalId);
          if (saved && "error" in saved) return { error: saved.error };
          // Landed, its value retires the queued save when the push brings it; unchanged, nothing will.
          if (!saved) release();
          else setHeld(undefined);
          return undefined;
        }}
        keep={() => {
          release();
          setText(seen.current);
        }}
      />
    </>
  );
}

/** The note's fields, from its type's schema in the manifest (or its own keys when the type has none). */
export function FieldForm({
  fields,
  client,
  noteId,
  manifest,
  disabled,
}: {
  readonly disabled: boolean;
  readonly fields: readonly Field[];
  readonly client: SyncClient;
  readonly noteId: string;
  readonly manifest: Manifest | null;
}) {
  return (
    <section className="fields" aria-label="Fields">
      <h2>{manifest ? "Fields" : "Fields (no schema for this type yet)"}</h2>
      {fields.map((field) => (
        <FieldInput
          key={field.name}
          field={field}
          client={client}
          noteId={noteId}
          manifest={manifest}
          disabled={disabled}
        />
      ))}
    </section>
  );
}
