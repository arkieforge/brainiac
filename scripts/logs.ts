#!/usr/bin/env node
// `vp run logs --stage <stage>`: a deployed stage's failed requests from Workers Logs, one block per request with
// its log lines and exceptions. A "ref" the site shows next to an error is the request's Cloudflare ray id.
//   --since 1h       how far back to look: 30m, 6h, 2d (default 1h)
//   --ray <id>       every line of that one request, failed or not
//   --all            every request, not only failed ones
//   --tail           stream live instead (needs only Workers Tail access, so it works before logs are readable)
// Prod reads its token from Doppler's prd config, so only people with prd access see prod's logs.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parseArgs } from "node:util";

const ROOT = join(import.meta.dirname, "..");

/** One request as both log sources see it. */
export interface RequestLog {
  time: number;
  ray: string;
  method: string;
  url: string;
  status: number | undefined;
  outcome: string;
  lines: string[];
  /** Any error line or exception, even when the response was a 200. */
  errored: boolean;
}

export const failed = (r: RequestLog) => r.errored || r.outcome !== "ok" || (r.status ?? 0) >= 500;

/** The fields we read from a stored Workers Logs event. Every one is optional: the shape varies by event type. */
export interface StoredEvent {
  timestamp?: number;
  $metadata?: {
    requestId?: string;
    rayId?: string;
    level?: string;
    message?: string;
    error?: string;
    statusCode?: number;
  };
  $workers?: {
    requestId?: string;
    outcome?: string;
    event?: { request?: { method?: string; url?: string }; response?: { status?: number } };
  };
}

/** Groups stored events (each a log line or an invocation summary) into requests, oldest first. */
export function requestsFromEvents(events: readonly StoredEvent[]): RequestLog[] {
  const byRequest = new Map<string, RequestLog>();
  for (const e of events) {
    const meta = e.$metadata ?? {};
    const workers = e.$workers ?? {};
    const id = meta.requestId ?? workers.requestId ?? meta.rayId ?? String(e.timestamp);
    const r = byRequest.get(id) ?? {
      time: e.timestamp ?? 0,
      ray: "",
      method: "",
      url: "",
      status: undefined,
      outcome: "ok",
      lines: [],
      errored: false,
    };
    byRequest.set(id, r);
    r.time = Math.min(r.time, e.timestamp ?? r.time);
    r.ray ||= meta.rayId ?? "";
    r.method ||= workers.event?.request?.method ?? "";
    r.url ||= workers.event?.request?.url ?? "";
    r.status ??= workers.event?.response?.status ?? meta.statusCode;
    if (workers.outcome && workers.outcome !== "ok") r.outcome = workers.outcome;
    const isError = meta.level === "error" || Boolean(meta.error);
    r.errored ||= isError;
    const text = meta.error ?? meta.message;
    // The invocation summary repeats the method and URL as its message; the header line already shows them.
    if (text && !(workers.event?.request && text.includes(r.url)))
      r.lines.push(`${meta.level ?? "log"}: ${text}`);
  }
  return [...byRequest.values()].toSorted((a, b) => a.time - b.time);
}

/** One live tail message (Cloudflare's trace-v1 format). */
export interface TailEvent {
  eventTimestamp?: number;
  outcome: string;
  event?: {
    request?: { method: string; url: string; headers?: Record<string, string> };
    response?: { status: number };
  } | null;
  logs: { level: string; message: unknown[] }[];
  exceptions: { name: string; message: string; stack?: string }[];
}

export const requestFromTail = (t: TailEvent): RequestLog => ({
  time: t.eventTimestamp ?? Date.now(),
  // cf-ray is `<id>-<colo>`; Workers Logs and the site's ref use the id alone.
  ray: t.event?.request?.headers?.["cf-ray"]?.split("-")[0] ?? "",
  method: t.event?.request?.method ?? "",
  url: t.event?.request?.url ?? "",
  status: t.event?.response?.status,
  outcome: t.outcome,
  lines: [
    ...t.logs.map(
      (l) => `${l.level}: ${l.message.map((m) => (typeof m === "string" ? m : JSON.stringify(m))).join(" ")}`,
    ),
    ...t.exceptions.map((x) => `exception: ${x.name}: ${x.message}${x.stack ? `\n${x.stack}` : ""}`),
  ],
  errored: t.exceptions.length > 0 || t.logs.some((l) => l.level === "error"),
});

export const format = (r: RequestLog) => {
  const path = URL.canParse(r.url) ? new URL(r.url).pathname : r.url;
  const head = `${new Date(r.time).toISOString()}  ${r.method} ${path}  ${r.status ?? "-"}  ${r.outcome}  ray ${r.ray || "-"}`;
  return [head, ...r.lines.map((line) => `    ${line.replaceAll("\n", "\n    ")}`)].join("\n");
};

