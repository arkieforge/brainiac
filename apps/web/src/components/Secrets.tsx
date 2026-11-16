import { useCallback, useEffect, useId, useState } from "react";

import { sign } from "../approve.ts";
import {
  forgetSecret,
  listSecrets,
  POLICIES,
  saveSecret,
  type Policy,
  type Secret,
  type SecretInput,
} from "../secrets.ts";
import { ApproveButton } from "./Approval.tsx";

/**
 * Saving a secret, through the passkey when the record asks for it: letting a secret fill without asking on a
 * domain it wasn't already allowed on is the one save that hands it out more freely (contract §4).
 */
function useSave(onSaved: () => void) {
  const [asked, setAsked] = useState<{ readonly input: SecretInput; readonly challenge: string }>();
  const [error, setError] = useState<string>();
  const save = async (input: SecretInput) => {
    setAsked(undefined);
    setError(undefined);
    const saved = await saveSecret(input);
    if ("challenge" in saved) return setAsked({ input, challenge: saved.challenge });
    if ("error" in saved) return setError(saved.error);
    onSaved();
  };
  const approve = async () => {
    if (!asked) return undefined;
    const signed = await sign(asked.challenge);
    if ("error" in signed) return signed;
    const saved = await saveSecret({ ...asked.input, response: signed.response });
    if ("error" in saved) return saved;
    if ("challenge" in saved) return { error: "This secret changed since you signed. Sign again." };
    setAsked(undefined);
    onSaved();
    return undefined;
  };
  const cancel = () => setAsked(undefined);
  return { asked, error, save, approve, cancel };
}

function PolicySelect({
  id,
  value,
  onChange,
}: {
  readonly id: string;
  readonly value: Policy;
  readonly onChange: (policy: Policy) => void;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(event) => {
        const picked = POLICIES.find(({ policy }) => policy === event.currentTarget.value);
        if (picked) onChange(picked.policy);
      }}
    >
      {POLICIES.map(({ policy, label }) => (
        <option key={policy} value={policy}>
          {label}
        </option>
      ))}
    </select>
  );
}

function Asked({
  name,
  approve,
  cancel,
}: {
  readonly name: string;
  readonly approve: () => Promise<{ readonly error: string } | undefined>;
  readonly cancel: () => void;
}) {
  return (
    <div className="approval" role="status">
      <p>Filling {name} without asking hands it out more freely, so it needs your passkey.</p>
      <ApproveButton approve={approve} />{" "}
      <button type="button" className="ghost" onClick={cancel}>
        Cancel
      </button>
    </div>
  );
}

/** One secret: where it fills and how, both changeable, and the way to remove it. Never its value. */
function SecretRow({ secret, onChange }: { readonly secret: Secret; readonly onChange: () => void }) {
  const id = useId();
  const [domain, setDomain] = useState(secret.domain ?? "");
  const [policy, setPolicy] = useState(secret.policy);
  const [forgetting, setForgetting] = useState(false);
  const [forgetError, setForgetError] = useState<string>();
  const { asked, error, save, approve, cancel } = useSave(onChange);
  useEffect(() => {
    setDomain(secret.domain ?? "");
    setPolicy(secret.policy);
  }, [secret.domain, secret.policy]);
  const changed = domain.trim() !== (secret.domain ?? "") || policy !== secret.policy;
  const forget = async () => {
    const failed = await forgetSecret(secret.name);
    setForgetError(failed?.error);
    if (!failed) onChange();
  };
  return (
    <li className="secret">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save({ name: secret.name, domain: domain.trim() === "" ? null : domain, policy });
        }}
      >
        <strong className="name">{secret.name}</strong>
        <label htmlFor={`${id}-domain`}>Fills on</label>
        <input
          id={`${id}-domain`}
          value={domain}
          placeholder="Nowhere yet: add the portal's address"
          onChange={(event) => setDomain(event.currentTarget.value)}
        />
        <label htmlFor={`${id}-policy`}>When</label>
        <PolicySelect id={`${id}-policy`} value={policy} onChange={setPolicy} />
        <div className="actions">
          <button type="submit" disabled={!changed}>
            Save
          </button>
          {forgetting ? (
            <>
              <span className="muted small">Remove {secret.name} from your vault?</span>
              <button type="button" className="danger" onClick={() => void forget()}>
                Remove
              </button>
              <button type="button" className="ghost" onClick={() => setForgetting(false)}>
                Keep
              </button>
            </>
          ) : (
            <button type="button" className="ghost" onClick={() => setForgetting(true)}>
              Forget
            </button>
          )}
        </div>
      </form>
      {(error ?? forgetError) && (
        <p className="error small" role="alert">
          {error ?? forgetError}
        </p>
      )}
      {asked && <Asked name={secret.name} approve={approve} cancel={cancel} />}
    </li>
  );
}

