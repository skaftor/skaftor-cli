// bin/ws.mjs — managed-workstation helpers for the skaftor CLI. Zero dependencies, Node 18+.
//
// PURE parts (unit-tested, no I/O): the command → MCP-tool mapping, usage text, the `PTY {json}`
// hand-off parser, PTY url → socket descriptor, refresh timing, and the RFC 6455 client frame codec.
// TRANSPORT: wsConnect — a minimal websocket client over node:http/https (Node 18 has no global
// WebSocket), used to bridge this terminal to a workstation's PTY with the platform's credential.
//
// Nothing here is a security control. The platform decides entitlement (the organisation's plan) and
// ownership on EVERY call; this module only shapes requests and renders results. See the platform
// repo's intent/workstation-cli-gated.
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";

// ── commands, usage, help ──────────────────────────────────────────────────────
// Infrastructure is Skaftor's business: where a workstation runs is decided by your organisation's plan.
// You may CHOOSE among the targets your plan offers (Skaftor Cloud and/or your organisation's own cloud) with
// `--on <target>`; `skaftor targets` lists them. There is still no backend to register or configure here.
export const WORKSTATION_COMMANDS = ["ws", "up", "ssh", "start", "stop", "rm", "targets", "verify"];

const USAGE = {
  ws: "skaftor ws                                    List my managed workstations and their status",
  up:
    "skaftor up [name] [--on <target>] [--repo <url>] [--branch <b>] [--agent <a>]\n" +
    "                                              Launch a managed workstation for me — returns at once; track it with `skaftor ws`.\n" +
    "                                              --on picks where it runs (see `skaftor targets`); omit it for your organisation's default",
  ssh: "skaftor ssh <name>                            Open an interactive shell in my running workstation (^D to exit)",
  start: "skaftor start <name>                          Power my workstation on",
  stop: "skaftor stop <name>                           Power my workstation off — the home volume is kept",
  rm: "skaftor rm <name> [--yes]                     Delete my workstation and its home volume (asks first unless --yes)",
  targets: "skaftor targets                               Where I can launch (Skaftor Cloud and/or my organisation's own cloud), with the default marked",
  verify: "skaftor verify                                Preflight: plan entitlement · where I can launch · connection · ready to launch",
};

/** One-line usage for a workstation command — also what `skaftor <cmd> --help` prints. */
export function usageFor(cmd) {
  const u = USAGE[cmd === "launch" ? "up" : cmd];
  return u ? `usage: ${u}` : `usage: skaftor <${WORKSTATION_COMMANDS.join("|")}> …`;
}

/** The help group, every command with a description. `bold` styles the heading like the CLI's other groups. */
export function workstationHelp(bold = (s) => s) {
  return [
    `${bold("WORKSTATIONS")} ${"(premium — needs the workstation feature on your organisation's plan)"}`,
    ...WORKSTATION_COMMANDS.map((c) => "  " + USAGE[c].replace(/^skaftor /, "").replace(/\n {46}/g, "\n" + " ".repeat(39))),
  ].join("\n");
}

// ── command → platform MCP tool ────────────────────────────────────────────────
// Tiny flag parser (mirrors the CLI's): `--k v`, `--k=v`, boolean `--flag`; the rest are positionals.
function parseFlags(argv) {
  const _ = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || String(next).startsWith("--")) flags[key] = true;
      else { flags[key] = String(next); i++; }
    } else _.push(a);
  }
  return { _, flags };
}
const str = (v) => (typeof v === "string" && v ? v : undefined);
const pick = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
const need = (cmd, v, what) => { if (!v) throw new Error(`${usageFor(cmd)}\n${what} is required`); return v; };

/**
 * Map a workstation command and its raw argv (after the command word) to the platform tool + arguments.
 * Pure. Throws an Error whose message starts with the usage line when arguments are missing/unknown.
 */
export function wsToolArgs(cmd, argv = []) {
  const { _, flags } = parseFlags(argv);
  switch (cmd) {
    case "ws": case "list":
      return { tool: "list_workstations", args: {} };
    case "targets":
      return { tool: "list_targets", args: {} };
    case "up": case "launch":
      // `--on <target>` picks WHERE among the targets the plan offers (server-decided; unknown/ungranted
      // targets are refused there). A `--backend` flag (pre-0.2.1) is still ignored.
      return { tool: "launch_workstation", args: pick({ name: str(_[0]), target: str(flags.on), repoUrl: str(flags.repo), branch: str(flags.branch), agent: str(flags.agent) }) };
    case "start": case "stop": case "rm":
      return { tool: "transition_workstation", args: { name: need(cmd, str(_[0]), "workstation name"), action: cmd === "rm" ? "delete" : cmd } };
    case "ssh":
      return { tool: "open_workstation_shell", args: { name: need(cmd, str(_[0]), "workstation name") } };
    case "verify":
      return { tool: "verify_workstation_access", args: {} };
    default:
      throw new Error(`unknown workstation command "${cmd}"`);
  }
}

