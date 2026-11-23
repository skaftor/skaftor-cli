// The CLI's credential travels in the Authorization header, never in the URL (Cloud Run logs every request URL), and only
// to an https platform (or this machine) — `npm test` (node --test). Offline: a local HTTP server records each request.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "skaftor.mjs");
const TOKEN = "t".repeat(40);
const seen = [];
let server;
const homes = [];

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const rpc = JSON.parse(body || "{}");
      seen.push({ url: req.url, authorization: req.headers.authorization, rpc });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: "tool-ok" }] } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
});
after(() => { server.close(); for (const h of homes) rmSync(h, { recursive: true, force: true }); });

function homeWith(origin) {
  const home = mkdtempSync(join(tmpdir(), "skaftor-transport-"));
  homes.push(home);
  mkdirSync(join(home, ".skaftor"));
  writeFileSync(join(home, ".skaftor", "platform.json"), JSON.stringify({ current: "p", connections: { p: { origin, projectId: "proj1", token: TOKEN, name: "p", projectName: "P" } } }));
  return home;
}
function run(args, home) {
  return new Promise((resolve) => {
    const from = seen.length;
    const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, HOME: home, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("close", (code) => resolve({ code, out, err, sent: seen.slice(from) }));
  });
}

test("the token is sent as Authorization: Bearer, and the URL carries no ?dev=", async () => {
  const r = await run(["call", "some_tool"], homeWith(`http://127.0.0.1:${server.address().port}`));
  assert.equal(r.code, 0, r.err);
  assert.ok(r.sent.length >= 1);
  for (const s of r.sent) {
    assert.equal(s.url, "/api/mcp/proj1", `no credential in the URL (${s.url})`);
    assert.equal(s.authorization, `Bearer ${TOKEN}`);
  }
});

test("a non-https platform is refused before anything is sent (this machine excepted)", async () => {
  const r = await run(["call", "some_tool"], homeWith("http://platform.example.com"));
  assert.notEqual(r.code, 0);
  assert.match(r.err, /https/);
  assert.equal(r.sent.length, 0);
});

test("login refuses a non-https link (this machine excepted)", async () => {
  const home = mkdtempSync(join(tmpdir(), "skaftor-transport-"));
  homes.push(home);
  const r = await run(["login", `http://platform.example.com/api/mcp/proj1?dev=${TOKEN}`], home);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /https/);
});

test("the version is 0.2.4, in the CLI and in package.json", async () => {
  const r = await run(["--version"], homeWith("https://app.skaftor.com"));
  assert.match(r.out, /0\.2\.4/);
  assert.equal(JSON.parse(readFileSync(join(dirname(CLI), "..", "package.json"), "utf8")).version, "0.2.4");
});
