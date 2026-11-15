// Conformance cases for secrets and the fill path (secrets.ts): an agent's fill_form never carries a secret's value,
// a secret goes only into a page on its saved domain, a lookalike is refused as one, and values leave only when the
// person presses Fill, once. cases.ts runs them on both engines; apps/worker/test/fill.test.ts runs the routes and a
// real passkey.
import { deepStrictEqual as same, equal, match, ok } from "node:assert/strict";

import {
  auditOf,
  callTool,
  connect,
  dataKey,
  FILL_MS,
  forgetSecret,
  grant,
  migrate,
  pendingFills,
  releaseFill,
  saveSecret,
  type Connection,
  type Context,
  type Level,
  type Released,
  type Sql,
} from "../src/index.ts";
import type { Case } from "./cases.ts";

const T0 = Date.UTC(2026, 10, 15);
const human: Context = { actor: "human", now: T0 };
const via = (connection: Connection, now = T0): Context => ({
  actor: `connection:${connection.id}`,
  connection,
  now,
});
const PAGE = "https://campus.tum.de/apply";
// The fixture student's portal password: fictional.
const PASSWORD = "nadia-PORTAL-canary-4471";

let signatures = 0;
const signature = () => ({ credentialId: "passkey-1", counter: ++signatures, assertion: "{}" });

function setUp(sql: Sql, level: Level = "write") {
  migrate(sql);
  const key = dataKey(sql, "a stage's vault key");
  const saved = saveSecret(
    sql,
    key,
    { name: "portal.tum", value: PASSWORD, domain: "https://campus.tum.de/login" },
    human,
  );
  same(saved, { secret: { name: "portal.tum", domain: "campus.tum.de", policy: "ask" } });
  let agent = connect(sql, { kind: "cli" }, T0);
  if (level !== "propose") {
    const granted = grant(
      sql,
      { connectionId: agent.id, level, sensitive: false, holdDays: 0, rev: agent.rev },
      signature(),
    );
    ok("connection" in granted, JSON.stringify(granted));
    agent = granted.connection;
  }
  return { key, agent };
}

const FIELDS = [
  { field: "Username", value: "nadia.karim" },
  { field: "Password", secret: "portal.tum" },
];

function ask(sql: Sql, agent: Connection, url = PAGE, fields: unknown = FIELDS) {
  const answer = callTool(sql, "fill_form", { url, fields }, via(agent));
  ok(answer.ok, JSON.stringify(answer));
  return answer.value as { status: string; fill?: string; next?: string; message?: string };
}

function waiting(sql: Sql, agent: Connection): string {
  const answer = ask(sql, agent);
  equal(answer.status, "waiting", JSON.stringify(answer));
  ok(answer.fill);
  return answer.fill;
}

const values = (released: Released) => {
  ok("fields" in released, JSON.stringify(released));
  return released.fields;
};

