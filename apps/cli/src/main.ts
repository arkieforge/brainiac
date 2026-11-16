#!/usr/bin/env bun
// `brainiac`: the laptop side. Built into one binary with `bun build --compile`.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import type { Answer } from "@brainiac/base";

import { configDir, loadConfig, saveConfig, type Config } from "./config.ts";
import type { Bridge } from "./filing.ts";
import type { Source } from "./imports.ts";
import { socketLink } from "./link.ts";
import { serveStdio } from "./mcp.ts";
import { service } from "./service.ts";

// Each command loads the rest of what it needs when it runs: the record's code (ArkType's schemas above all) is
// most of a start, and `brainiac mcp serve` online needs none of it.

const USAGE = `brainiac login [--server <url>]
brainiac logout
brainiac daemon run [--vault <dir>] [--server <url>] [--repair]
brainiac daemon install [--vault <dir>] [--server <url>]
brainiac daemon uninstall
brainiac mcp serve [--server <url>] [--background]
brainiac scan <file or folder>...
brainiac import [<file or folder>...] [--vault <folder>]
brainiac questions [--all] [--json]
brainiac photos [--json]
brainiac filing [on|off|now]
brainiac hook
brainiac resume [--undo]
brainiac repair
brainiac restore <file> [<version>]
brainiac doctor`;

/** The arguments that run this binary again: the compiled binary alone, or Bun and this script. */
const self = () =>
  // A compiled binary's embedded script: /$bunfs/ on macOS and Linux, B:\~BUN\ on Windows.
  /^(\/\$bunfs\/|[A-Z]:[\\/]~BUN[\\/])/i.test(Bun.main) ? [process.execPath] : [process.execPath, Bun.main];

/** `brainiac mcp serve --background`, as a filing run starts it. */
const bridge = (): Bridge => {
  const [command = process.execPath, ...args] = self();
  return { command, args: [...args, "mcp", "serve", "--background"] };
};

/** One filing run with the Claude Code binary at `claude`, reporting what it said at the end. */
async function fileNow(claude: string): Promise<boolean> {
  const { fileInbox } = await import("./filing.ts");
  const { code, events } = await fileInbox(bridge(), { claude });
  const result = events.find((event) => event["type"] === "result");
  const said = typeof result?.["result"] === "string" ? `\n${result["result"]}` : "";
  if (code === 0) console.log(`Filing run finished.${said}`);
  else console.error(`The filing run stopped (exit ${code}).${said}`);
  return code === 0;
}

