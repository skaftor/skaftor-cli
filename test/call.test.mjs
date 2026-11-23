// `skaftor call` and `skaftor up <name>` against a fake platform — `npm test` (node --test). Offline: a local HTTP
// server stands in for /api/mcp/<projectId> and records each JSON-RPC body; the CLI runs under a throwaway HOME with
// one connection to it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "skaftor.mjs");
const seen = [];
let server, home;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const rpc = JSON.parse(body);
      seen.push(rpc);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: "tool-ok" }] } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  home = mkdtempSync(join(tmpdir(), "skaftor-call-"));
  mkdirSync(join(home, ".skaftor"));
  writeFileSync(join(home, ".skaftor", "platform.json"), JSON.stringify({
    current: "p",
    connections: { p: { origin: `http://127.0.0.1:${server.address().port}`, projectId: "proj1", token: "t".repeat(40), name: "p", projectName: "P" } },
  }));
});
after(() => { server.close(); rmSync(home, { recursive: true, force: true }); });

/** Run the CLI; resolves {code, out, err, sent} with the JSON-RPC bodies this run sent. */
function run(args) {
  return new Promise((resolve) => {
    const from = seen.length;
    const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, HOME: home, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("close", (code) => resolve({ code, out, err, sent: seen.slice(from) }));
  });
}
const argsOf = (r) => r.sent.find((x) => x.method === "tools/call")?.params?.arguments;

test("call --json '<object>' sends the whole object as the arguments (nested objects, arrays of objects)", async () => {
  const nested = { feature: { id: "f1", tags: ["a", "b"] }, items: [{ code: "WO-1", files: ["x.ts"] }, { code: "WO-2", done: true, n: 3 }] };
  const r = await run(["call", "some_tool", "--json", JSON.stringify(nested)]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].params.name, "some_tool");
  assert.deepEqual(argsOf(r), nested);
  assert.equal(r.out.trim(), "tool-ok", "the formatted result, not raw JSON");
  const eq = await run(["call", "some_tool", `--json=${JSON.stringify({ a: [{ b: 1 }] })}`]);
  assert.deepEqual(argsOf(eq), { a: [{ b: 1 }] }, "--json=<object> too");
});

test("call: --k v adds keys to the --json object, typed as before; a key given both ways is refused before sending", async () => {
  assert.deepEqual(argsOf(await run(["call", "t", "--json", '{"a":{"b":1}}', "--k", "v", "--n", "3"])), { a: { b: 1 }, k: "v", n: 3 });
  const both = await run(["call", "t", "--json", '{"k":1}', "--k", "2"]);
  assert.equal(both.code, 1);
  assert.equal(both.sent.length, 0);
  assert.match(both.err, /"k"/);
  assert.deepEqual(argsOf(await run(["call", "t", "--k", "v", "--n", "-2.5", "--l", "a, b", "--flag"])), { k: "v", n: -2.5, l: ["a", "b"], flag: true }, "--k v alone is unchanged");
});

test("call: a bare --json still prints raw JSON", async () => {
  const bare = await run(["call", "t", "--json"]);
  assert.equal(bare.code, 0);
  assert.deepEqual(argsOf(bare), {});
  assert.match(bare.out, /"content"/);
  const both = await run(["call", "t", "--json", '{"a":1}', "--json"]);
  assert.deepEqual(argsOf(both), { a: 1 });
  assert.match(both.out, /"content"/);
});

test("call: --json that is not one JSON object is refused before anything is sent", async () => {
  for (const bad of [["--json", "[1,2]"], ["--json", "{oops"], ["--json", '{"a":1} trailing'], ["--json", "{}", "--json", "{}"]]) {
    const r = await run(["call", "t", ...bad]);
    assert.equal(r.code, 1, bad.join(" "));
    assert.equal(r.sent.length, 0, bad.join(" "));
  }
});

test("up <name> launches that name with no stale 'not listed until per-user identity' note (the platform's ledger attributes it)", async () => {
  const r = await run(["up", "my-box"]);
  assert.equal(r.code, 0, r.err);
  const launch = r.sent.find((x) => x.method === "tools/call");
  assert.equal(launch.params.name, "launch_workstation");
  assert.deepEqual(launch.params.arguments, { name: "my-box" });
  assert.doesNotMatch(r.err, /per-user identity|isn't listed/);
});