export const fillCases: Record<string, Case> = {
  "an agent's fill waits for the person and never carries a secret's value": (sql) => {
    const { agent } = setUp(sql);
    const answer = ask(sql, agent);
    equal(answer.status, "waiting");
    match(String(answer.next), /open https:\/\/campus\.tum\.de\/apply and press Fill/);
    // Not in the answer, the waiting row, or what the person's extension lists before they press Fill.
    const stored = JSON.stringify(sql.all("SELECT * FROM fills"));
    const listed = pendingFills(sql, "https://campus.tum.de/other-page", human);
    for (const text of [JSON.stringify(answer), stored, JSON.stringify(listed)])
      ok(!text.includes(PASSWORD), text);
    same(Array.isArray(listed) && listed.map((fill) => fill.fields), [FIELDS]);
    same(pendingFills(sql, "https://kth.se/apply", human), []);
    // A connection can't list or release fills, even the one that asked.
    equal((pendingFills(sql, PAGE, via(agent)) as { status: string }).status, "forbidden");
    equal(
      (releaseFill(sql, new Uint8Array(32), String(answer.fill), PAGE, via(agent)) as { status: string })
        .status,
      "forbidden",
    );
  },

  "a page that imitates the secret's domain is refused as phishing, and another domain is refused": (sql) => {
    const { agent } = setUp(sql);
    for (const url of [
      "https://campus.tum.de.login-check.example/apply",
      "https://campus-tum.de/apply",
      "https://xn--tm-xka.de/apply",
    ]) {
      const answer = ask(sql, agent, url);
      equal(answer.status, "refused", url);
      match(String(answer.message), /phishing/, url);
    }
    const elsewhere = ask(sql, agent, "https://kth.se/apply");
    equal(elsewhere.status, "refused");
    match(String(elsewhere.message), /saved for campus\.tum\.de, and kth\.se isn't on it/);
    // Credentials before the host only ever dress up another host.
    const dressed = callTool(
      sql,
      "fill_form",
      { url: "https://campus.tum.de@evil.example/apply", fields: FIELDS },
      via(agent),
    );
    ok(!dressed.ok);
    const plain = callTool(
      sql,
      "fill_form",
      { url: "http://campus.tum.de/apply", fields: FIELDS },
      via(agent),
    );
    ok(!plain.ok && /https/.test(plain.error));
    equal(sql.all("SELECT * FROM fills").length, 0);
  },

  "only a write connection asks for fills, and each field is a value or a secret": (sql) => {
    const { agent } = setUp(sql, "propose");
    equal(ask(sql, agent).status, "forbidden");
    const reader = connect(sql, { kind: "cli" }, T0);
    const read = grant(
      sql,
      { connectionId: reader.id, level: "read", sensitive: false, holdDays: 3, rev: reader.rev },
      signature(),
    );
    ok("connection" in read);
    equal(ask(sql, read.connection).status, "forbidden");
    const writer = setUp(sql).agent;
    const both = callTool(
      sql,
      "fill_form",
      { url: PAGE, fields: [{ field: "Password", value: "x", secret: "portal.tum" }] },
      via(writer),
    );
    ok(!both.ok && /either a value or a secret/.test(both.error));
    const none = callTool(sql, "fill_form", { url: PAGE, fields: [] }, via(writer));
    ok(!none.ok);
    // A name the record doesn't have is refused, naming only the secrets that could fill this page.
    saveSecret(sql, setUp(sql).key, { name: "passport.uto.abc", value: "XK1234567" }, human);
    const unknown = callTool(
      sql,
      "fill_form",
      { url: PAGE, fields: [{ field: "Password", secret: "portal.kth" }] },
      via(writer),
    );
    ok(!unknown.ok);
    equal(unknown.error, "No secret named portal.kth. Secrets saved for campus.tum.de: portal.tum.");
  },

  "the person's Fill releases values once, on the saved domain, with their passkey for an ask secret": (
    sql,
  ) => {
    const { key, agent } = setUp(sql);
    const fill = waiting(sql, agent);
    // A lookalike tab or another site gets nothing, and the fill keeps waiting.
    match(
      String(
        (
          releaseFill(sql, key, fill, "https://campus.tum.de.login-check.example/", human) as {
            error: string;
          }
        ).error,
      ),
      /only imitates campus\.tum\.de/,
    );
    match(
      String((releaseFill(sql, key, fill, "https://kth.se/", human) as { error: string }).error),
      /for campus\.tum\.de, not this page/,
    );
    const first = releaseFill(sql, key, fill, PAGE, human);
    ok("challenge" in first, JSON.stringify(first));
    equal(first.host, "campus.tum.de");
    const wrong = releaseFill(sql, key, fill, PAGE, human, {
      challenge: "something else",
      signature: signature(),
    });
    ok("error" in wrong);
    const signed = signature();
    same(
      values(releaseFill(sql, key, fill, PAGE, human, { challenge: first.challenge, signature: signed })),
      [
        { field: "Username", value: "nadia.karim" },
        { field: "Password", value: PASSWORD },
      ],
    );
    // Used once.
    match(
      String(
        (
          releaseFill(sql, key, fill, PAGE, human, {
            challenge: first.challenge,
            signature: signature(),
          }) as { error: string }
        ).error,
      ),
      /ran out or was used/,
    );
    // The use is on record under the connection that asked, by the secret's name.
    const [call] = auditOf(sql, agent.id);
    same([call?.tool, call?.secretName], ["fill", "portal.tum"]);
  },

  "a signature over one fill can't release another": (sql) => {
    const { key, agent } = setUp(sql);
    const one = waiting(sql, agent);
    const two = waiting(sql, agent);
    const first = releaseFill(sql, key, one, PAGE, human);
    ok("challenge" in first);
    ok(
      "error" in
        releaseFill(sql, key, two, PAGE, human, { challenge: first.challenge, signature: signature() }),
    );
  },

  "allow fills without asking, only after the person's passkey made it allow; never fills nothing": (sql) => {
    const { key, agent } = setUp(sql);
    const loosen = saveSecret(sql, key, { name: "portal.tum", policy: "allow" }, human);
    ok("challenge" in loosen, JSON.stringify(loosen));
    ok(
      "error" in
        saveSecret(sql, key, { name: "portal.tum", policy: "allow" }, human, {
          challenge: "other",
          signature: signature(),
        }),
    );
    same(
      saveSecret(sql, key, { name: "portal.tum", policy: "allow" }, human, {
        challenge: loosen.challenge,
        signature: signature(),
      }),
      {
        secret: { name: "portal.tum", domain: "campus.tum.de", policy: "allow" },
      },
    );
    same(values(releaseFill(sql, key, waiting(sql, agent), PAGE, human))[1], {
      field: "Password",
      value: PASSWORD,
    });
    // Moving an allowed secret to another domain needs the passkey again; the old signature is spent.
    ok("challenge" in saveSecret(sql, key, { name: "portal.tum", domain: "tum.de" }, human));
    ok(
      "error" in
        saveSecret(sql, key, { name: "portal.tum", domain: "tum.de" }, human, {
          challenge: loosen.challenge,
          signature: signature(),
        }),
    );
    // Tightening needs nothing.
    same(saveSecret(sql, key, { name: "portal.tum", policy: "never" }, human), {
      secret: { name: "portal.tum", domain: "campus.tum.de", policy: "never" },
    });
    const refused = ask(sql, agent);
    equal(refused.status, "refused");
    match(String(refused.message), /never to be filled/);
    // A connection can't save or loosen a secret.
    equal(
      (saveSecret(sql, key, { name: "portal.tum", policy: "ask" }, via(agent)) as { status: string }).status,
      "forbidden",
    );
  },

  "an allow signature can't be used again, even from a passkey that keeps no counter, after the secret is forgotten":
    (sql) => {
      const { key } = setUp(sql);
      // Synced passkeys report counter 0 every time, so only the challenge can stop a replay.
      const counterless = { credentialId: "synced-passkey", counter: 0, assertion: "{}" };
      const input = { name: "portal.kth", value: "x", domain: "kth.se", policy: "allow" };
      const first = saveSecret(sql, key, input, human);
      ok("challenge" in first);
      ok(
        "secret" in
          saveSecret(sql, key, input, human, { challenge: first.challenge, signature: counterless }),
      );
      forgetSecret(sql, "portal.kth", human);
      ok(
        "error" in saveSecret(sql, key, input, human, { challenge: first.challenge, signature: counterless }),
      );
      const again = saveSecret(sql, key, input, human);
      ok("challenge" in again && again.challenge !== first.challenge);
    },

  "a fill is judged again when the person presses Fill: a secret moved or removed since doesn't go": (
    sql,
  ) => {
    const { key, agent } = setUp(sql);
    const moved = waiting(sql, agent);
    same(saveSecret(sql, key, { name: "portal.tum", domain: "kth.se" }, human), {
      secret: { name: "portal.tum", domain: "kth.se", policy: "ask" },
    });
    match(
      String((releaseFill(sql, key, moved, PAGE, human) as { error: string }).error),
      /saved for kth\.se/,
    );
    saveSecret(sql, key, { name: "portal.tum", domain: "campus.tum.de" }, human);
    const removed = waiting(sql, agent);
    sql.all("DELETE FROM secrets");
    match(
      String((releaseFill(sql, key, removed, PAGE, human) as { error: string }).error),
      /removed from your vault/,
    );
  },

  "a fill runs out, and one from a disconnected agent doesn't go": (sql) => {
    const { key, agent } = setUp(sql);
    const fill = waiting(sql, agent);
    const later: Context = { ...human, now: T0 + FILL_MS };
    match(String((releaseFill(sql, key, fill, PAGE, later) as { error: string }).error), /ran out/);
    same(pendingFills(sql, PAGE, later), []);
    const kept = waiting(sql, agent);
    sql.all("DELETE FROM connections WHERE id = ?", agent.id);
    match(String((releaseFill(sql, key, kept, PAGE, human) as { error: string }).error), /disconnected/);
  },

  "a secret with no saved domain fills nowhere, and a new secret needs its value": (sql) => {
    const { key, agent } = setUp(sql);
    saveSecret(sql, key, { name: "portal.tum", domain: null }, human);
    match(String(ask(sql, agent).message), /no saved domain/);
    ok("error" in saveSecret(sql, key, { name: "portal.kth", domain: "kth.se" }, human));
    ok("error" in saveSecret(sql, key, { name: "portal.kth", value: "x", domain: "localhost" }, human));
    ok("error" in saveSecret(sql, key, { name: "Portal KTH", value: "x" }, human));
  },
};
