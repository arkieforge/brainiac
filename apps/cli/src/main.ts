#!/usr/bin/env bun
// `brainiac`: the laptop side. Built into one binary with `bun build --compile`.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import { doctor, lockVault, request, restore, watchRequests } from "./commands.ts";
import { configDir, loadConfig, saveConfig, type Config } from "./config.ts";
import { Daemon } from "./daemon.ts";
import { socketLink } from "./link.ts";
import { service } from "./service.ts";

const USAGE = `brainiac daemon run [--vault <dir>] [--server <url>] [--repair]
brainiac daemon install [--vault <dir>] [--server <url>]
brainiac daemon uninstall
brainiac resume [--undo]
brainiac repair
brainiac restore <file> [<version>]
brainiac doctor`;

/** The arguments that run this binary again: the compiled binary alone, or Bun and this script. */
const self = () =>
  // A compiled binary's embedded script: /$bunfs/ on macOS and Linux, B:\~BUN\ on Windows.
  /^(\/\$bunfs\/|[A-Z]:[\\/]~BUN[\\/])/i.test(Bun.main) ? [process.execPath] : [process.execPath, Bun.main];

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
    },
  });
  const dir = configDir();
  let config: Config = loadConfig(dir);
  const token = process.env["BRAINIAC_TOKEN"];
  // Flags given once are remembered, so the login service needs none.
  if (values.vault || values.server || token) {
    config = {
      ...config,
      // Stored resolved, so the daemon and every command name one vault, even through an alias.
      ...(values.vault && {
        vault: existsSync(values.vault) ? realpathSync(values.vault) : resolve(values.vault),
      }),
      ...(values.server && { server: values.server }),
      ...(token && { token }),
    };
    saveConfig(dir, config);
  }
  const vault = config.vault;
  const [command, sub, ...rest] = positionals;

  if (command === "daemon" && sub === "run") {
    if (!vault || !config.server) fail("brainiac daemon run needs --vault <dir> and --server <url> once.");
    let unlock: () => void;
    try {
      unlock = lockVault(dir, vault); // two daemons on one vault would share one client id
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    const daemon = await Daemon.start({
      root: vault,
      deviceId: config.deviceId,
      connect: socketLink(config.server, config.token),
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
  if (!vault)
    fail(`No vault yet: start with \`brainiac daemon run --vault <dir> --server <url>\`.\n\n${USAGE}`);
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
