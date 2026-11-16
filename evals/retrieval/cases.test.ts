// The retrieval eval's scorers, gate and golden set, which CI runs; the hybrid run needs Workers AI and doesn't.
import { describe, expect, it } from "vite-plus/test";

import { connection, fixtureRecord } from "../shared/world.ts";
import { CASES, K, measure, recallGate, retrieve, score, type Retrieved } from "./cases.ts";

const keyword = () => {
  const { sql, ids } = fixtureRecord();
  return { sql, ids, reader: connection(sql, "read", true).connection };
};

const gate = (found: number, of: number) =>
  recallGate({ route: "ask", cases: of, found, of, cited: of }, "hybrid").ok;

describe("retrieval scorers", () => {
  it("counts answering notes only in the first 8, once each", () => {
    const top = ["a", "b", "a", "c", "d", "e", "f", "g", "h", "x"];
    expect(score(["a", "x"], top)).toEqual({ found: 1, of: 2, cited: K });
    expect(score(["b"], ["b"])).toEqual({ found: 1, of: 1, cited: 1 });
    expect(score(["b"], [])).toEqual({ found: 0, of: 1, cited: 0 });
  });

  it("sums a route's cases and leaves out the other routes", () => {
    const [first, second] = CASES;
    if (!first || !second) throw new Error("no cases");
    const retrieved: Retrieved[] = [
      { case: first.id, route: "search", mode: "keyword", ids: [...first.answers] },
      { case: second.id, route: "search", mode: "keyword", ids: ["elsewhere"] },
      { case: second.id, route: "ask", mode: "keyword", ids: [...second.answers] },
    ];
    expect(measure(CASES, retrieved, "search")).toEqual({
      route: "search",
      cases: 2,
      found: first.answers.length,
      of: first.answers.length + second.answers.length,
      cited: first.answers.length + 1,
    });
  });

  it("fails a run under 0.95 recall@8, and one that measured nothing", () => {
    expect(gate(19, 20)).toBe(true);
    expect(gate(20, 20)).toBe(true);
    expect(gate(18, 19)).toBe(false);
    expect(gate(0, 0)).toBe(false);
  });
});

describe("retrieval golden set", () => {
  it("names fixture notes, each case its own id", () => {
    const { ids } = fixtureRecord();
    const notes = new Set(Object.values(ids));
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
    for (const c of CASES) {
      expect(c.answers.length, c.id).toBeGreaterThan(0);
      for (const id of c.answers) expect(notes.has(id), `${c.id}: ${id}`).toBe(true);
    }
  });

  it("holds paraphrases keyword search misses, so only meaning finds them", () => {
    const { sql, reader } = keyword();
    const guards = CASES.filter((c) => c.kind === "guard");
    expect(guards.length).toBeGreaterThanOrEqual(CASES.length / 3);
    for (const c of guards) {
      const got = retrieve(sql, reader, c, "search");
      expect(
        c.answers.every((id) => got?.ids.slice(0, K).includes(id)),
        `${c.id} is found by keyword`,
      ).toBe(false);
    }
  });

  it("finds every answer by query, and every control's by keyword ask", () => {
    const { sql, reader } = keyword();
    for (const c of CASES) {
      const missing = (route: "query" | "ask") => {
        const got = retrieve(sql, reader, c, route);
        return got && c.answers.filter((id) => !got.ids.slice(0, K).includes(id));
      };
      if (c.query) expect(missing("query"), `${c.id} query`).toEqual([]);
      if (c.kind === "control") expect(missing("ask"), `${c.id} ask`).toEqual([]);
    }
  });
});