// ── the PTY hand-off (open_workstation_shell / refresh_workstation_credential) ────────────────
/** Parse the trailing `PTY {json}` line the platform appends → {name, url, expiresAt, reconnect} or null. */
export function parsePtyBlock(text) {
  const line = String(text || "").split("\n").reverse().find((l) => l.startsWith("PTY "));
  if (!line) return null;
  try {
    const o = JSON.parse(line.slice(4));
    if (!o || typeof o !== "object") return null;
    const { name, url, expiresAt, reconnect } = o;
    if ([name, url, expiresAt, reconnect].some((v) => typeof v !== "string" || !v)) return null;
    return { name, url, expiresAt, reconnect };
  } catch {
    return null;
  }
}

/** PTY url (from the platform) → socket descriptor for wsConnect, with this terminal's size appended. */
export function ptyDescFromUrl(url, { cols = 80, rows = 24 } = {}) {
  const u = new URL(url);
  const secure = u.protocol === "wss:" || u.protocol === "https:";
  u.searchParams.set("height", String(rows));
  u.searchParams.set("width", String(cols));
  return { secure, hostname: u.hostname, port: Number(u.port) || (secure ? 443 : 80), path: u.pathname + u.search, headers: {} };
}

/** Refresh at ~45 min; 5 min before a shorter expiry; never sooner than 10 s; a default on garbage. */
export const REFRESH_AFTER_MS = 45 * 60_000;
export function refreshDelay(expiresAt, now = Date.now()) {
  const exp = Date.parse(expiresAt);
  if (!Number.isFinite(exp)) return REFRESH_AFTER_MS;
  return Math.max(10_000, Math.min(REFRESH_AFTER_MS, exp - now - 5 * 60_000));
}

// ── RFC 6455 client frames (masked) ────────────────────────────────────────────
export function encodeFrame(payload, opcode) {
  const len = payload.length;
  const mask = crypto.randomBytes(4);
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeUInt32BE(Math.floor(len / 2 ** 32), 2); header.writeUInt32BE(len >>> 0, 6); }
  header[0] = 0x80 | (opcode & 0x0f); // FIN + opcode
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

/** Decode one frame from `buf`: {opcode, payload, rest} — or null when the buffer holds an incomplete frame. */
export function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = buf.readUInt32BE(2) * 2 ** 32 + buf.readUInt32BE(6); off = 10; }
  let mask = null;
  if (masked) { if (buf.length < off + 4) return null; mask = buf.subarray(off, off + 4); off += 4; }
  if (buf.length < off + len) return null;
  let payload = buf.subarray(off, off + len);
  if (mask) { const out = Buffer.allocUnsafe(len); for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3]; payload = out; }
  return { opcode, payload, rest: buf.subarray(off + len) };
}

// ── transport: a minimal websocket client ──────────────────────────────────────
/**
 * Open a websocket to `desc` ({secure, hostname, port, path, headers}). The PTY protocol is Coder's
 * reconnecting-PTY: we send BINARY JSON frames {data} / {height,width}; the server sends raw bytes.
 * Returns { send(obj), close() }; a non-101 response is surfaced as an error instead of hanging.
 */
export function wsConnect(desc, { onOpen, onData, onClose }) {
  const mod = desc.secure ? https : http;
  const hostHeader = [80, 443].includes(desc.port) ? desc.hostname : `${desc.hostname}:${desc.port}`;
  const req = mod.request({
    hostname: desc.hostname, port: desc.port, path: desc.path, method: "GET",
    headers: {
      ...desc.headers, Host: hostHeader,
      Connection: "Upgrade", Upgrade: "websocket",
      "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"), "Sec-WebSocket-Version": "13",
    },
  });
  let sock = null;
  let buf = Buffer.alloc(0);
  let done = false;
  const finish = (err) => { if (done) return; done = true; if (onClose) onClose(err); };
  const api = {
    send(obj) { if (!sock || done) return; try { sock.write(encodeFrame(Buffer.from(JSON.stringify(obj), "utf8"), 0x2)); } catch { /* closing */ } },
    close() { if (sock && !done) { try { sock.write(encodeFrame(Buffer.alloc(0), 0x8)); } catch {} try { sock.end(); } catch {} } },
  };
  req.on("upgrade", (_res, socket) => {
    sock = socket;
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const fr = decodeFrame(buf);
        if (!fr) break;
        buf = fr.rest;
        if (fr.opcode === 0x8) { try { socket.end(); } catch {} return; } // close
        if (fr.opcode === 0x9) { try { socket.write(encodeFrame(fr.payload, 0xa)); } catch {} continue; } // ping → pong
        if ((fr.opcode === 0x0 || fr.opcode === 0x1 || fr.opcode === 0x2) && fr.payload.length && onData) onData(fr.payload);
      }
    });
    socket.on("close", () => finish());
    socket.on("error", (e) => finish(e));
    if (onOpen) onOpen();
  });
  // A non-101 response (credential refused/expired, workstation not running) never fires "upgrade" —
  // surface it instead of hanging.
  req.on("response", (res) => finish(new Error(`the workstation cloud refused the shell (HTTP ${res.statusCode}) — run \`skaftor ssh\` again`)));
  req.on("error", (e) => finish(e));
  req.end();
  return api;
}
