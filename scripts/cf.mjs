// Cloudflare API proxy. Reads credentials from .cf.env so the token never
// appears in the terminal, in shell history, or in an agent's context — the
// script holds it in memory, prints only the API response, and redacts the
// token from any output as a safety net.
//
// Subcommands (preferred — they build the request + a readable digest for you):
//   verify                     GET /accounts/{id}/tokens/verify
//   logs   [flags]             historical Worker logs (Observability telemetry)
//   wf     [name [instance]]   Workflows: list defs / list instances / one instance
//   ai     [flags | <logId>]   AI Gateway calls: digest, or one call's prompt + reply
//   fields [--worker <name>]   discover available log fields for a dataset
//
// logs flags:
//   --since <30m|2h|1d>   time window back from now (default 1h)
//   --worker <name>       filter by service/script name (server-side)
//   --level <error|warn|info|debug>   filter by level (server-side)
//   --grep <text>         keep events whose message contains <text> (client-side)
//   --limit <N>           max events (default 100)
//   --json | --raw        full pretty JSON / verbatim body instead of the digest
//
// Raw passthrough (anything the subcommands don't cover):
//   [METHOD] <path> [-d <json|@file>] [-q <k=v>]... [--raw]
//   path starting with "/"  → verbatim under https://api.cloudflare.com/client/v4
//   otherwise               → account-relative: /accounts/{ACCOUNT_ID}/<path>
//
// Examples:
//   npm run cf -- verify
//   npm run cf -- logs --since 2h --level error
//   npm run cf -- logs --worker looping-starter --grep HandleTaskWorkflow
//   npm run cf -- wf handle-task
//   npm run cf -- wf handle-task 27to4pc4w7eo0psa59o
//   npm run cf -- ai --since 2h
//   npm run cf -- ai 01KY4PSY6T1HBA7A2V22NKCFZC
//   npm run cf -- GET workflows -q per_page=50
//
// This Worker's workflows are `handle-task`, `arc-handle-task` and
// `notify-task`; `npm run cf -- wf` with no name lists whatever is deployed.
import fs from "node:fs";

const ENV_FILE = ".cf.env";
const BASE = "https://api.cloudflare.com/client/v4";
const DATASET = "cloudflare-workers";
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

function die(msg) {
  console.error(`cf: ${msg}`);
  process.exit(1);
}

const USAGE = `cf.mjs — Cloudflare API proxy (credentials from ${ENV_FILE})

  verify                                 check the token
  logs [--since 1h] [--worker <name>]    historical Worker logs, as a digest
       [--level error] [--grep <text>]
       [--limit 100] [--json|--raw]
  wf                                     list workflow definitions
  wf <name>                              list recent instances of a workflow
  wf <name> <instanceId> [--json]        one instance, per-step pass/fail
  ai [--since 2h] [--model <m>]          AI Gateway calls, as a digest
     [--limit 20] [--json|--raw]
  ai <logId> [--full] [--max N]          one call: prompt + reply (bodies)
  fields [--worker <name>]               list available log fields
  [METHOD] <path> [-d <json|@file>]      raw passthrough (path is account-relative
       [-q <k=v>]... [--raw]             unless it starts with "/")`;

try {
  process.loadEnvFile(ENV_FILE);
} catch {
  die(
    `could not read ${ENV_FILE}. Create it with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (see .cf.env.example).`
  );
}

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token) die(`CLOUDFLARE_API_TOKEN missing in ${ENV_FILE}`);
if (!accountId) die(`CLOUDFLARE_ACCOUNT_ID missing in ${ENV_FILE}`);

// Never let the token leak into output, whatever the API echoes back. All
// stdout goes through out() so the guard covers every path.
const redact = (s) =>
  token ? String(s).split(token).join("***REDACTED***") : String(s);
const out = (s = "") => console.log(redact(s));
const acct = (p) => `/accounts/${accountId}/${p}`;
const hhmmss = (ms) => new Date(ms).toISOString().slice(11, 19);

