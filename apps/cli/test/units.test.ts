import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { configDir, loadConfig, saveConfig } from "../src/config.ts";
import { isMassChange, isNote, otherSyncTools } from "../src/guards.ts";
import { logout, startLogin, type Waiting } from "../src/login.ts";
import { service } from "../src/service.ts";

describe("what the daemon takes from disk", () => {
  it("syncs notes, never hidden files, temp files or other tools' conflict copies", () => {
    expect(isNote("facts/tests/ielts-2026-11.md")).toBe(true);
    expect(isNote("applications/essay (1).md")).toBe(true); // a name people use, not only Google Drive's copies
    for (const path of [
      "notes/a.txt",
      ".brainiac/state.md",
      ".obsidian/workspace.md",
      "notes/.~brainiac-1234",
      "notes/a (conflicted copy 2026-11-14).md",
      "notes/a.sync-conflict-20261114-123456-ABCDEFG.md",
    ]) {
      expect(isNote(path), path).toBe(false);
    }
    // iCloud's " 2" copies are ignored only inside iCloud, where they come from.
    expect(isNote("notes/plan 2.md")).toBe(true);
    expect(isNote("notes/plan 2.md", true)).toBe(false);
  });

  it("pauses for more than 50 notes, or 10% of the record from 5 notes up", () => {
    expect(isMassChange(1, 1)).toBe(false);
    expect(isMassChange(4, 10)).toBe(false);
    expect(isMassChange(5, 10)).toBe(true);
    expect(isMassChange(5, 60)).toBe(false);
    expect(isMassChange(50, 10_000)).toBe(false);
    expect(isMassChange(51, 10_000)).toBe(true);
  });
});

describe("other sync tools", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("finds Dropbox above the vault and Obsidian Sync in either plugin format", () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "brainiac-tools-")));
    const vault = join(dir, "Dropbox", "vault");
    mkdirSync(join(vault, ".obsidian"), { recursive: true });
    expect(otherSyncTools(vault)).toEqual([]);
    writeFileSync(join(dir, "Dropbox", ".dropbox"), "");
    writeFileSync(join(vault, ".obsidian", "core-plugins.json"), JSON.stringify(["file-explorer", "sync"]));
    expect(otherSyncTools(vault)).toHaveLength(2);
    writeFileSync(join(vault, ".obsidian", "core-plugins.json"), JSON.stringify({ sync: false }));
    expect(otherSyncTools(vault)).toHaveLength(1);
  });
});

describe("brainiac daemon install", () => {
  const program = ["/Users/nadia/My Apps/brainiac", "daemon", "run"];

  it("writes a launchd agent that keeps the daemon running", () => {
    const unit = service({ platform: "darwin", home: "/Users/nadia", uid: 501, user: "nadia", program });
    expect(unit.path).toBe("/Users/nadia/Library/LaunchAgents/dev.brainiac.daemon.plist");
    expect(unit.content).toContain("<string>/Users/nadia/My Apps/brainiac</string>");
    expect(unit.content).toContain("<key>KeepAlive</key>");
    expect(unit.start.at(-1)).toEqual(["launchctl", "bootstrap", "gui/501", unit.path]);
  });

  it("writes a systemd user unit, quoting every argument", () => {
    const unit = service({
      platform: "linux",
      home: "/home/nadia",
      uid: 1000,
      user: "nadia",
      program: [...program, "100%"],
    });
    expect(unit.path).toBe("/home/nadia/.config/systemd/user/brainiac.service");
    expect(unit.content).toContain('ExecStart="/Users/nadia/My Apps/brainiac" "daemon" "run" "100%%"');
    expect(unit.start.at(-1)).toEqual(["systemctl", "--user", "enable", "--now", "brainiac.service"]);
  });

  it("writes a Task Scheduler task for this user, quoting every argument as Windows splits them", () => {
    const unit = service({
      platform: "win32",
      home: "C:\\Users\\nadia",
      uid: -1,
      user: "nadia",
      program: ["C:\\Program Files\\Brainiac\\brainiac.exe", "daemon", "run", 'say "hi"', "C:\\vault\\"],
    });
    expect(unit.path).toBe("C:\\Users\\nadia\\AppData\\Roaming\\brainiac\\daemon-task.xml");
    expect(unit.content).toContain(
      "<Command>&quot;C:\\Program Files\\Brainiac\\brainiac.exe&quot;</Command>",
    );
    expect(unit.content).toContain(
      "<Arguments>&quot;daemon&quot; &quot;run&quot; &quot;say \\&quot;hi\\&quot;&quot; &quot;C:\\vault\\\\&quot;</Arguments>",
    );
    expect(unit.content).toContain("<UserId>nadia</UserId>");
    expect(unit.start.at(-1)).toEqual(["schtasks", "/Run", "/TN", "Brainiac daemon"]);
  });

  it("says so on a platform without a daemon yet", () => {
    expect(() => service({ platform: "aix", home: "/home/nadia", uid: 0, user: "nadia", program })).toThrow(
      /aix/,
    );
  });
});

