// `skaftor operator` — the BYOC install commands (intent/operator-byoc 5c). Every tool (helm, kubectl, gcloud) and
// Skaftor Cloud are fakes that record what they were asked: the rules are tested without a cluster.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { enroll, install, upgrade, helmArgs, clusterFlags, preflight, readSecretKeys, writeSecrets, DEFAULT_CLOUD } from "../bin/operator.mjs";

function fakes({ existing = {}, enrollAnswer = { operatorId: "op_1", orgId: "org_1", fingerprint: "AAAA" }, enrollStatus = 200, canI = "yes", helmFails = false, tools = true } = {}) {
  const calls = [];
  let state = null;
  const secret = { ...existing };
  const d = {
    calls,
    secret,
    get state() { return state; },
    exec: async (cmd, args, opt = {}) => {
      calls.push({ cmd, args, input: opt.input });
      if (!tools && (args[0] === "version")) throw new Error("not found");
      if (cmd === "kubectl" && args.includes("get") && args.includes("secret")) {
        if (!Object.keys(secret).length) return { code: 1, out: "", err: "NotFound" };
        return { code: 0, out: JSON.stringify({ data: Object.fromEntries(Object.entries(secret).map(([k, v]) => [k, Buffer.from(v).toString("base64")])) }) };
      }
      if (cmd === "kubectl" && args.includes("apply")) {
        const m = JSON.parse(opt.input);
        for (const [k, v] of Object.entries(m.data)) secret[k] = Buffer.from(v, "base64").toString("utf8");
        return { code: 0, out: "" };
      }
      if (cmd === "helm" && args[0] === "status") return { code: existing.SKAFTOR_OPERATOR_KEY ? 0 : 1, out: "" };
      if (cmd === "kubectl" && args.includes("can-i")) return { code: 0, out: `${canI}\n` };
      if (cmd === "kubectl" && args.includes("pods")) return { code: 0, out: "pod/op-old\npod/op-new\n" };
      if (cmd === "kubectl" && args.includes("logs")) return { code: 0, out: "You are about to drop the column `x`\nUse the --accept-data-loss flag" };
      if (cmd === "helm" && args[0] === "upgrade" && helmFails) throw new Error("helm upgrade failed: timed out waiting for the condition");
      if (cmd === "gcloud" && args[0] === "secrets" && args[1] === "versions" && args[2] === "access") {
        const name = args.find((a) => a.startsWith("--secret=")).slice(9);
        const k = { "skaftor-operator-key": "SKAFTOR_OPERATOR_KEY", "skaftor-operator-cred-enc-key": "CRED_ENC_KEY", "skaftor-operator-postgres-password": "POSTGRES_PASSWORD" }[name];
        return secret[k] ? { code: 0, out: secret[k] } : { code: 1, out: "" };
      }
      if (cmd === "gcloud" && args[1] === "describe") return { code: 1, out: "" };
      if (cmd === "gcloud" && args[1] === "versions" && args[2] === "add") {
        const name = args[3];
        const k = { "skaftor-operator-key": "SKAFTOR_OPERATOR_KEY", "skaftor-operator-cred-enc-key": "CRED_ENC_KEY", "skaftor-operator-postgres-password": "POSTGRES_PASSWORD" }[name];
        secret[k] = opt.input;
      }
      return { code: 0, out: "" };
    },
    fetch: async (url, init) => {
      calls.push({ cmd: "fetch", url, body: init.body });
      return { ok: enrollStatus === 200, status: enrollStatus, json: async () => (enrollStatus === 200 ? enrollAnswer : { error: "that code is no longer valid" }) };
    },
    keyPair: () => generateKeyPairSync("ed25519"),
    random: (n) => "r".repeat(n),
    loadState: () => state,
    saveState: (s) => { state = s; },
    readSecretKeys,
    writeSecrets,
  };
  return d;
}

const CTX = { "kube-context": "kind-skaftor-op" };
const argvOf = (d) => d.calls.filter((c) => c.cmd !== "fetch").flatMap((c) => c.args).join(" ");

test("every command names its cluster; the current context is never assumed", () => {
  assert.throws(() => clusterFlags({}, "kubectl"), /--kube-context <context> or --kubeconfig/);
  assert.deepEqual(clusterFlags(CTX, "kubectl"), ["--context", "kind-skaftor-op"]);
  assert.deepEqual(clusterFlags(CTX, "helm"), ["--kube-context", "kind-skaftor-op"]);
  assert.deepEqual(clusterFlags({ kubeconfig: "/tmp/k" }, "helm"), ["--kubeconfig", "/tmp/k"]);
});

test("enroll: without a named cluster, nothing is made and Skaftor Cloud is not called", async () => {
  const d = fakes();
  await assert.rejects(enroll(d, "CODE", { address: "https://op.example.com" }), /--kube-context/);
  assert.equal(d.calls.length, 0);
});

