// skaftor CLI tests — `npm test` (node --test). Zero-dep, offline: no platform, no network.
//
// Two layers: (1) pure helpers from bin/ws.mjs (command → MCP tool mapping, PTY hand-off parsing,
// PTY url → socket descriptor, refresh timing, the websocket frame codec); (2) the real CLI spawned
// under a throwaway HOME (help coverage, per-command --help, config-store shape + migration).
// Nothing here is a security control — those live on the platform — this locks the CLI's behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  wsToolArgs, usageFor, parsePtyBlock, ptyDescFromUrl, refreshDelay, encodeFrame, decodeFrame, WORKSTATION_COMMANDS,
} from "../bin/ws.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "bin", "skaftor.mjs");

/** Run the CLI with a throwaway HOME whose ~/.skaftor holds `files`; returns {code, out, home}. Caller cleans up. */
function run(args, files = {}) {
  const home = mkdtempSync(join(tmpdir(), "skaftor-cli-"));
  mkdirSync(join(home, ".skaftor"), { recursive: true });
  for (const [n, body] of Object.entries(files)) writeFileSync(join(home, ".skaftor", n), typeof body === "string" ? body : JSON.stringify(body));
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], { env: { ...process.env, HOME: home, NO_COLOR: "1" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out, home };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}`, home };
  }
}
const clean = (r) => rmSync(r.home, { recursive: true, force: true });

// ---------- (1) pure: command → MCP tool ----------
test("ws / ws list → list_workstations", () => {
  assert.deepEqual(wsToolArgs("ws", []), { tool: "list_workstations", args: {} });
  assert.deepEqual(wsToolArgs("ws", ["list"]), { tool: "list_workstations", args: {} });
});

test("up maps every flag; name optional; unknown flags ignored", () => {
  assert.deepEqual(wsToolArgs("up", ["--backend", "b1", "--repo", "bitbucket.org/x/y", "--branch", "feat/z", "--agent", "claude"]), {
    tool: "launch_workstation", args: { backend: "b1", repoUrl: "bitbucket.org/x/y", branch: "feat/z", agent: "claude" },
  });
  assert.deepEqual(wsToolArgs("up", ["my-ws", "--agent=codex"]), { tool: "launch_workstation", args: { name: "my-ws", agent: "codex" } });
  assert.deepEqual(wsToolArgs("launch", []), { tool: "launch_workstation", args: {} });
});

test("start / stop / rm → transition_workstation with the right action; rm is delete", () => {
  assert.deepEqual(wsToolArgs("start", ["ws-bob-1"]), { tool: "transition_workstation", args: { name: "ws-bob-1", action: "start" } });
  assert.deepEqual(wsToolArgs("stop", ["ws-bob-1"]), { tool: "transition_workstation", args: { name: "ws-bob-1", action: "stop" } });
  assert.deepEqual(wsToolArgs("rm", ["ws-bob-1", "--yes"]), { tool: "transition_workstation", args: { name: "ws-bob-1", action: "delete" } });
  for (const c of ["start", "stop", "rm", "ssh"]) assert.throws(() => wsToolArgs(c, []), /usage/);
});

test("ssh → open_workstation_shell; verify / backend → the preflight and backend tools", () => {
  assert.deepEqual(wsToolArgs("ssh", ["ws-bob-1"]), { tool: "open_workstation_shell", args: { name: "ws-bob-1" } });
  assert.deepEqual(wsToolArgs("verify", []), { tool: "verify_workstation_access", args: {} });
  assert.deepEqual(wsToolArgs("verify", ["--backend", "b1"]), { tool: "verify_workstation_access", args: { backend: "b1" } });
  assert.deepEqual(wsToolArgs("backend", ["list"]), { tool: "list_backends", args: {} });
  assert.deepEqual(wsToolArgs("backend", []), { tool: "list_backends", args: {} });
  assert.deepEqual(wsToolArgs("backend", ["verify", "b1"]), { tool: "verify_workstation_access", args: { backend: "b1" } });
  assert.deepEqual(wsToolArgs("backend", ["verify"]), { tool: "verify_workstation_access", args: {} });
  assert.throws(() => wsToolArgs("backend", ["frobnicate"]), /usage/);
  assert.throws(() => wsToolArgs("nonsense", []), /unknown/);
});

test("every workstation command has a usage line", () => {
  for (const c of WORKSTATION_COMMANDS) assert.match(usageFor(c), new RegExp(`skaftor ${c}`));
});

// ---------- (1) pure: PTY hand-off ----------
const handoff = { name: "ws-bob-1", url: "wss://sc.example.com/api/v2/workspaceagents/agent-1/pty?pty=gid.sig&reconnect=r-1", expiresAt: "2026-09-10T10:00:00.000Z", reconnect: "r-1" };

test("parsePtyBlock extracts the trailing PTY {json} line", () => {
  const text = `Shell credential issued (valid until …). Connect below.\n\nPTY ${JSON.stringify(handoff)}`;
  assert.deepEqual(parsePtyBlock(text), handoff);
});

test("parsePtyBlock is null without a PTY line, or with malformed / incomplete json", () => {
  assert.equal(parsePtyBlock("Workstation feature is not enabled for your organisation — upgrade on dev.skaftor.com."), null);
  assert.equal(parsePtyBlock("PTY {not json"), null);
  assert.equal(parsePtyBlock(`PTY ${JSON.stringify({ name: "x" })}`), null);
  assert.equal(parsePtyBlock(""), null);
});

test("ptyDescFromUrl → socket descriptor; appends the terminal size; wss→443, ws→explicit port", () => {
  const d = ptyDescFromUrl(handoff.url, { cols: 120, rows: 40 });
  assert.equal(d.secure, true);
  assert.equal(d.hostname, "sc.example.com");
  assert.equal(d.port, 443);
  assert.match(d.path, /^\/api\/v2\/workspaceagents\/agent-1\/pty\?/);
  assert.match(d.path, /pty=gid\.sig/);
  assert.match(d.path, /reconnect=r-1/);
  assert.match(d.path, /height=40/);
  assert.match(d.path, /width=120/);
  const d2 = ptyDescFromUrl("ws://localhost:3112/api/v2/workspaceagents/a/pty?pty=t&reconnect=r", { cols: 80, rows: 24 });
  assert.equal(d2.secure, false);
  assert.equal(d2.port, 3112);
});

test("refreshDelay: 45 min normally, 5 min before a short expiry, never below 10 s, sane on garbage", () => {
  const now = Date.parse("2026-09-10T09:00:00.000Z");
  assert.equal(refreshDelay("2026-09-10T10:00:00.000Z", now), 45 * 60_000);
  assert.equal(refreshDelay("2026-09-10T09:10:00.000Z", now), 5 * 60_000);
  assert.equal(refreshDelay("2026-09-10T09:01:00.000Z", now), 10_000);
  assert.equal(refreshDelay("not-a-date", now), 45 * 60_000);
});

// ---------- (1) pure: websocket frame codec (RFC 6455, client side) ----------
test("encodeFrame/decodeFrame roundtrip (masked binary), and partial buffers wait", () => {
  const fr = decodeFrame(encodeFrame(Buffer.from('{"data":"ls\\n"}', "utf8"), 0x2));
  assert.equal(fr.opcode, 0x2);
  assert.equal(fr.payload.toString("utf8"), '{"data":"ls\\n"}');
  assert.equal(fr.rest.length, 0);
  assert.equal(decodeFrame(Buffer.from([0x82])), null);
  const big = encodeFrame(Buffer.alloc(70_000, 1), 0x2);
  assert.equal(decodeFrame(big).payload.length, 70_000);
});

// ---------- (2) spawned CLI: help coverage + per-command --help ----------
test("skaftor --help lists every workstation command", () => {
  const r = run(["--help"]);
  try {
    assert.equal(r.code, 0);
    for (const c of WORKSTATION_COMMANDS) assert.match(r.out, new RegExp(`(^|\\s)${c}\\b`, "m"), `help mentions '${c}'`);
    assert.match(r.out, /WORKSTATIONS/);
  } finally { clean(r); }
});

test("each workstation command answers --help with exit 0 even when not logged in", () => {
  for (const c of WORKSTATION_COMMANDS) {
    const r = run([c, "--help"]);
    try {
      assert.equal(r.code, 0, `${c} --help exit code (${r.out.slice(0, 120)})`);
      assert.match(r.out, /usage/i, `${c} --help prints usage`);
    } finally { clean(r); }
  }
});

// ---------- (2) spawned CLI: config store — platform.json, never crash on the other CLI's file ----------
const plat = { current: "proj", connections: { proj: { origin: "https://dev.skaftor.com", projectId: "p1", token: "t", name: "proj", projectName: "Proj" } } };

test("a foreign {url,token} config.json (the skaftor-cloud CLI's) never crashes the platform CLI", () => {
  const r = run(["context"], { "config.json": { url: "http://localhost:7081", token: "x".repeat(33) } });
  try {
    assert.equal(r.code, 0);
    assert.match(r.out, /no connections/i);
    assert.doesNotMatch(r.out, /TypeError|Cannot (convert|read|set)/);
  } finally { clean(r); }
});

test("platform.json is the store; a legacy platform-shaped config.json is migrated and persisted", () => {
  const a = run(["context"], { "platform.json": plat });
  try { assert.equal(a.code, 0); assert.match(a.out, /proj/); } finally { clean(a); }
  const b = run(["context"], { "config.json": plat });
  try {
    assert.equal(b.code, 0);
    assert.match(b.out, /proj/);
    assert.ok(existsSync(join(b.home, ".skaftor", "platform.json")), "migration persisted to platform.json");
  } finally { clean(b); }
});
