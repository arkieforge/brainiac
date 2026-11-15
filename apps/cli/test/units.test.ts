import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vite-plus/test";

import { configDir, loadConfig, saveConfig } from "../src/config.ts";
import { isMassChange, isNote, otherSyncTools } from "../src/guards.ts";
import { refusal } from "../src/hook.ts";
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

describe("brainiac hook", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "brainiac-hook-")));
  const vault = join(home, "brainiac");
  const code = join(home, "code");
  mkdirSync(join(vault, "identity"), { recursive: true });
  mkdirSync(join(vault, "facts", "roles"), { recursive: true });
  mkdirSync(code);
  symlinkSync(join(vault, "identity"), join(code, "ids")); // a link from elsewhere still reads identity/
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  const check = (tool_name: string, tool_input: Record<string, unknown>, cwd = code) =>
    refusal({ tool_name, tool_input, cwd }, vault, home);

  it("refuses edits and shell commands anywhere in the vault", () => {
    const calls: [string, Record<string, unknown>, string?][] = [
      ["Edit", { file_path: join(vault, "facts/roles/acme-intern-2025.md") }],
      ["MultiEdit", { file_path: "~/brainiac/me.md" }],
      ["Write", { file_path: join(vault, "new/folder/a.md") }],
      ["Write", { file_path: "me.md" }, vault],
      ["NotebookEdit", { notebook_path: join(vault, "a.ipynb") }],
      ["Bash", { command: `sed -i s/7.5/8/ ${vault}/facts/tests/ielts-2026-11.md` }],
      ["Bash", { command: "cat ~/brainiac/me.md" }],
      ["Bash", { command: 'rm "$HOME/brainiac/inbox/a.md"' }],
      ["Bash", { command: "ls" }, join(vault, "facts")],
      ["Bash", { command: "cat brainiac/identity/passport.md" }, home],
      ["Bash", { command: "printf new > brainiac/facts/roles/new.md" }, home],
      ["Bash", { command: "cat ../brainiac/me.md" }],
      ["Bash", { command: "cat \\\n../brainiac/identity/passport.md" }],
      ["Bash", { command: 'echo "$(cat ../brainiac/identity/passport.md)"' }],
    ];
    for (const [tool, input, cwd] of calls)
      expect(check(tool, input, cwd), `${tool} ${JSON.stringify(input)}`).toMatch(/Brainiac record/);
    // A vault whose name has a space: quoted and escaped words are one path, as the shell reads them.
    const spaced = join(home, "My Record");
    mkdirSync(join(spaced, "identity"), { recursive: true });
    for (const command of [
      `cat "${spaced}/identity/passport.md"`,
      "printf new > 'My Record/facts/roles/new.md'",
      "cat My\\ Record/me.md",
      'ls "$HOME"/My\\ Record',
    ])
      expect(
        refusal({ tool_name: "Bash", tool_input: { command }, cwd: home }, spaced, home),
        command,
      ).toMatch(/Brainiac record/);
  });

  it("refuses reads of sensitive folders, vault documents and the inbox, and searches that reach them", () => {
    const calls: [string, Record<string, unknown>, string?][] = [
      ["Read", { file_path: join(vault, "identity/passport.md") }],
      ["Read", { file_path: join(vault, "facts/tests/ielts-2026-11.md") }],
      ["Read", { file_path: join(vault, "documents/files/transcript-bsc.pdf") }],
      ["Read", { file_path: "inbox/a.md" }, vault],
      ["Read", { file_path: join(code, "ids/passport.md") }],
      // ids/ is identity/, so its .. is the vault, whatever the path looks like.
      ["Read", { file_path: join(code, "ids") + "/../facts/tests/ielts-2026-11.md" }],
      ["Grep", { pattern: "cgpa", path: vault }],
      ["Grep", { pattern: "cgpa" }, vault],
      ["Grep", { pattern: "cgpa", path: join(vault, "history") }],
      ["Glob", { pattern: "identity/*.md" }, vault],
      ["Glob", { pattern: `${vault}/people/**` }],
      ["Glob", { pattern: "**/*.pdf", path: join(vault, "documents") }],
    ];
    for (const [tool, input, cwd] of calls)
      expect(check(tool, input, cwd), `${tool} ${JSON.stringify(input)}`).toMatch(/isn't read from disk/);
  });

  it("lets everything else through", () => {
    const calls: [string, Record<string, unknown>, string?][] = [
      ["Read", { file_path: join(vault, "facts/roles/acme-intern-2025.md") }],
      ["Read", { file_path: join(code, "main.ts") }],
      ["Edit", { file_path: join(code, "main.ts") }],
      ["Write", { file_path: join(home, "brainiac-notes.md") }],
      ["Bash", { command: "ls -la" }],
      ["Bash", { command: 'git commit -m "brainiac notes"' }],
      ["Bash", { command: `cat ${home}/brainiac-notes.md ${home}/brainiac.bak` }],
      ["Grep", { pattern: "cgpa", path: join(vault, "facts/roles") }],
      ["Glob", { pattern: "facts/roles/*.md", path: vault }],
      ["Glob", { pattern: "src/**/*.ts" }],
      ["WebFetch", { url: "https://example.org" }],
    ];
    for (const [tool, input, cwd] of calls)
      expect(check(tool, input, cwd), `${tool} ${JSON.stringify(input)}`).toBeUndefined();
  });

  it("refuses with exit code 2 and the reason on stderr, and refuses nothing without a vault", () => {
    const bun = createRequire(import.meta.url).resolve("bun/bin/bun.exe");
    const run = (configured: boolean) => {
      const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), APPDATA: home };
      const dir = configDir(env, process.platform, home);
      saveConfig(dir, { deviceId: "test", ...(configured && { vault }) });
      const call = { tool_name: "Read", tool_input: { file_path: join(vault, "inbox/a.md") }, cwd: code };
      return spawnSync(bun, [join(import.meta.dirname, "../src/main.ts"), "hook"], {
        env,
        input: JSON.stringify({ session_id: "s", hook_event_name: "PreToolUse", ...call }),
        encoding: "utf8",
      });
    };
    const refused = run(true);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/inbox holds sensitive notes/);
    expect(run(false).status).toBe(0);
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
