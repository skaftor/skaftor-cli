import { test } from "node:test";
import assert from "node:assert/strict";
import { runRepos } from "../bin/repos.mjs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("real CLI maps flags and exits nonzero on a JSON refusal", { timeout: 10000 }, async () => {
  const calls = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const body = JSON.parse(raw); calls.push(body.params);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: '{"refused":true,"nextAction":"Ask your Admin to add storage"}' }] } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const home = mkdtempSync(join(tmpdir(), "skaftor-repos-cli-"));
  try {
    mkdirSync(join(home, ".skaftor"));
    writeFileSync(join(home, ".skaftor/platform.json"), JSON.stringify({ current: "test", connections: { test: { origin: `http://127.0.0.1:${server.address().port}`, projectId: "p", token: "offline-test" } } }));
    const run = (args) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [new URL("../bin/skaftor.mjs", import.meta.url).pathname, ...args], { env: { ...process.env, HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (x) => { out += x; }); child.stderr.on("data", (x) => { out += x; });
      child.on("error", reject); child.on("close", (code) => resolve({ code, out }));
    });
    const r = await run(["repos", "track", "--json", "acme/api"]);
    assert.equal(r.code, 1, r.out);
    assert.equal(JSON.parse(r.out).isError, true);
    assert.match(r.out, /nextAction/);
    assert.deepEqual(calls, [{ name: "repos_track", arguments: { name: "acme/api" } }]);
    const extra = await run(["repos", "track", "acme/api", "--json", "other/repo"]);
    assert.equal(extra.code, 1); assert.match(extra.out, /usage/); assert.equal(calls.length, 1);
    const list = await run(["repos", "ls", "--json", "--tier=lazy", "--page", "2"]);
    assert.equal(list.code, 1);
    assert.deepEqual(calls[1], { name: "repos_list", arguments: { tier: "lazy", page: 2 } });
  } finally {
    rmSync(home, { recursive: true, force: true });
    await new Promise((r) => server.close(r));
  }
});

function harness() {
  const calls = [], prints = [];
  const result = { content: [{ type: "text", text: '{"rows":[],"more":true}' }] };
  const conn = { projectId: "project-test" };
  return { calls, prints, result, deps: {
    conn,
    callTool: async (...args) => { calls.push(args); return result; },
    printToolResult: (r, json) => { prints.push({ r, json }); },
  } };
}

test("repos ls calls repos_list on the current project, without inventing filters", async () => {
  const h = harness();
  await runRepos("ls", [], {}, h.deps);
  assert.deepEqual(h.calls, [[h.deps.conn, "repos_list", {}]]);
  assert.deepEqual(h.prints, [{ r: h.result, json: false }]);
});

test("repos ls maps tier and page, preserving --json and the server pagination result", async () => {
  const h = harness();
  await runRepos("ls", [], { tier: "lazy", page: "2", json: true }, h.deps);
  assert.deepEqual(h.calls, [[h.deps.conn, "repos_list", { tier: "lazy", page: 2 }]]);
  assert.deepEqual(h.prints, [{ r: h.result, json: true }]);
});

test("repos track forwards the exact name and renders the server's refusal and nextAction", async () => {
  const h = harness();
  h.result.isError = true;
  h.result.content[0].text = '{"refused":true,"reason":"over_allowance","nextAction":"Ask your Admin to add storage"}';
  await runRepos("track", ["gitlab:acme/api"], {}, h.deps);
  assert.deepEqual(h.calls, [[h.deps.conn, "repos_track", { name: "gitlab:acme/api" }]]);
  assert.equal(h.prints[0].r, h.result);
  assert.match(h.prints[0].r.content[0].text, /nextAction/);
});

test("invalid or ambiguous arguments never reach MCP", async () => {
  for (const [sub, rest, flags] of [
    ["track", [], {}], ["track", ["a/b", "c/d"], {}], ["track", ["a/b"], { tier: "active" }],
    ["ls", ["a/b"], {}], ["ls", [], { tier: true }], ["ls", [], { tier: "typo" }],
    ["ls", [], { page: true }], ["ls", [], { page: "0" }], ["ls", [], { page: "2.5" }],
    ["ls", [], { page: "101" }], ["ls", [], { unknowntypo: true }], ["delete", ["a/b"], {}],
  ]) {
    const h = harness();
    await assert.rejects(() => runRepos(sub, rest, flags, h.deps), /usage|Unknown|must be/);
    assert.equal(h.calls.length, 0);
  }
});
