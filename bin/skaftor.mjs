#!/usr/bin/env node
// skaftor — command-line client for the skaftor platform.
//
// The platform exposes a per-project JSON-RPC 2.0 MCP server at
// `<origin>/api/mcp/<projectId>?dev=<token>` — the same surface coding agents
// connect to. This CLI wraps it: you authenticate with the personal MCP link
// the app gives you ("connect your coding agent"), and drive your work orders
// from the terminal. Zero dependencies — Node 18+ built-ins only.

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { homedir, platform, release } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import { wsToolArgs, usageFor, parsePtyBlock, ptyDescFromUrl, refreshDelay, wsConnect, workstationHelp } from "./ws.mjs";

const CONFIG_DIR = join(homedir(), ".skaftor");
// The platform CLI's OWN store. The skaftor-cloud operator CLI also lives in ~/.skaftor but writes
// config.json as {url, token}; keeping this CLI in its own file means the two never clobber (or crash)
// each other. A legacy platform-shaped config.json is migrated once (see loadConfig).
const CONFIG_FILE = join(CONFIG_DIR, "platform.json");
const LEGACY_FILE = join(CONFIG_DIR, "config.json");
const VERSION = "0.2.1";

// ── styling ────────────────────────────────────────────────────────────────
const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c("1", s);
const dim = (s) => c("2", s);
const red = (s) => c("31", s);
const green = (s) => c("32", s);
const cyan = (s) => c("36", s);
const die = (msg) => { console.error(red("error: ") + msg); process.exit(1); };

// ── config store ─────────────────────────────────────────────────────────────
// A platform config is {current, connections}. Anything else (a missing/corrupt file, or the
// skaftor-cloud CLI's {url, token}) is foreign — normalize it to an empty config rather than crash.
const isPlatformShape = (o) => !!o && typeof o === "object" && typeof o.connections === "object" && o.connections !== null;
function loadConfig() {
  const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return undefined; } };
  let cfg = existsSync(CONFIG_FILE) ? readJson(CONFIG_FILE) : undefined;
  // One-time migration: adopt a legacy ~/.skaftor/config.json ONLY if it is ours (has connections);
  // the skaftor-cloud CLI uses that same name for {url, token}, which we must not adopt.
  if (!isPlatformShape(cfg) && existsSync(LEGACY_FILE)) {
    const legacy = readJson(LEGACY_FILE);
    // Persist the migration to platform.json now (once), so the login survives even before the
    // next write command and even if the skaftor-cloud CLI later overwrites config.json.
    if (isPlatformShape(legacy)) { cfg = legacy; saveConfig(cfg); }
  }
  if (!isPlatformShape(cfg)) return { current: null, connections: {} };
  if (typeof cfg.current === "undefined") cfg.current = null;
  return cfg;
}
function saveConfig(cfg) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  try { chmodSync(CONFIG_FILE, 0o600); } catch {} // tokens live here
}
function currentConn(cfg) {
  const conn = cfg.connections[cfg.current];
  if (!conn) die("not logged in — run `skaftor login <personal-mcp-url>` (get the URL from the app's \"connect your coding agent\" button)");
  return conn;
}

// Parse a personal MCP url → { origin, projectId, token }.
function parseMcpUrl(url) {
  let u;
  try { u = new URL(url); } catch { die("that doesn't look like a URL — paste the full personal MCP link from the app"); }
  const m = u.pathname.match(/\/api\/mcp\/([^/]+)/);
  const token = u.searchParams.get("dev");
  if (!m || !token) die("URL must look like https://app.skaftor.com/api/mcp/<projectId>?dev=<token>");
  return { origin: u.origin, projectId: m[1], token };
}