function parseSince(s) {
  const m = /^(\d+)\s*([smhd])$/.exec(String(s).trim());
  if (!m) die(`bad --since "${s}" (expected like 30m, 2h, 1d)`);
  const unit = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[m[2]];
  return Number(m[1]) * unit;
}

// Pull known --flags out of an arg list; everything else is a positional.
function parseFlags(args, { bool = [], value = [] } = {}) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const key = a.replace(/^--?/, "");
    if (bool.includes(a)) flags[key] = true;
    else if (value.includes(a)) {
      const v = args[++i];
      if (v === undefined) die(`missing value for ${a}`);
      flags[key] = v;
    } else if (a.startsWith("-")) die(`unknown flag: ${a}`);
    else pos.push(a);
  }
  return { flags, pos };
}

async function request(method, apiPath, { query = [], body } = {}) {
  const url = new URL(BASE + apiPath);
  for (const [k, v] of query) url.searchParams.append(k, v);
  const headers = { Authorization: `Bearer ${token}` };
  const payload =
    body === undefined
      ? undefined
      : typeof body === "string"
        ? body
        : JSON.stringify(body);
  if (payload !== undefined) headers["Content-Type"] = "application/json";
  console.error(`→ ${method} ${redact(url.pathname + url.search)}`);
  const res = await fetch(url, { method, headers, body: payload });
  const text = await res.text();
  console.error(`← ${res.status} ${res.statusText}`);
  return { res, text };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Print a body as pretty JSON (default) or verbatim (--raw). Returns the parsed
// JSON so callers can also render a digest from it.
function printBody(text, { raw = false } = {}) {
  if (raw) {
    out(text);
    return parseJson(text);
  }
  const json = parseJson(text);
  out(json ? JSON.stringify(json, null, 2) : text);
  return json;
}

// Exit on non-2xx responses and surface the API error body.
function ensureOk(res, text) {
  if (!res.ok) {
    printBody(text);
    process.exit(1);
  }
}

async function telemetryQuery({ from, to, filters, limit }) {
  const body = {
    queryId: "cf-cli",
    timeframe: { from, to },
    view: "events",
    limit,
    parameters: { datasets: [DATASET], ...(filters.length ? { filters } : {}) }
  };
  return request("POST", acct("workers/observability/telemetry/query"), {
    body
  });
}

async function cmdLogs(args) {
  const { flags } = parseFlags(args, {
    bool: ["--json", "--raw"],
    value: ["--since", "--worker", "--service", "--level", "--grep", "--limit"]
  });
  const sinceLabel = flags.since ?? "1h";
  const to = Date.now();
  const from = to - parseSince(sinceLabel);
  const limit = Number.parseInt(String(flags.limit ?? 100), 10);
  if (!Number.isFinite(limit) || limit <= 0)
    die(`bad --limit "${flags.limit}" (expected a positive integer)`);
  const worker = flags.worker ?? flags.service;

  const filters = [];
  if (flags.level)
    filters.push({
      key: "$metadata.level",
      operation: "eq",
      value: flags.level,
      type: "string"
    });
  if (worker)
    filters.push({
      key: "$metadata.service",
      operation: "eq",
      value: worker,
      type: "string"
    });

  const { res, text } = await telemetryQuery({ from, to, filters, limit });
  ensureOk(res, text);
  if (flags.json || flags.raw) {
    printBody(text, { raw: flags.raw });
    return;
  }

  const json = parseJson(text);
  let evs = json?.result?.events?.events ?? [];
  if (flags.grep) {
    const needle = String(flags.grep).toLowerCase();
    evs = evs.filter((e) =>
      (e.source?.message ?? "").toLowerCase().includes(needle)
    );
  }
  if (evs.length === 0) {
    out(
      `no events in last ${sinceLabel}${flags.grep ? ` matching "${flags.grep}"` : ""}`
    );
    return;
  }

  const byLevel = {};
  for (const e of evs)
    byLevel[e.source?.level ?? "?"] =
      (byLevel[e.source?.level ?? "?"] ?? 0) + 1;
  const levelStr = Object.entries(byLevel)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(" · ");
  const times = evs.map((e) => e.timestamp);
  out(`last ${sinceLabel} · ${evs.length} events · ${levelStr}`);
  out(`${hhmmss(Math.min(...times))} → ${hhmmss(Math.max(...times))}`);
  out("");
  for (const e of evs) {
    const lvl = (e.source?.level ?? "?").padEnd(5);
    const svc = (
      e["$metadata"]?.service ??
      e["$workers"]?.scriptName ??
      ""
    ).padEnd(24);
    const msg = (e.source?.message ?? "").replace(/\s+/g, " ").slice(0, 100);
    out(`${hhmmss(e.timestamp)}  ${lvl}  ${svc}  ${msg}`);
  }
  // The telemetry `limit` caps before any --grep, so compare against the raw page.
  const rawCount = json?.result?.events?.events?.length ?? 0;
  if (rawCount >= limit)
    out(
      `\n⚠ hit limit ${limit} — window may be truncated; narrow --since or raise --limit`
    );
}

async function cmdWf(args) {
  const { flags, pos } = parseFlags(args, { bool: ["--json", "--raw"] });
  const [name, instance] = pos;

  if (!name) {
    const { res, text } = await request("GET", acct("workflows"));
    ensureOk(res, text);
    if (flags.json || flags.raw)
      return void printBody(text, { raw: flags.raw });
    const defs = parseJson(text)?.result ?? [];
    for (const w of defs)
      out(`- ${w.name}  | class: ${w.class_name}  | script: ${w.script_name}`);
    return;
  }

  if (!instance) {
    const { res, text } = await request(
      "GET",
      acct(`workflows/${name}/instances`)
    );
    ensureOk(res, text);
    if (flags.json || flags.raw)
      return void printBody(text, { raw: flags.raw });
    const arr = parseJson(text)?.result ?? [];
    if (!Array.isArray(arr) || arr.length === 0)
      return void out("no instances");
    for (const i of arr)
      out(
        `${i.id}  ${(i.status ?? "?").padEnd(10)}  ${i.created_on ?? i.created ?? ""}`
      );
    return;
  }

  const { res, text } = await request(
    "GET",
    acct(`workflows/${name}/instances/${instance}`)
  );
  ensureOk(res, text);
  if (flags.json || flags.raw) return void printBody(text, { raw: flags.raw });
  const r = parseJson(text)?.result;
  if (!r) return void printBody(text);
  out(
    `status: ${r.status}  success: ${r.success}  error: ${r.error ?? "null"}`
  );
  out(
    `queued ${r.queued ?? "?"} · start ${r.start ?? "?"} · end ${r.end ?? "?"}`
  );
  out(`steps (${r.step_count ?? r.steps?.length ?? 0}):`);
  for (const s of r.steps ?? []) {
    const errs = (s.attempts ?? []).filter((a) => a.error).map((a) => a.error);
    out(
      `  - ${(s.name ?? s.type ?? "?").padEnd(16)} ${s.success ? "ok" : "ERROR"}` +
        (errs.length ? ` ${JSON.stringify(errs)}` : "")
    );
  }
}

async function cmdFields(args) {
  const { flags } = parseFlags(args, {
    bool: ["--raw"],
    value: ["--since", "--worker", "--service"]
  });
  const to = Date.now();
  const from = to - parseSince(flags.since ?? "1h");
  const worker = flags.worker ?? flags.service;
  const filters = worker
    ? [
        {
          key: "$metadata.service",
          operation: "eq",
          value: worker,
          type: "string"
        }
      ]
    : [];
  const body = {
    queryId: "cf-cli-keys",
    timeframe: { from, to },
    parameters: { datasets: [DATASET], ...(filters.length ? { filters } : {}) }
  };
  const { res, text } = await request(
    "POST",
    acct("workers/observability/telemetry/keys"),
    {
      body
    }
  );
  ensureOk(res, text);
  if (flags.raw) return void printBody(text, { raw: true });
  const keys = parseJson(text)?.result ?? [];
  if (!Array.isArray(keys)) return void printBody(text);
  for (const k of keys)
    out(typeof k === "string" ? k : `${k.key ?? k.name}  (${k.type ?? "?"})`);
}

const AI_GW_DEFAULT = "default";

function truncate(s, max) {
  s = String(s ?? "");
  if (!Number.isFinite(max) || s.length <= max) return s;
  return `${s.slice(0, max)}\n  …[+${s.length - max} chars — use --full]`;
}

// Best-effort readable text for one chat message (string / multimodal / tool calls).
function messageText(msg) {
  if (typeof msg.content === "string" && msg.content.length) return msg.content;
  if (Array.isArray(msg.content))
    return msg.content.map((p) => p.text ?? `[${p.type ?? "part"}]`).join("\n");
  if (msg.tool_calls)
    return `tool_calls: ${JSON.stringify(msg.tool_calls, null, 2)}`;
  return JSON.stringify(msg.content ?? msg);
}

async function cmdAi(args) {
  const { flags, pos } = parseFlags(args, {
    bool: ["--json", "--raw", "--full"],
    value: ["--since", "--model", "--limit", "--gateway", "--max"]
  });
  const gw = flags.gateway ?? AI_GW_DEFAULT;
  if (pos[0]) return cmdAiDetail(gw, pos[0], flags);

  const limit = Number(flags.limit ?? 20);
  const { res, text } = await request(
    "GET",
    acct(`ai-gateway/gateways/${gw}/logs`),
    {
      query: [
        ["per_page", String(limit)],
        ["order_by", "created_at"],
        ["order_by_direction", "desc"]
      ]
    }
  );
  ensureOk(res, text);
  if (flags.json || flags.raw) return void printBody(text, { raw: flags.raw });

  const json = parseJson(text);
  const rawCount = json?.result?.length ?? 0;
  const total = json?.result_info?.total_count;
  let logs = json?.result ?? [];
  if (flags.since) {
    const cutoff = Date.now() - parseSince(flags.since);
    logs = logs.filter((l) => Date.parse(l.created_at) >= cutoff);
  }
  if (flags.model) {
    const needle = String(flags.model).toLowerCase();
    logs = logs.filter((l) => (l.model ?? "").toLowerCase().includes(needle));
  }
  if (logs.length === 0) return void out("no AI Gateway calls match");

  const byModel = {};
  let cost = 0;
  for (const l of logs) {
    byModel[l.model ?? "?"] = (byModel[l.model ?? "?"] ?? 0) + 1;
    cost += l.cost ?? 0;
  }
  const times = logs.map((l) => Date.parse(l.created_at));
  const modelStr = Object.entries(byModel)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} (${v})`)
    .join(", ");
  out(
    `${logs.length} calls${flags.since ? ` in last ${flags.since}` : ""} · $${cost.toFixed(5)} · ${modelStr}`
  );
  out(
    `${hhmmss(Math.min(...times))} → ${hhmmss(Math.max(...times))}${total != null ? `  ·  ${total} stored` : ""}`
  );
  out("");
  for (const l of logs) {
    const io = `${l.tokens_in ?? 0}→${l.tokens_out ?? 0}`.padEnd(11);
    const c = `$${(l.cost ?? 0).toFixed(5)}`.padEnd(9);
    const st = l.success ? (l.cached ? "cached" : "ok") : "FAIL";
    out(
      `${hhmmss(Date.parse(l.created_at))}  ${l.id}  ${(l.model ?? "?").padEnd(24)} ${io} ${c} ${`${l.duration ?? "?"}ms`.padEnd(8)} ${st}`
    );
  }
  if (rawCount >= limit)
    out(
      `\n⚠ hit page limit ${limit} — raise --limit or narrow --since/--model`
    );
}

async function cmdAiDetail(gw, id, flags) {
  const base = acct(`ai-gateway/gateways/${gw}/logs/${id}`);
  const meta = await request("GET", base);
  ensureOk(meta.res, meta.text);
  const reqR = await request("GET", `${base}/request`);
  ensureOk(reqR.res, reqR.text);
  const resR = await request("GET", `${base}/response`);
  ensureOk(resR.res, resR.text);

  if (flags.raw) {
    out(reqR.text);
    out("\n———\n");
    out(resR.text);
    return;
  }
  if (flags.json) {
    out(
      JSON.stringify(
        {
          meta: parseJson(meta.text)?.result ?? parseJson(meta.text),
          request: parseJson(reqR.text),
          response: parseJson(resR.text)
        },
        null,
        2
      )
    );
    return;
  }

  const max = flags.full ? Infinity : Number(flags.max ?? 1500);
  const m = parseJson(meta.text)?.result ?? {};
  const reqBody = parseJson(reqR.text) ?? {};
  const resBody = parseJson(resR.text) ?? {};
  const rule = "─".repeat(60);
  const st = m.success ? (m.cached ? "cached" : "ok") : "FAIL";
  out(
    `${m.created_at ?? "?"} · ${m.model ?? "?"} (${m.provider ?? "?"}) · ${m.tokens_in ?? 0}→${m.tokens_out ?? 0} tok · $${(m.cost ?? 0).toFixed(5)} · ${m.duration ?? "?"}ms · ${st}`
  );

  out(rule);
  const msgs = reqBody.messages;
  if (Array.isArray(msgs)) {
    out(`▶ REQUEST — ${msgs.length} message${msgs.length === 1 ? "" : "s"}`);
    for (const msg of msgs) {
      out(`\n[${msg.role}]`);
      out(truncate(messageText(msg), max));
    }
  } else {
    out("▶ REQUEST");
    out(truncate(JSON.stringify(reqBody, null, 2), max));
  }

  out(`\n${rule}`);
  const choice = resBody.choices?.[0];
  const reply = choice?.message;
  if (reply) {
    out(`◀ REPLY — finish: ${choice.finish_reason ?? "?"}`);
    out("");
    out(truncate(messageText(reply), max));
    if (reply.reasoning_content) {
      out("\n  reasoning:");
      out(`  ${truncate(reply.reasoning_content, max).replace(/\n/g, "\n  ")}`);
    }
  } else {
    out("◀ REPLY");
    out(truncate(JSON.stringify(resBody, null, 2), max));
  }
}

async function cmdRaw(args) {
  let method = "GET";
  if (METHODS.has(args[0]?.toUpperCase())) method = args.shift().toUpperCase();
  const path = args.shift();
  if (!path) die("missing <path>");
  const { flags } = parseFlags(args, {
    bool: ["--raw"],
    value: ["-d", "--data", "-q", "--query"]
  });
  // -q/--query is repeatable, but parseFlags keeps only the last; re-scan for all.
  const query = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-q" || args[i] === "--query") {
      const q = args[++i] ?? "";
      const eq = q.indexOf("=");
      if (eq === -1) die(`bad --query (expected k=v): ${q}`);
      query.push([q.slice(0, eq), q.slice(eq + 1)]);
    }
  }
  const data = flags.d ?? flags.data;
  let body;
  if (data !== undefined) {
    if (data.startsWith("@")) {
      const filename = data.slice(1);
      try {
        body = fs.readFileSync(filename, "utf8");
      } catch (err) {
        die(
          `could not read data file ${filename}: ${err?.message ?? String(err)}`
        );
      }
    } else {
      body = data;
    }
  }

  const apiPath = path.startsWith("/") ? path : acct(path);
  const { res, text } = await request(method, apiPath, { query, body });
  printBody(text, { raw: flags.raw });
  if (!res.ok) process.exit(1);
}

const argv = process.argv.slice(2);
const cmd = argv[0];

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  out(USAGE);
} else if (cmd === "verify") {
  const { res, text } = await request("GET", acct("tokens/verify"));
  printBody(text);
  if (!res.ok) process.exit(1);
} else if (cmd === "logs") {
  await cmdLogs(argv.slice(1));
} else if (cmd === "wf") {
  await cmdWf(argv.slice(1));
} else if (cmd === "ai") {
  await cmdAi(argv.slice(1));
} else if (cmd === "fields") {
  await cmdFields(argv.slice(1));
} else {
  await cmdRaw(argv);
}