/** A new secret: its value goes in once, here, and never comes back to the site. */
function NewSecret({ onSaved }: { readonly onSaved: () => void }) {
  const id = useId();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [domain, setDomain] = useState("");
  const [policy, setPolicy] = useState<Policy>("ask");
  const done = () => {
    setName("");
    setValue("");
    setDomain("");
    setPolicy("ask");
    onSaved();
  };
  const { asked, error, save, approve, cancel } = useSave(done);
  return (
    <form
      className="new-secret"
      onSubmit={(event) => {
        event.preventDefault();
        void save({ name: name.trim(), value, domain: domain.trim() === "" ? null : domain, policy });
      }}
    >
      <h2>Save a secret</h2>
      <label htmlFor={`${id}-name`}>Name</label>
      <input
        id={`${id}-name`}
        value={name}
        placeholder="portal.tum"
        required
        autoComplete="off"
        onChange={(event) => setName(event.currentTarget.value)}
      />
      <label htmlFor={`${id}-value`}>Value</label>
      <input
        id={`${id}-value`}
        type="password"
        value={value}
        required
        autoComplete="off"
        onChange={(event) => setValue(event.currentTarget.value)}
      />
      <label htmlFor={`${id}-domain`}>The portal's address</label>
      <input
        id={`${id}-domain`}
        value={domain}
        placeholder="https://campus.tum.de/login"
        onChange={(event) => setDomain(event.currentTarget.value)}
      />
      <label htmlFor={`${id}-policy`}>When</label>
      <PolicySelect id={`${id}-policy`} value={policy} onChange={setPolicy} />
      <div className="actions">
        <button type="submit" className="primary" disabled={!name.trim() || !value}>
          Save secret
        </button>
      </div>
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
      {asked && <Asked name={asked.input.name} approve={approve} cancel={cancel} />}
    </form>
  );
}

/**
 * The person's secrets: what each is called, the domain it fills on and when, never a value. Values go in here
 * once and leave the record only into a form on that domain, when the person presses Fill in the extension.
 */
export function Secrets() {
  const [secrets, setSecrets] = useState<readonly Secret[] | null>();
  const reload = useCallback(() => {
    void listSecrets().then((listed) => setSecrets(listed ?? null));
  }, []);
  useEffect(reload, [reload]);
  return (
    <section className="secrets">
      <header className="pane-head">
        <h1>Secrets</h1>
        <p className="muted">
          Portal logins and numbers your agent can fill but never see. Each one fills only into a page on the
          domain you save it with, when you press Fill in the Brainiac extension. A lookalike site gets
          nothing.
        </p>
      </header>
      {secrets === undefined ? (
        <p className="empty">Loading…</p>
      ) : secrets === null ? (
        <p className="empty">Your secrets load when you're online.</p>
      ) : (
        <>
          {secrets.length === 0 ? (
            <p className="empty">No secrets yet.</p>
          ) : (
            <ul>
              {secrets.map((secret) => (
                <SecretRow key={secret.name} secret={secret} onChange={reload} />
              ))}
            </ul>
          )}
          <NewSecret onSaved={reload} />
        </>
      )}
    </section>
  );
}