test("enroll: an http address (not localhost) is refused — browsers reach the Operator over TLS", async () => {
  await assert.rejects(enroll(fakes(), "CODE", { ...CTX, address: "http://op.example.com" }), /must be https/);
});

test("enroll with nothing installed yet: no helm upgrade", async () => {
  const d = fakes();
  const r = await enroll(d, "CODE", { ...CTX, address: "https://op.example.com" });
  assert.equal(r.restarted, false);
  assert.ok(!d.calls.some((c) => c.cmd === "helm" && c.args[0] === "upgrade"));
});

test("enroll: registers the public key with the code, keeps the private key and a new credentials key in the cluster", async () => {
  const d = fakes();
  const r = await enroll(d, "ABCD-EFGH", { ...CTX, address: "https://op.example.com/" });
  const call = d.calls.find((c) => c.cmd === "fetch");
  assert.equal(call.url, `${DEFAULT_CLOUD}/api/operator/enroll`);
  const body = JSON.parse(call.body);
  assert.equal(body.code, "ABCD-EFGH");
  assert.equal(body.address, "https://op.example.com");
  assert.equal(body.publicKey.kty, "OKP");
  assert.equal(body.publicKey.d, undefined, "the private half never leaves the machine");
  assert.match(d.secret.SKAFTOR_OPERATOR_KEY, /BEGIN PRIVATE KEY/);
  assert.ok(d.secret.CRED_ENC_KEY && d.secret.POSTGRES_PASSWORD);
  assert.equal(r.operatorId, "op_1");
  assert.deepEqual({ id: d.state.operatorId, org: d.state.orgId, ns: d.state.namespace, store: d.state.store }, { id: "op_1", org: "org_1", ns: "skaftor", store: "k8s" });
  assert.ok(!JSON.stringify(d.state).includes("PRIVATE KEY"), "the saved state holds nothing secret");
});

test("enroll: no secret ever rides on a command line (ps would show it) — only on stdin", async () => {
  const d = fakes();
  await enroll(d, "CODE", { ...CTX, address: "https://op.example.com" });
  const argv = argvOf(d);
  assert.ok(!argv.includes("PRIVATE KEY") && !argv.includes(d.secret.CRED_ENC_KEY) && !argv.includes(d.secret.POSTGRES_PASSWORD));
  assert.ok(d.calls.some((c) => c.cmd === "kubectl" && c.args.includes("apply") && c.input.includes("SKAFTOR_OPERATOR_KEY")));
});

test("enroll again: the credentials key, the database password and address are kept (stored credentials stay readable)", async () => {
  const d = fakes({ existing: { SKAFTOR_OPERATOR_KEY: "old", CRED_ENC_KEY: "keep-me", POSTGRES_PASSWORD: "pg-keep", DATABASE_URL: "postgresql://db" } });
  const r = await enroll(d, "CODE", { ...CTX, address: "https://op.example.com" });
  assert.equal(d.secret.CRED_ENC_KEY, "keep-me");
  assert.equal(d.secret.POSTGRES_PASSWORD, "pg-keep");
  assert.equal(d.secret.DATABASE_URL, "postgresql://db");
  assert.notEqual(d.secret.SKAFTOR_OPERATOR_KEY, "old", "a new enrolment is a new key");
  assert.equal(r.keptCredKey, true);
  assert.equal(r.restarted, true, "the installed Operator moves onto the new enrolment");
  const up = d.calls.find((c) => c.cmd === "helm" && c.args[0] === "upgrade");
  assert.ok(up && up.args.includes("--reuse-values") && up.args.includes("operator.id=op_1") && up.args.includes("operator.orgId=org_1"), "…its id and key together, in one rollout (a restart alone kept the old id — found live)");
  const order = d.calls.map((c) => (c.args?.includes("apply") ? "write" : c.cmd === "helm" && c.args[0] === "upgrade" ? "upgrade" : null)).filter(Boolean);
  assert.deepEqual(order, ["write", "upgrade"], "…after the new key is written");
});

test("enroll: a refused code stores nothing", async () => {
  const d = fakes({ enrollStatus: 409 });
  await assert.rejects(enroll(d, "OLD", { ...CTX, address: "https://op.example.com" }), /refused the enrolment: that code is no longer valid/);
  assert.equal(d.secret.SKAFTOR_OPERATOR_KEY, undefined);
  assert.equal(d.state, null);
});

test("enroll --store gcp: the secrets go to the customer's Secret Manager, on stdin", async () => {
  const d = fakes();
  await assert.rejects(enroll(d, "CODE", { store: "gcp", address: "https://op.example.com" }), /--project/);
  const d2 = fakes();
  await enroll(d2, "CODE", { store: "gcp", project: "cust-proj", address: "https://op.example.com" });
  const adds = d2.calls.filter((c) => c.cmd === "gcloud" && c.args[2] === "add");
  assert.deepEqual(adds.map((c) => c.args[3]).sort(), ["skaftor-operator-cred-enc-key", "skaftor-operator-key", "skaftor-operator-postgres-password"]);
  assert.ok(adds.every((c) => c.args.includes("--data-file=-") && c.args.includes("--project=cust-proj") && c.input));
  assert.ok(!argvOf(d2).includes("PRIVATE KEY"));
  assert.equal(d2.state.store, "gcp");
});

