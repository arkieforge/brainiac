// `brainiac daemon install`: a login service that runs the daemon, so a sleeping or rebooted laptop catches
// up when it wakes. launchd on macOS, a systemd user unit on Linux, a Task Scheduler task on Windows.
import { posix, win32 } from "node:path";

const LABEL = "dev.brainiac.daemon";
const TASK = "Brainiac daemon";

/** The unit file to write, and the commands that load and unload it. */
export interface Service {
  readonly path: string;
  readonly content: string;
  /** How `content` is written; UTF-8 unless set. */
  readonly encoding?: "utf16le";
  /** Unloads an older copy first, so installing again picks up a changed file; fails harmlessly when none runs. */
  readonly unload?: readonly string[];
  readonly start: readonly (readonly string[])[];
  readonly stop: readonly (readonly string[])[];
}

const xml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One argument as Windows splits a command line (CommandLineToArgvW): quoted, backslashes doubled before a quote. */
const winArg = (arg: string) => `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;

/** systemd's quoting for one ExecStart argument. */
const unitArg = (arg: string) => `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

/** The service that runs `program` (the brainiac binary and its arguments) for this user. */
export function service(options: {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly uid: number;
  /** The user's name, for Windows' logon trigger. */
  readonly user: string;
  readonly program: readonly string[];
}): Service {
  const { platform, home, uid, user, program } = options;
  if (platform === "darwin") {
    const path = posix.join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
    const log = posix.join(home, "Library", "Logs", "brainiac-daemon.log");
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
      unload: ["launchctl", "bootout", `gui/${uid}/${LABEL}`],
      start: [["launchctl", "bootstrap", `gui/${uid}`, path]],
      stop: [["launchctl", "bootout", `gui/${uid}/${LABEL}`]],
    };
  }
  if (platform === "linux") {
    return {
      path: posix.join(home, ".config", "systemd", "user", "brainiac.service"),
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
  if (platform === "win32") {
    const [command = "", ...args] = program;
    const path = win32.join(home, "AppData", "Roaming", "brainiac", "daemon-task.xml");
    // A logon trigger for this user only, restarted on failure, never stopped for running long or on battery.
    // shortcut: the daemon's console window shows while it runs; a hidden launcher comes if people mind it.
    return {
      path,
      encoding: "utf16le",
      content: `\ufeff<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Brainiac daemon: keeps the vault folder in sync with your record</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <UserId>${xml(user)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(winArg(command))}</Command>
      <Arguments>${xml(args.map(winArg).join(" "))}</Arguments>
    </Exec>
  </Actions>
</Task>
`,
      unload: ["schtasks", "/End", "/TN", TASK],
      start: [
        ["schtasks", "/Create", "/TN", TASK, "/XML", path, "/F"],
        ["schtasks", "/Run", "/TN", TASK],
      ],
      stop: [
        ["schtasks", "/End", "/TN", TASK],
        ["schtasks", "/Delete", "/TN", TASK, "/F"],
      ],
    };
  }
  throw new Error(`brainiac daemon install doesn't support ${platform} yet.`);
}
