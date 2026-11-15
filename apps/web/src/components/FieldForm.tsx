import type { Manifest } from "@brainiac/core";
import type { SyncClient } from "@brainiac/sync";
import { useEffect, useRef, useState } from "react";

import { commitField, editField, inputOf, type Field } from "../fields.ts";
import { saveOnline } from "../record.ts";

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
  const editing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // A change from elsewhere shows at once, unless the person is typing in this field.
  useEffect(() => {
    if (!editing.current) setText(stored);
  }, [stored]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const commit = (input: string | boolean) => {
    clearTimeout(timer.current);
    editing.current = false;
    void commitField(client, noteId, manifest, field, input, saveOnline).then(setIssue);
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
  return (
    <label htmlFor={id}>
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