test("install: the chart gets who the Operator is and the version — never a secret", () => {
  const state = { operatorId: "op_1", orgId: "org_1", cloud: "https://app.skaftor.com", address: "https://op.example.com", namespace: "skaftor", store: "k8s" };
  const a = helmArgs(state, { ...CTX, tag: "abc1234", postgres: "trial", host: "op.example.com", "tls-secret": "op-tls", gsa: "op@p.iam.gserviceaccount.com", "pull-secret": "reg" }, "install");
  const s = a.join(" ");
  for (const want of ["upgrade --install skaftor-operator", "--kube-context kind-skaftor-op", "-n skaftor", "--wait", "image.tag=abc1234", "operator.id=op_1", "operator.orgId=org_1", "operator.address=https://op.example.com", "operator.cloudUrl=https://app.skaftor.com", "postgres.enabled=true", "ingress.enabled=true", "ingress.host=op.example.com", "ingress.tlsSecretName=op-tls", "image.pullSecrets[0]=reg", "serviceAccount.worker.annotations.iam\\.gke\\.io/gcp-service-account=op@p.iam.gserviceaccount.com"]) assert.ok(s.includes(want), want);
  assert.throws(() => helmArgs(state, CTX, "install"), /--tag/);
  assert.throws(() => helmArgs(state, { ...CTX, tag: "t", host: "op.example.com" }, "install"), /--tls-secret/);
  assert.throws(() => helmArgs({ ...state, store: "gcp" }, { ...CTX, tag: "t" }, "install"), /--secret-store/);
});

test("install: refused before any change when the tools, the rights or the secret are missing", async () => {
  const state = { operatorId: "op_1", orgId: "org_1", cloud: "c", address: "https://a", namespace: "skaftor", store: "k8s" };
  const noRights = fakes({ canI: "no", existing: { SKAFTOR_OPERATOR_KEY: "k", CRED_ENC_KEY: "c", POSTGRES_PASSWORD: "p" } });
  noRights.saveState(state);
  await assert.rejects(install(noRights, { ...CTX, tag: "t", postgres: "trial" }), /you cannot create deployments/);
  assert.ok(!noRights.calls.some((c) => c.cmd === "helm" && c.args[0] === "upgrade"), "helm never ran");
  const noSecret = fakes();
  noSecret.saveState(state);
  assert.match((await preflight(noSecret, state, { ...CTX })).join(), /lacks SKAFTOR_OPERATOR_KEY, CRED_ENC_KEY, DATABASE_URL/);
  const noTools = fakes({ tools: false });
  assert.match((await preflight(noTools, state, CTX)).join(), /helm is not installed/);
  const notEnrolled = fakes();
  await assert.rejects(install(notEnrolled, { ...CTX, tag: "t" }), /enroll/);
});

test("install: with everything in place, one helm upgrade --install", async () => {
  const d = fakes({ existing: { SKAFTOR_OPERATOR_KEY: "k", CRED_ENC_KEY: "c", POSTGRES_PASSWORD: "p" } });
  d.saveState({ operatorId: "op_1", orgId: "org_1", cloud: "c", address: "https://a", namespace: "skaftor", store: "k8s" });
  await install(d, { ...CTX, tag: "t", postgres: "trial" });
  assert.equal(d.calls.filter((c) => c.cmd === "helm" && c.args[0] === "upgrade" && c.args[1] === "--install").length, 1);
});

test("upgrade: keeps the install's values, changes the version; a refused schema step is shown, with the way back", async () => {
  const state = { operatorId: "op_1", orgId: "org_1", cloud: "c", address: "https://a", namespace: "skaftor", store: "k8s" };
  const ok = fakes();
  ok.saveState(state);
  assert.equal((await upgrade(ok, { ...CTX, tag: "v2" })).ok, true);
  const args = ok.calls.find((c) => c.cmd === "helm").args.join(" ");
  assert.ok(args.includes("--reuse-values") && args.includes("image.tag=v2") && !args.includes("--install") && !args.includes("operator.id"));
  const bad = fakes({ helmFails: true });
  bad.saveState(state);
  const r = await upgrade(bad, { ...CTX, tag: "v3" });
  assert.equal(r.ok, false);
  assert.match(r.migrateLog, /accept-data-loss/);
  assert.ok(bad.calls.some((c) => c.args.includes("logs") && c.args.includes("pod/op-new") && c.args.includes("migrate")), "the newest pod's schema step");
  assert.match(r.rollback, /^helm rollback skaftor-operator --kube-context kind-skaftor-op -n skaftor$/);
});