// ── JSON-RPC transport ───────────────────────────────────────────────────────
let RPC_ID = 0;
async function rpc(conn, method, params, { soft = false } = {}) {
  const url = `${conn.origin}/api/mcp/${conn.projectId}?dev=${conn.token}`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++RPC_ID, method, params }),
    });
  } catch (e) {
    const msg = `could not reach ${conn.origin} — is the platform up and the URL right? (${e.message})`;
    if (soft) return { error: msg };
    die(msg);
  }
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch {
    const msg = `unexpected response from server (HTTP ${res.status}): ${text.slice(0, 200)}`;
    if (soft) return { error: msg };
    die(msg);
  }
  if (body.error) {
    const msg = `${body.error.message}${body.error.code ? dim(` (code ${body.error.code})`) : ""}`;
    if (soft) return { error: msg };
    die(msg);
  }
  return body.result;
}
async function callTool(conn, name, args) {
  const result = await rpc(conn, "tools/call", { name, arguments: args || {} });
  return result;
}
// Like callTool, but never exits the process: returns { error } on transport/RPC failure. Used
// mid-session (the ssh credential refresh) where dying would kill the user's shell abruptly.
async function callToolSoft(conn, name, args) {
  return rpc(conn, "tools/call", { name, arguments: args || {} }, { soft: true });
}
const toolText = (result) => (result?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
// Print a tools/call result: the text content, or raw JSON with --json.
function printToolResult(result, json) {
  if (json) return console.log(JSON.stringify(result, null, 2));
  const text = (result?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  if (result?.isError) { console.error(red(text || "tool reported an error")); process.exit(1); }
  console.log(text || dim("(no output)"));
}

// ── managed workstations (premium) ─────────────────────────────────────────
// Everything here only RENDERS what the platform decides. The platform checks the organisation's
// plan entitlement and the developer's ownership on every call — this public CLI holds no secret
// and enforces nothing, by design (see intent/workstation-cli-gated in the platform repo).

// y/N prompt — a convenience, not a control: the server enforces ownership regardless.
function confirm(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve(false);
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (a) => { rl.close(); resolve(/^y(es)?$/i.test(String(a).trim())); });
  });
}

// `skaftor ssh <name>` — the platform issues a 1-hour, single-workstation PTY credential (after ITS
// entitlement + ownership checks); we bridge this terminal to that websocket and, at ~45 min, ask the
// platform for a fresh credential with the SAME reconnect id (Coder resumes the shell). A refused
// refresh means the organisation lost the feature: we print the server's message and the session
// ends at the credential's expiry. No secret of the platform's ever reaches this process.
async function sshWorkstation(conn, name, json) {
  const open = await callTool(conn, "open_workstation_shell", { name });
  const text = toolText(open);
  if (open?.isError) die(text || "could not open a shell");
  const first = parsePtyBlock(text);
  if (!first) die("the platform did not return a shell credential");
  if (json) return console.log(JSON.stringify(first, null, 2));

  const isTty = !!(process.stdin.isTTY && process.stdout.isTTY);
  const size = () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
  let handoff = first;
  let ws = null;
  let gen = 0;          // which socket is current — a superseded socket's close is ignored
  let timer = null;
  let restored = false;
  const onResize = () => { const s = size(); if (ws) ws.send({ height: s.rows, width: s.cols }); };
  const restore = () => {
    if (restored) return; restored = true;
    if (timer) clearTimeout(timer);
    try { if (isTty) process.stdin.setRawMode(false); } catch {}
    try { process.stdin.pause(); } catch {}
    process.removeListener("SIGWINCH", onResize);
  };
  const scheduleRefresh = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      const r = await callToolSoft(conn, "refresh_workstation_credential", { name, reconnect: handoff.reconnect });
      const t = r?.error ? r.error : toolText(r);
      const next = r?.error || r?.isError ? null : parsePtyBlock(t);
      if (!next) {
        console.error(red(`\n[skaftor] credential refresh refused: ${t || "unknown"} — this session ends at ${handoff.expiresAt}`));
        return;
      }
      handoff = next;
      connect(false); // opens a new socket; stdin switches to it only once it is OPEN, then the old one is retired
    }, refreshDelay(handoff.expiresAt));
  };
  const connect = (isFirst) => {
    const prevGen = gen;
    const my = ++gen;
    let opened = false;
    const { cols, rows } = size();
    const prev = ws;
    const next = wsConnect(ptyDescFromUrl(handoff.url, { cols, rows }), {
      onOpen: () => {
        opened = true;
        ws = next;                               // stdin now goes to the new socket — nothing typed in the gap is lost
        if (prev && prev !== next) prev.close(); // retire the old one (its close is ignored: its generation is stale)
        next.send({ height: rows, width: cols });
        if (isFirst) {
          if (isTty) { try { process.stdin.setRawMode(true); } catch {} }
          process.stdin.resume();
          process.stdin.on("data", (chunk) => { if (ws) ws.send({ data: chunk.toString("utf8") }); });
          process.stdin.on("end", () => { if (ws) ws.send({ data: "\x04" }); }); // EOF: let the remote shell exit
          if (isTty) process.on("SIGWINCH", onResize);
          console.error(dim(`connected to ${bold(name)} — ^D to exit`));
        }
        scheduleRefresh();
      },
      onData: (b) => process.stdout.write(b),
      onClose: (err) => {
        if (my !== gen) return; // a retired socket
        if (!opened && !isFirst) {
          // The renewed connection never opened: keep the live session (it still ends at its own expiry).
          gen = prevGen; // …so the old socket's eventual close is honoured again
          console.error(red(`\n[skaftor] could not reconnect with the renewed credential${err ? ` (${err.message})` : ""} — keeping this session until it expires`));
          return;
        }
        restore();
        if (err) { console.error(red(`\n${err.message}`)); process.exit(1); }
        process.stdout.write("\n");
        process.exit(0);
      },
    });
    if (isFirst) ws = next;
  };
  connect(true);
  process.on("exit", restore);
}