/** The login service for this user, running this binary. */
const unit = () =>
  service({
    platform: process.platform,
    home: homedir(),
    uid: userInfo().uid,
    user: userInfo().username,
    program: [...self(), "daemon", "run"],
  });

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(argv: readonly string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      vault: { type: "string" },
      server: { type: "string" },
      repair: { type: "boolean" },
      undo: { type: "boolean" },
      all: { type: "boolean" },
      json: { type: "boolean" },
      background: { type: "boolean" },
    },
  });
  const dir = configDir();
  let config: Config = loadConfig(dir);
  const [command, sub, ...rest] = positionals;
  // A saved token belongs to the server it was minted on, so the two change only together: a new server is saved
  // with the token `brainiac login` gets from it, and while a token is saved no other command may point elsewhere.
  const saved = { server: config.server, token: config.token };
  const otherServer = values.server !== undefined && values.server !== config.server;
  if (otherServer && config.token && command !== "login")
    fail(
      `This computer is logged in to ${config.server}. Run brainiac logout first, or brainiac login --server ${values.server}.`,
    );
  // scan and import read --vault as the folder to import from: it's not the vault this computer syncs.
  const source = command === "scan" || command === "import";
  // Flags given once are remembered, so the login service needs none.
  if ((values.vault && !source) || values.server) {
    config = {
      ...config,
      // Stored resolved, so the daemon and every command name one vault, even through an alias.
      ...(values.vault &&
        !source && {
          vault: existsSync(values.vault) ? realpathSync(values.vault) : resolve(values.vault),
        }),
      // Login saves its server only with the token it gets from it.
      ...(values.server && command !== "login" && { server: values.server }),
    };
    saveConfig(dir, config);
  }
  // For CI and scripts: BRAINIAC_TOKEN stands in for the saved token while it is set, and is never saved.
  const token = process.env["BRAINIAC_TOKEN"] || config.token;
  const vault = config.vault;

  if (command === "login") {
    const server = values.server ?? config.server;
    if (!server) fail("brainiac login needs --server <url> once.");
    const { logout, openBrowser, startLogin } = await import("./login.ts");
    const login = await startLogin(server, hostname());
    console.log(`Opening your browser to connect this computer. If it doesn't open, go to:\n${login.url}`);
    openBrowser(login.url);
    const fresh = await login.token;
    saveConfig(dir, { ...config, server, token: fresh });
    // The token it replaces is gone from this machine, so its connection is ended rather than left behind.
    if (saved.server && saved.token) await logout(saved.server, saved.token).catch(() => {});
    console.log("Logged in. Restart the daemon if it is running, so it syncs with the new connection.");
    return;
  }
  if (command === "logout") {
    if (!saved.server || !saved.token) fail("Not logged in on this computer.");
    const { logout } = await import("./login.ts");
    try {
      await logout(saved.server, saved.token);
    } catch (error) {
      // Kept, so logging out can be tried again: the connection would otherwise outlive the only copy of its token.
      fail(`Couldn't reach ${saved.server} to end this connection, so it is still saved: ${String(error)}`);
    }
    const { token: _ended, ...kept } = config;
    saveConfig(dir, kept);
    console.log("Logged out: this computer's connection is ended, and its token deleted.");
    return;
  }

  if (command === "daemon" && sub === "run") {
    if (!vault || !config.server) fail("brainiac daemon run needs --vault <dir> and --server <url> once.");
    const [{ lockVault, watchRequests }, { Daemon }, { fileable, filer }, { tokenKey }] = await Promise.all([
      import("./commands.ts"),
      import("./daemon.ts"),
      import("./filing.ts"),
      import("./offline.ts"),
    ]);
    let unlock: () => void;
    try {
      unlock = lockVault(dir, vault); // two daemons on one vault would share one client id
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    const daemon = await Daemon.start({
      root: vault,
      deviceId: config.deviceId,
      connect: socketLink(config.server, token),
      ...(token && { tokenKey: tokenKey(token) }),
      ...(config.keepSensitive && { keepSensitive: true }),
      ...(values.repair && { repair: true }),
    });
    watchRequests(dir, vault, (what) => {
      // A request that fails is reported, and the daemon keeps running.
      const report = (error: unknown) => console.error(`brainiac ${what} failed:`, error);
      if (what === "resume") daemon.resume().catch(report);
      if (what === "undo") daemon.resume({ undo: true }).catch(report);
      if (what === "repair") daemon.repair().catch(report);
    });
    // New inbox items the record sends start a filing run, once the person turned filing on.
    const { filing } = config;
    if (filing) {
      const file = filer(() => fileNow(filing.claude).then(() => {}));
      const fileNew = (ids: Iterable<string>) =>
        file([...ids].filter((id) => fileable(daemon.client.state.remote.get(id))));
      daemon.subscribe(fileNew);
      // Items already waiting when the daemon starts get one run too.
      fileNew(daemon.client.state.remote.keys());
    }
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        daemon.stop();
        unlock();
        process.exit(0);
      });
    }
    console.log(`Syncing ${vault}.`);
    return;
  }
  if (command === "daemon" && sub === "install") {
    if (!vault || !config.server)
      fail("brainiac daemon install needs --vault <dir> and --server <url> once.");
    const { path, content, encoding, unload, start } = unit();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, encoding ?? "utf8");
    if (unload) spawnSync(unload[0]!, unload.slice(1), { stdio: "ignore" });
    for (const step of start) {
      const run = spawnSync(step[0]!, step.slice(1), { stdio: "inherit" });
      if (run.status !== 0) fail(`${step.join(" ")} failed.`);
    }
    console.log(`Installed ${path}: the daemon now starts when you log in.`);
    return;
  }
  if (command === "daemon" && sub === "uninstall") {
    const { path, stop } = unit();
    for (const step of stop) spawnSync(step[0]!, step.slice(1), { stdio: "inherit" });
    rmSync(path, { force: true });
    console.log(`Removed ${path}.`);
    return;
  }
  if (command === "mcp" && sub === "serve") {
    // stdout carries the protocol, so nothing else may print there.
    if (!config.server || !token)
      fail("brainiac mcp serve needs --server <url> once, and brainiac login (or BRAINIAC_TOKEN).");
    const local = {
      vault,
      deviceId: config.deviceId,
      token,
      keepSensitive: config.keepSensitive ?? false,
      ...(values.background && { background: true }),
    };
    let copy: Promise<{ call: (name: string, args: unknown) => Answer }> | undefined;
    try {
      await serveStdio({
        server: config.server,
        token,
        input: process.stdin,
        write: (line) => process.stdout.write(`${line}\n`),
        ...(values.background && { background: true }),
        offline: async (name, args) => {
          copy ??= import("./offline.ts").then(({ localCopy }) => localCopy(local));
          return (await copy).call(name, args);
        },
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (command === "scan" || command === "import") {
    // What scan read is remembered, so `brainiac import` alone sends it.
    const last = join(dir, "scan.json");
    const named = [
      ...[sub, ...rest].filter((path) => path !== undefined),
      ...(values.vault ? [values.vault] : []),
    ];
    const { importSources, readSource, scanReport } = await import("./imports.ts");
    let paths = named.map((path) => resolve(path));
    if (command === "scan" && paths.length === 0) fail("brainiac scan <file or folder>...");
    if (paths.length === 0) {
      if (!existsSync(last)) fail("Nothing to import: brainiac scan <file or folder> first, or name them.");
      paths = JSON.parse(readFileSync(last, "utf8")).paths;
    }
    const sources: Source[] = [];
    for (const path of paths) {
      try {
        sources.push(await readSource(path, vault));
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    }
    if (command === "scan") {
      for (const line of sources.flatMap(scanReport)) console.log(line);
      writeFileSync(last, JSON.stringify({ paths }));
      return console.log(
        "\nNothing has left this computer. brainiac import sends these: each note as a proposal you review, and inbox items for your Claude to file.",
      );
    }
    if (!config.server || !token) fail("brainiac import needs brainiac login first.");
    const server = config.server;
    const { callRecord } = await import("./record.ts");
    try {
      const { lines, failed } = await importSources(sources, (args) =>
        callRecord(server, token, "import", args),
      );
      for (const line of lines) console.log(line);
      if (failed) process.exitCode = 1;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (command === "questions") {
    if (!config.server || !token) fail("brainiac questions needs --server <url> once, and brainiac login.");
    const [{ callRecord }, { QUESTIONS_QUERY, questionsReport }] = await Promise.all([
      import("./record.ts"),
      import("./questions.ts"),
    ]);
    try {
      const answer = await callRecord(config.server, token, "query", QUESTIONS_QUERY);
      if (values.json) return console.log(JSON.stringify(answer, null, 2));
      for (const line of questionsReport(answer, config.server, Date.now(), values.all ?? false))
        console.log(line);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (command === "photos") {
    if (!config.server || !token) fail("brainiac photos needs --server <url> once, and brainiac login.");
    const [{ callRecord }, { photosReport }] = await Promise.all([
      import("./record.ts"),
      import("./photos.ts"),
    ]);
    try {
      const answer = await callRecord(config.server, token, "photos", {});
      if (values.json) return console.log(JSON.stringify(answer, null, 2));
      for (const line of photosReport(answer, config.server)) console.log(line);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (command === "filing") {
    // Found here, in the person's shell: the login service that runs the daemon has only the system's PATH.
    const claude = config.filing?.claude ?? Bun.which("claude");
    const missing =
      "Filing runs Claude Code on your own subscription: install it (claude on your PATH) first.";
    if (sub === "on") {
      const found = Bun.which("claude");
      if (!found) fail(missing);
      saveConfig(dir, { ...config, filing: { claude: found } });
      return console.log(
        `Filing is on with ${found}: new inbox items start a headless run. Restart the daemon to start it.`,
      );
    }
    if (sub === "off") {
      const { filing: _off, ...kept } = config;
      saveConfig(dir, kept);
      return console.log("Filing is off: inbox items wait for your Claude. Restart the daemon to stop it.");
    }
    if (sub === "now") {
      if (!config.server || !token) fail("brainiac filing now needs brainiac login first.");
      if (!claude) fail(missing);
      if (!(await fileNow(claude))) process.exitCode = 1;
      return;
    }
    if (sub !== undefined) fail(USAGE);
    return console.log(
      config.filing
        ? `Filing is on with ${config.filing.claude}.`
        : "Filing is off: brainiac filing on turns it on.",
    );
  }
  if (command === "hook") {
    // Claude Code's PreToolUse hook: exit code 2 refuses the call, and the agent reads stderr. No vault, no rules.
    const { refusal, ToolCall } = await import("./hook.ts");
    const why = vault && refusal(ToolCall.assert(JSON.parse(await Bun.stdin.text())), vault);
    if (why) {
      console.error(why);
      process.exit(2);
    }
    return;
  }
  if (!vault)
    fail(`No vault yet: start with \`brainiac daemon run --vault <dir> --server <url>\`.\n\n${USAGE}`);
  const { doctor, request, restore } = await import("./commands.ts");
  if (command === "resume") {
    if (!request(dir, vault, values.undo ? "undo" : "resume"))
      fail("The daemon isn't running: start it with `brainiac daemon run`, then `brainiac resume`.");
    console.log(values.undo ? "Putting the record's versions back." : "Syncing the paused changes.");
    return;
  }
  if (command === "repair") {
    if (request(dir, vault, "repair"))
      return console.log("Repairing: the daemon compares every file with the record.");
    // No daemon: run one in repair mode in the foreground.
    return main(["daemon", "run", "--repair"]);
  }
  if (command === "restore") {
    if (!sub) fail("brainiac restore <file> [<version>]");
    const pick = rest[0] === undefined ? undefined : Number(rest[0]);
    try {
      for (const line of restore(vault, sub, Date.now(), pick)) console.log(line);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (command === "doctor") {
    const checks = await doctor(dir, vault, unit().path);
    for (const check of checks) console.log(`${check.ok ? "ok  " : "fix "} ${check.text}`);
    if (checks.some((check) => !check.ok)) process.exitCode = 1;
    return;
  }
  fail(USAGE);
}

await main(Bun.argv.slice(2));