describe("the config folder", () => {
  it("is the OS's, never the vault", () => {
    expect(configDir({}, "darwin", "/Users/nadia")).toBe("/Users/nadia/Library/Application Support/brainiac");
    expect(configDir({}, "linux", "/home/nadia")).toBe("/home/nadia/.config/brainiac");
    expect(configDir({ XDG_CONFIG_HOME: "/xdg" }, "linux", homedir())).toBe("/xdg/brainiac");
    expect(configDir({ APPDATA: "D:\\Roaming" }, "win32", "C:\\Users\\nadia")).toBe("D:\\Roaming\\brainiac");
    expect(configDir({}, "win32", "C:\\Users\\nadia")).toBe("C:\\Users\\nadia\\AppData\\Roaming\\brainiac");
  });
});

// What the site's page posts to the loopback listener once the person confirms.
const postBack = (url: URL, form: Record<string, string>) =>
  fetch(`http://127.0.0.1:${url.searchParams.get("port")}/callback`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });

describe("brainiac login", () => {
  let dir = "";
  let login: Waiting | undefined;
  afterEach(() => {
    login?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("takes the token only with its own state, and saves it readable by this user alone", async () => {
    login = await startLogin("https://brainiac.test", "Ada's laptop");
    const url = new URL(login.url);
    expect(url.origin + url.pathname).toBe("https://brainiac.test/cli/login");
    expect(url.searchParams.get("device")).toBe("Ada's laptop");
    const state = url.searchParams.get("state") ?? "";
    expect(state.length).toBeGreaterThanOrEqual(32);
    const token = `brn_${"a".repeat(64)}_${"b".repeat(43)}`;

    // Another page posting to this port, without the state only this terminal and its browser tab know.
    expect((await postBack(url, { token, state: "x".repeat(state.length) })).status).toBe(400);
    expect((await postBack(url, { token, state: "" })).status).toBe(400);
    expect((await postBack(url, { token: "not-a-token", state })).status).toBe(400);
    const pending = Symbol("pending");
    expect(await Promise.race([login.token, pending])).toBe(pending);

    expect((await postBack(url, { token, state })).status).toBe(200);
    expect(await login.token).toBe(token);

    dir = realpathSync(mkdtempSync(join(tmpdir(), "brainiac-login-")));
    saveConfig(dir, { ...loadConfig(dir), token });
    expect(loadConfig(dir).token).toBe(token);
    // Windows has no mode bits; the config folder there is in the user's own AppData.
    const mode = process.platform === "win32" ? 0o600 : statSync(join(dir, "config.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("never sends a token to logout in the clear, except to this machine", async () => {
    const token = `brn_${"a".repeat(64)}_${"b".repeat(43)}`;
    await expect(logout("http://brainiac.test", token)).rejects.toThrow(/isn't https/);
  });
});