// ── arg parsing ────────────────────────────────────────────────────────────
// Returns { _: [positionals], flags: { key: value|true } }. Supports
// `--key value`, `--key=value`, and boolean `--flag`.
function parseArgs(argv) {
  const _ = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); }
      else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) flags[key] = true;
        else { flags[key] = next; i++; }
      }
    } else _.push(a);
  }
  return { _, flags };
}
const asString = (v, name) => { if (v === undefined) die(`missing required argument: ${name}`); return String(v); };

// ── environment detection (for `env` / `done` defaults) ──────────────────────
function detectOS() {
  const p = platform();
  if (p === "darwin") return `macOS (${release()})`;
  if (p === "win32") return `Windows (${release()})`;
  return `${p} ${release()}`;
}

// ── commands ─────────────────────────────────────────────────────────────────
const HELP = `${bold("skaftor")} ${dim("v" + VERSION)} — drive your platform work orders from the terminal

${bold("USAGE")}
  skaftor <command> [options]

${bold("AUTH")}
  login <mcp-url>          Connect using your personal MCP link from the app
  logout [--all]           Forget the current connection (or all)
  use <name>               Switch the active project connection
  context                  List connections and show the active one
  whoami                   Show who you're connected as

${bold("WORK ORDERS")}
  wo list [--status s] [--phase p]     List the project's work orders
  wo next                              The recommended next task for you
  wo mine                              Work orders assigned to you
  wo show <code>                       Full detail for one work order
  wo plan <code>                       Decision-engine plan (repo, files, impact)
  wo manifest <code>                   Full execution manifest in one payload
  wo start <code> [--branch b]         Mark In Progress
  wo done <code> --pr <url> [...]      Mark done with a PR (see \`skaftor wo done --help\`)
  wo ask <code> <question>             Ask the team a clarifying question
  wo sync <code> [...]                 Report local commit progress

${workstationHelp(bold)}

${bold("DELIVERY")}
  pr <code>                Prepare / open the pull request for a work order
  env [--name --model --editor --os]   Register your working environment

${bold("ADVANCED")}
  tools                    List every tool the server exposes
  call <tool> [--k v ...]  Call any tool directly

${bold("GLOBAL")}
  --json                   Print raw JSON instead of formatted text
  --help, -h               Show help    •    --version, -v   Show version

${dim("Get your personal MCP link from the app: open a project → a work order → Execute /")}
${dim("\"connect your coding agent\", and copy the URL. Then: skaftor login <that-url>")}`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") { console.log(HELP); return; }
  if (argv[0] === "--version" || argv[0] === "-v") { console.log(VERSION); return; }

  const cmd = argv[0];
  const sub = argv[1];
  const { _, flags } = parseArgs(argv.slice(1));
  const json = !!flags.json;
  const cfg = loadConfig();

  switch (cmd) {
    // ── auth ────────────────────────────────────────────────────────────────
    case "login":
    case "connect": {
      const url = _[0];
      if (!url) die("usage: skaftor login <personal-mcp-url>");
      const conn = parseMcpUrl(url);
      // verify + capture the project name via the MCP initialize handshake
      const info = await rpc(conn, "initialize", {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "skaftor-cli", version: VERSION },
        capabilities: {},
      });
      const projectName = info?.project?.name || info?.serverInfo?.title?.replace(/^skaftorAI · /, "") || conn.projectId;
      const name = flags.name ? String(flags.name) : projectName;
      cfg.connections[name] = { ...conn, name, projectName };
      cfg.current = name;
      saveConfig(cfg);
      console.log(green("✓") + ` connected to ${bold(projectName)} ${dim("(" + conn.origin + ")")}`);
      console.log(dim(`saved as "${name}" — this is now the active project. Try: skaftor wo next`));
      return;
    }
    case "logout": {
      if (flags.all) { saveConfig({ current: null, connections: {} }); console.log("forgot all connections"); return; }
      if (!cfg.current) die("no active connection");
      const gone = cfg.current;
      delete cfg.connections[gone];
      cfg.current = Object.keys(cfg.connections)[0] || null;
      saveConfig(cfg);
      console.log(`forgot ${bold(gone)}` + (cfg.current ? dim(` — active is now "${cfg.current}"`) : ""));
      return;
    }
    case "use": {
      const name = _[0];
      if (!name) die("usage: skaftor use <name>  (see `skaftor context`)");
      if (!cfg.connections[name]) die(`no connection named "${name}" — run \`skaftor context\` to list them`);
      cfg.current = name; saveConfig(cfg);
      console.log(green("✓") + ` active project is now ${bold(name)}`);
      return;
    }
    case "context": {
      const names = Object.keys(cfg.connections);
      if (!names.length) { console.log(dim("no connections — run `skaftor login <mcp-url>`")); return; }
      for (const n of names) {
        const conn = cfg.connections[n];
        const marker = n === cfg.current ? green("● ") : "  ";
        console.log(`${marker}${bold(n)}  ${dim(conn.origin + " · " + conn.projectId)}`);
      }
      return;
    }
    case "whoami": {
      const conn = currentConn(cfg);
      const info = await rpc(conn, "initialize", { protocolVersion: "2024-11-05", clientInfo: { name: "skaftor-cli", version: VERSION }, capabilities: {} });
      if (json) return console.log(JSON.stringify({ connection: conn, serverInfo: info?.serverInfo, instructions: info?.instructions }, null, 2));
      console.log(`${bold(conn.projectName || conn.projectId)}  ${dim(conn.origin)}`);
      if (info?.serverInfo?.name) console.log(dim(`server: ${info.serverInfo.name} ${info.serverInfo.version || ""}`));
      return;
    }

    // ── work orders ───────────────────────────────────────────────────────────
    case "wo": {
      const conn = currentConn(cfg);
      const rest = parseArgs(argv.slice(2)); // args after `wo <sub>`
      const code = () => asString(rest._[0], "work order code (e.g. WO-01)");
      switch (sub) {
        case "list": return printToolResult(await callTool(conn, "list_work_orders", {
          ...(rest.flags.status ? { status: String(rest.flags.status) } : {}),
          ...(rest.flags.phase ? { phase: String(rest.flags.phase) } : {}),
        }), json);
        case "next": return printToolResult(await callTool(conn, "next_work_order", {}), json);
        case "mine": return printToolResult(await callTool(conn, "my_work_orders", {}), json);
        case "show": case "get": return printToolResult(await callTool(conn, "get_work_order", { code: code() }), json);
        case "plan": return printToolResult(await callTool(conn, "plan_work_order", { code: code() }), json);
        case "manifest": return printToolResult(await callTool(conn, "get_execution_manifest", { code: code() }), json);
        case "start": return printToolResult(await callTool(conn, "start_work_order", {
          code: code(), ...(rest.flags.branch ? { branch: String(rest.flags.branch) } : {}),
        }), json);
        case "done": case "complete": {
          if (rest.flags.help) { console.log("usage: skaftor wo done <code> --pr <url> [--summary s] [--branch b] [--model m] [--ide i] [--tokens n]"); return; }
          const args = { code: code(), prUrl: asString(rest.flags.pr, "--pr <url>") };
          if (rest.flags.summary) args.summary = String(rest.flags.summary);
          if (rest.flags.branch) args.branch = String(rest.flags.branch);
          if (rest.flags.model) args.model = String(rest.flags.model);
          if (rest.flags.ide) args.ide = String(rest.flags.ide);
          if (rest.flags.tokens) args.tokensUsed = Number(rest.flags.tokens);
          return printToolResult(await callTool(conn, "complete_work_order", args), json);
        }
        case "ask": {
          const question = rest._.slice(1).join(" ") || (rest.flags.question ? String(rest.flags.question) : "");
          if (!question) die("usage: skaftor wo ask <code> <question>");
          return printToolResult(await callTool(conn, "ask_about_work_order", { code: code(), question }), json);
        }
        case "sync": {
          const args = { code: code() };
          for (const [k, dst] of [["branch", "branch"], ["commit", "commitHash"], ["message", "commitMessage"], ["status", "status"]])
            if (rest.flags[k]) args[dst] = String(rest.flags[k]);
          if (rest.flags.count) args.commitCount = Number(rest.flags.count);
          if (rest.flags.files) args.files = String(rest.flags.files).split(",").map((s) => s.trim()).filter(Boolean);
          return printToolResult(await callTool(conn, "sync_execution", args), json);
        }
        default: die(`unknown work-order command "${sub || ""}". See \`skaftor --help\``);
      }
      return;
    }

    // ── managed workstations (premium — the platform decides; this CLI only renders) ────────
    case "ws": case "up": case "launch": case "start": case "stop": case "rm": case "verify": case "ssh": {
      if (flags.help) { console.log(usageFor(cmd)); return; }
      let call;
      try { call = wsToolArgs(cmd, argv.slice(1)); } catch (e) { die(e.message); }
      const conn = currentConn(cfg);
      if (cmd === "rm" && !flags.yes) {
        const ok = await confirm(`Delete workstation ${bold(call.args.name)} and its home volume? [y/N] `);
        if (!ok) { console.log(dim("cancelled")); return; }
      }
      if (cmd === "ssh") return sshWorkstation(conn, call.args.name, json);
      if ((cmd === "up" || cmd === "launch") && call.args.name)
        console.error(dim("note: a custom name isn't listed or ssh-able until per-user identity lands — omit the name to get an auto-attributed one"));
      return printToolResult(await callTool(conn, call.tool, call.args), json);
    }

    // ── delivery ────────────────────────────────────────────────────────────
    case "pr": {
      const conn = currentConn(cfg);
      return printToolResult(await callTool(conn, "prepare_pull_request", { code: asString(_[0], "work order code") }), json);
    }
    case "env": {
      const conn = currentConn(cfg);
      const args = {
        os: flags.os ? String(flags.os) : detectOS(),
        ...(flags.name ? { developerName: String(flags.name) } : {}),
        ...(flags.model ? { model: String(flags.model) } : {}),
        editor: flags.editor ? String(flags.editor) : "skaftor CLI",
      };
      return printToolResult(await callTool(conn, "register_environment", args), json);
    }

    // ── advanced ──────────────────────────────────────────────────────────────
    case "tools": {
      const conn = currentConn(cfg);
      const result = await rpc(conn, "tools/list", {});
      if (json) return console.log(JSON.stringify(result, null, 2));
      for (const t of result?.tools || []) console.log(`${bold(cyan(t.name))}\n  ${dim(t.description || "")}`);
      return;
    }
    case "call": {
      const conn = currentConn(cfg);
      const tool = _[0];
      if (!tool) die("usage: skaftor call <tool> [--key value ...]  (see `skaftor tools`)");
      const args = {};
      for (const [k, v] of Object.entries(flags)) {
        if (k === "json") continue;
        // numbers/booleans stay typed; comma lists become arrays
        if (typeof v === "boolean") args[k] = v;
        else if (/^-?\d+(\.\d+)?$/.test(v)) args[k] = Number(v);
        else if (v.includes(",")) args[k] = v.split(",").map((s) => s.trim());
        else args[k] = v;
      }
      return printToolResult(await callTool(conn, tool, args), json);
    }

    default:
      die(`unknown command "${cmd}". Run \`skaftor --help\``);
  }
}

main().catch((e) => die(e?.stack || e?.message || String(e)));
