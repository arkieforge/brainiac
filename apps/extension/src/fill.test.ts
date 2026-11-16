// @vitest-environment happy-dom
// The page side of Fill: which field each value lands in, and when nothing should be filled at all.
import { afterEach, describe, expect, it } from "vite-plus/test";

import { fillPage } from "./fill.ts";

const HERE = location.href;
const LOGIN = [
  { field: "Username", value: "nadia.karim" },
  { field: "Password", value: "nadia-PORTAL-canary-4471" },
];

const page = (html: string) => {
  document.body.innerHTML = html;
};
const valueOf = (selector: string) => document.querySelector<HTMLInputElement>(selector)?.value;

afterEach(() => page(""));

describe("fillPage", () => {
  it("finds fields by label, name or id, fires input and change, and submits nothing", () => {
    page(`
      <form id="login">
        <label for="u">Username *</label><input id="u" name="user">
        <input name="Password" type="password">
        <select id="term"><option value="ws">Winter semester</option><option value="ss">Summer semester</option></select>
        <button type="submit">Sign in</button>
      </form>`);
    const events: string[] = [];
    let submitted = false;
    document.querySelector("#u")?.addEventListener("input", () => events.push("input"));
    document.querySelector("#u")?.addEventListener("change", () => events.push("change"));
    document.querySelector("form")?.addEventListener("submit", () => (submitted = true));

    const done = fillPage([...LOGIN, { field: "term", value: "Summer semester" }], HERE);

    expect(done).toEqual({ filled: ["Username", "Password", "term"], missing: [] });
    expect(valueOf("#u")).toBe("nadia.karim");
    expect(valueOf("[name=Password]")).toBe("nadia-PORTAL-canary-4471");
    expect(valueOf("#term")).toBe("ss");
    expect(events).toEqual(["input", "change"]);
    expect(submitted).toBe(false);
  });

  it("fills only the form that holds the fields, not a search box with the same label", () => {
    page(`
      <form id="search"><label>Username <input id="find"></label></form>
      <form id="login">
        <label>Username <input id="u"></label>
        <label>Password <input id="p" type="password"></label>
      </form>`);
    expect(fillPage(LOGIN, HERE)).toEqual({ filled: ["Username", "Password"], missing: [] });
    expect(valueOf("#find")).toBe("");
    expect(valueOf("#u")).toBe("nadia.karim");
  });

  it("fills nothing when two forms fit as well as each other", () => {
    page(`
      <form><label>Username <input id="a"></label><label>Password <input id="b"></label></form>
      <form><label>Username <input id="c"></label><label>Password <input id="d"></label></form>`);
    expect(fillPage(LOGIN, HERE)).toMatchObject({ refused: expect.stringMatching(/Two forms/) });
    expect(["#a", "#b", "#c", "#d"].map(valueOf)).toEqual(["", "", "", ""]);
  });

  it("names what it couldn't place: a field the page lacks, or two by the same name", () => {
    page(`
      <form>
        <label>Username <input id="u"></label>
        <input name="Password" id="p1"><input name="Password" id="p2">
        <input type="hidden" name="Passport">
      </form>`);
    const done = fillPage([...LOGIN, { field: "Passport", value: "X" }], HERE);
    expect(done).toEqual({ filled: ["Username"], missing: ["Password", "Passport"] });
    expect([valueOf("#p1"), valueOf("#p2")]).toEqual(["", ""]);
  });

  it("puts nothing into a page that moved after the click, even on the same site", () => {
    page(`<form><label>Username <input id="u"></label><label>Password <input id="p"></label></form>`);
    for (const pressed of ["https://campus.tum.de/apply", new URL("/other-page", HERE).href])
      expect(fillPage(LOGIN, pressed)).toMatchObject({ refused: expect.stringMatching(/moved/) });
    expect(valueOf("#p")).toBe("");
    // Its # part is the page's own to change.
    expect(fillPage(LOGIN, `${HERE.split("#")[0]}#step-2`)).toMatchObject({
      filled: ["Username", "Password"],
    });
  });
});
