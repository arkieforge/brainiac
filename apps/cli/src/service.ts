// `brainiac daemon install`: a login service that runs the daemon, so a sleeping or rebooted laptop catches
// up when it wakes. launchd on macOS, a systemd user unit on Linux; Windows comes with its daemon (#28).
import { join } from "node:path";

const LABEL = "dev.brainiac.daemon";

/** The unit file to write, and the commands that load and unload it. */
export interface Service {
  readonly path: string;
  readonly content: string;
  readonly start: readonly (readonly string[])[];
  readonly stop: readonly (readonly string[])[];
}

const xml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** systemd's quoting for one ExecStart argument. */
const unitArg = (arg: string) => `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

/** The service that runs `program` (the brainiac binary and its arguments) for this user. */
export function service(options: {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly uid: number;
  readonly program: readonly string[];
}): Service {
  const { platform, home, uid, program } = options;
  if (platform === "darwin") {
    const path = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
    const log = join(home, "Library", "Logs", "brainiac-daemon.log");
    const args = program.map((arg) => `    <string>${xml(arg)}</string>`).join("\n");
    return {
      path,
      content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`,
      // bootout first, so installing again picks up a changed file; it fails harmlessly when not loaded.
      start: [
        ["launchctl", "bootout", `gui/${uid}/${LABEL}`],
        ["launchctl", "bootstrap", `gui/${uid}`, path],
      ],
      stop: [["launchctl", "bootout", `gui/${uid}/${LABEL}`]],
    };
  }
  if (platform === "linux") {
    return {
      path: join(home, ".config", "systemd", "user", "brainiac.service"),
      content: `[Unit]
Description=Brainiac daemon: keeps the vault folder in sync with your record

[Service]
ExecStart=${program.map(unitArg).join(" ")}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`,
      start: [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", "brainiac.service"],
      ],
      stop: [["systemctl", "--user", "disable", "--now", "brainiac.service"]],
    };
  }
  throw new Error(`brainiac daemon install doesn't support ${platform} yet.`);
}