export function sinceMs(value: string): number {
  const match = /^(\d+)([mhd])$/.exec(value);
  if (!match) throw new Error(`--since takes a number and m, h or d, like 30m or 2d; got "${value}".`);
  return Number(match[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "m" | "h" | "d"];
}

function secret(name: string, config: string): string | undefined {
  const out = spawnSync(
    "doppler",
    ["secrets", "get", name, "--plain", "--project", "braniac", "--config", config],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  );
  return out.status === 0 ? out.stdout.trim() || undefined : undefined;
}

async function cloudflare(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  const body = (await res.json()) as { success: boolean; errors?: { message: string }[]; result?: unknown };
  if (!body.success) {
    const message = body.errors?.map((e) => e.message).join("; ") ?? res.statusText;
    throw new Error(
      res.status === 403
        ? `Cloudflare refused (${message}). The token needs Workers Observability Read for stored logs and ` +
            "Workers Tail Read for --tail; see infra/README.md (CLOUDFLARE_LOGS_TOKEN)."
        : `Cloudflare API ${path}: ${message}`,
    );
  }
  return body.result;
}

async function stored(
  accountId: string,
  token: string,
  script: string,
  opts: { since: string; ray: string | undefined },
) {
  const now = Date.now();
  const filters = [
    { key: "$workers.scriptName", operation: "eq", type: "string", value: script },
    ...(opts.ray ? [{ key: "$metadata.rayId", operation: "eq", type: "string", value: opts.ray }] : []),
  ];
  // shortcut: one page of 2000 events, newest window only; add `offset` paging if a window ever overflows it.
  const limit = 2000;
  const result = (await cloudflare(`/accounts/${accountId}/workers/observability/telemetry/query`, token, {
    method: "POST",
    body: JSON.stringify({
      queryId: "brainiac-logs",
      view: "events",
      timeframe: { from: now - sinceMs(opts.since), to: now },
      limit,
      parameters: { filters },
    }),
  })) as { events?: { events?: StoredEvent[] } };
  const events = result.events?.events ?? [];
  if (events.length >= limit) console.warn(`Only the first ${limit} events; narrow --since to see the rest.`);
  return requestsFromEvents(events);
}

async function tail(accountId: string, token: string, script: string, show: (r: RequestLog) => void) {
  const base = `/accounts/${accountId}/workers/scripts/${script}/tails`;
  const { id, url } = (await cloudflare(base, token, { method: "POST", body: "{}" })) as {
    id: string;
    url: string;
  };
  const close = () => cloudflare(`${base}/${id}`, token, { method: "DELETE" }).finally(() => process.exit(0));
  process.on("SIGINT", close);
  const socket = new WebSocket(url, ["trace-v1"]);
  socket.addEventListener("open", () => console.error(`Tailing ${script}. Ctrl-C to stop.`));
  socket.addEventListener("message", async (message) => {
    // Frames arrive as Blobs in Node; Response reads a Blob or an ArrayBuffer alike.
    const text = typeof message.data === "string" ? message.data : await new Response(message.data).text();
    show(requestFromTail(JSON.parse(text) as TailEvent));
  });
  socket.addEventListener("close", () => void close());
}

async function main() {
  const { values } = parseArgs({
    options: {
      stage: { type: "string" },
      since: { type: "string", default: "1h" },
      ray: { type: "string" },
      all: { type: "boolean", default: false },
      tail: { type: "boolean", default: false },
    },
  });
  if (!values.stage) throw new Error("Pass --stage, e.g. --stage prod or --stage pr-74.");
  const config = values.stage === "prod" ? "prd" : "dev";
  const token = secret("CLOUDFLARE_LOGS_TOKEN", config) ?? secret("CLOUDFLARE_API_TOKEN", config);
  const accountId = secret("CLOUDFLARE_ACCOUNT_ID", config);
  if (!token || !accountId) {
    throw new Error(`Couldn't read Cloudflare secrets from Doppler config ${config}. Run \`vp run doctor\`.`);
  }
  // Worker names follow alchemy.run.ts: brainiac-<id>-<stage>, underscores as dashes.
  const script = `brainiac-worker-${values.stage.replaceAll("_", "-")}`;
  const wanted = (r: RequestLog) => values.all || Boolean(values.ray) || failed(r);
  const show = (r: RequestLog) => {
    if (wanted(r) && (!values.ray || r.ray === values.ray)) console.log(format(r));
  };
  if (values.tail) await tail(accountId, token, script, show);
  else {
    const requests = (
      await stored(accountId, token, script, { since: values.since, ray: values.ray })
    ).filter(wanted);
    for (const r of requests) console.log(format(r));
    if (requests.length === 0)
      console.error(`No ${values.all ? "" : "failed "}requests in the last ${values.since}.`);
  }
}

if (import.meta.main) {
  // Errors here are for a person at a terminal: the message says what to do, a stack trace doesn't.
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
