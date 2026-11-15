// The CLI's own settings, in the OS config folder (never in the vault, so a copied vault carries none of
// them): this machine's device id, the vault it keeps, the record's server and the connection token.
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 } from "node:path";

export interface Config {
  /** This machine. `state.db` records it, so a vault copied to another machine never replays its queue. */
  readonly deviceId: string;
  readonly vault?: string;
  readonly server?: string;
  /** The connection token; until `brainiac login` exists (#87) it comes from BRAINIAC_TOKEN. */
  readonly token?: string;
  /** "Keep sensitive notes on this laptop", for a device the person marked as theirs. */
  readonly keepSensitive?: boolean;
}

export function configDir(env = process.env, platform = process.platform, home = homedir()): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", "brainiac");
  if (platform === "win32")
    return win32.join(env["APPDATA"] || win32.join(home, "AppData", "Roaming"), "brainiac");
  return join(env["XDG_CONFIG_HOME"] || join(home, ".config"), "brainiac");
}

/** The config in `dir`, made on first use with a new device id. */
export function loadConfig(dir: string): Config {
  try {
    return JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as Config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const config = { deviceId: randomUUID() };
    saveConfig(dir, config);
    return config;
  }
}

/** Writes the config readable only by this user: it holds the token. */
export function saveConfig(dir: string, config: Config): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.json");
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
