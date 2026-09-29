// `skaftor operator` — the BYOC install commands (intent/operator-byoc 5c). Every tool (helm, kubectl, gcloud) and
// Skaftor Cloud are fakes that record what they were asked: the rules are tested without a cluster.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { enroll, install, upgrade, installValues, clusterFlags, preflight, readSecretKeys, writeSecrets, checkSameCluster, DEFAULT_CLOUD } from "../bin/operator.mjs";

const GCP = { "skaftor-operator-key": "SKAFTOR_OPERATOR_KEY", "skaftor-operator-cred-enc-key": "CRED_ENC_KEY", "skaftor-operator-postgres-password": "POSTGRES_PASSWORD" };

function fakes({ existing = {}, installed = null, enrollAnswer = { operatorId: "op_1", orgId: "org_1", fingerprint: "AAAA" }, enrollStatus = 200, canI = "yes", helmUpgrade = "ok", migrateLog = "You are about to drop the column `x`\nUse the --accept-data-loss flag", readError = null, statusError = null, tools = true, state = null } = {}) {
  const calls = [];
  const secret = { ...existing };
  const esSecret = {};
  let revision = installed;
  const d = {
    calls, secret, esSecret, values: [],
    state,
    exec: async (cmd, args, opt = {}) => {
      calls.push({ cmd, args, input: opt.input });
      if (!tools && args[0] === "version") throw new Error("not found");
      if (cmd === "helm" && args[0] === "status") {
        if (statusError) return { code: 1, out: "", err: statusError };
        return revision === null ? { code: 1, out: "", err: "Error: release: not found" } : { code: 0, out: JSON.stringify({ version: revision }), err: "" };
      }
      if (cmd === "helm" && args[0] === "upgrade") {
        if (helmUpgrade === "ok") { revision = (revision ?? 0) + 1; return { code: 0, out: "", err: "" }; }
        if (helmUpgrade === "fail-new-revision") revision = (revision ?? 0) + 1;
        throw new Error("helm upgrade failed: timed out waiting for the condition");
      }
      if (cmd === "kubectl" && args.includes("get") && args.includes("secret") && args.includes("json")) {
        if (readError) return { code: 1, out: "", err: readError };
        if (!Object.keys(secret).length) return { code: 1, out: "", err: 'Error from server (NotFound): secrets "skaftor-operator" not found' };
        return { code: 0, out: JSON.stringify({ data: Object.fromEntries(Object.entries(secret).map(([k, v]) => [k, Buffer.from(v).toString("base64")])) }) };
      }
      if (cmd === "kubectl" && args.includes("jsonpath={.data.SKAFTOR_OPERATOR_KEY}")) return { code: 0, out: esSecret.SKAFTOR_OPERATOR_KEY ? Buffer.from(esSecret.SKAFTOR_OPERATOR_KEY).toString("base64") : "" };
      if (cmd === "kubectl" && args.includes("externalsecret")) { esSecret.SKAFTOR_OPERATOR_KEY = secret.SKAFTOR_OPERATOR_KEY; return { code: 0, out: "" }; }
      if (cmd === "kubectl" && args.includes("apply")) {
        const m = JSON.parse(opt.input);
        for (const [k, v] of Object.entries(m.data)) secret[k] = Buffer.from(v, "base64").toString("utf8");
        return { code: 0, out: "" };
      }
      if (cmd === "kubectl" && args.includes("can-i")) return { code: 0, out: `${canI}\n` };
      if (cmd === "kubectl" && args.includes("pods")) return { code: 0, out: "pod/op-old\npod/op-new\n" };
      if (cmd === "kubectl" && args.includes("logs")) return { code: 0, out: migrateLog };
      if (cmd === "gcloud" && args[2] === "access") {
        if (readError) return { code: 1, out: "", err: readError };
        const k = GCP[args.find((a) => a.startsWith("--secret=")).slice(9)];
        return secret[k] ? { code: 0, out: secret[k] } : { code: 1, out: "", err: "ERROR: (gcloud.secrets.versions.access) NOT_FOUND: Secret not found" };
      }
      if (cmd === "gcloud" && args[1] === "describe") return { code: 1, out: "", err: "NOT_FOUND" };
      if (cmd === "gcloud" && args[2] === "add") secret[GCP[args[3]]] = opt.input;
      return { code: 0, out: "" };
    },
    withValuesFile: async (values, fn) => { d.values.push(values); return fn("/tmp/values.json"); },
    fetch: async (url, init) => {
      calls.push({ cmd: "fetch", url, body: init.body });
      return { ok: enrollStatus === 200, status: enrollStatus, json: async () => (enrollStatus === 200 ? enrollAnswer : { error: "that code is no longer valid" }) };
    },
    keyPair: () => generateKeyPairSync("ed25519"),
    random: (n) => "r".repeat(n),
    sleep: async () => {},
    env: {},
    loadState: () => d.state,
    saveState: (s) => { d.state = s; },
    readSecretKeys, writeSecrets,
  };
  return d;
}

const CTX = { "kube-context": "kind-skaftor-op" };
const LOCAL = { ...CTX, chart: new URL("..", import.meta.url).pathname }; // an existing directory: a local chart, no --version
const STATE = { operatorId: "op_0", orgId: "org_1", cloud: "https://app.skaftor.com", address: "https://op.example.com", namespace: "skaftor", release: "skaftor-operator", kubeContext: "kind-skaftor-op", store: "k8s", chartVersion: "0.1.0" };
const argvOf = (d) => d.calls.filter((c) => c.cmd !== "fetch").flatMap((c) => c.args).join(" ");

test("every command names its cluster context; a kubeconfig alone is not enough (its current context is not assumed)", () => {
  assert.throws(() => clusterFlags({}, "kubectl"), /--kube-context/);
  assert.throws(() => clusterFlags({ kubeconfig: "/tmp/k" }, "kubectl"), /--kube-context/);
  assert.deepEqual(clusterFlags({ "kube-context": "c" }, "kubectl"), ["--context", "c"]);
  assert.deepEqual(clusterFlags({ "kube-context": "c", kubeconfig: "/tmp/k" }, "helm"), ["--kubeconfig", "/tmp/k", "--kube-context", "c"]);
});

test("a state belongs to one cluster, namespace and release — another is refused", () => {
  assert.doesNotThrow(() => checkSameCluster(STATE, { "kube-context": "kind-skaftor-op" }));
  assert.throws(() => checkSameCluster(STATE, { "kube-context": "gke-other" }), /SKAFTOR_OPERATOR_STATE/);
  assert.throws(() => checkSameCluster(STATE, { "kube-context": "kind-skaftor-op", namespace: "other" }), /namespace other/);
});

test("enroll into another cluster than this machine's Operator: refused before Skaftor Cloud is called", async () => {
  const d = fakes({ state: STATE });
  await assert.rejects(enroll(d, "CODE", { "kube-context": "gke-prod", address: "https://op.example.com" }), /SKAFTOR_OPERATOR_STATE/);
  assert.ok(!d.calls.some((c) => c.cmd === "fetch"));
});

test("enroll: without a named cluster, nothing is made and Skaftor Cloud is not called", async () => {
  const d = fakes();
  await assert.rejects(enroll(d, "CODE", { address: "https://op.example.com" }), /--kube-context/);
  assert.equal(d.calls.length, 0);
});

test("enroll: an http address (not localhost) is refused — browsers reach the Operator over TLS", async () => {
  await assert.rejects(enroll(fakes(), "CODE", { ...CTX, address: "http://op.example.com" }), /must be https/);
});

test("enroll: registers the public key with the code; keeps the private key and a new credentials key in the cluster", async () => {
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
  assert.equal(r.moved, false);
  assert.deepEqual({ id: d.state.operatorId, ctx: d.state.kubeContext, ns: d.state.namespace, rel: d.state.release, pending: d.state.pending }, { id: "op_1", ctx: "kind-skaftor-op", ns: "skaftor", rel: "skaftor-operator", pending: false });
  assert.ok(!JSON.stringify(d.state).includes("PRIVATE KEY"), "the saved state holds nothing secret");
  assert.ok(!d.calls.some((c) => c.cmd === "helm" && c.args[0] === "upgrade"), "nothing installed: no helm upgrade");
});

test("enroll: the Secret is written server-side (no last-applied copy of the key) and any old copy is removed", async () => {
  const d = fakes();
  await enroll(d, "CODE", { ...CTX, address: "https://op.example.com" });
  const apply = d.calls.find((c) => c.args?.includes("apply"));
  assert.ok(apply.args.includes("--server-side") && apply.args.includes("--field-manager=skaftor-cli"));
  assert.ok(d.calls.some((c) => c.args?.includes("kubectl.kubernetes.io/last-applied-configuration-")));
});

test("enroll: no secret ever rides on a command line (ps would show it) — only on stdin", async () => {
  const d = fakes();
  await enroll(d, "CODE", { ...CTX, address: "https://op.example.com" });
  const argv = argvOf(d);
  assert.ok(!argv.includes("PRIVATE KEY") && !argv.includes(d.secret.CRED_ENC_KEY) && !argv.includes(d.secret.POSTGRES_PASSWORD));
  assert.ok(d.calls.some((c) => c.cmd === "kubectl" && c.args.includes("apply") && c.input.includes("SKAFTOR_OPERATOR_KEY")));
});

test("enroll again: credentials key and database password kept; the installed Operator moved onto the new id and key together", async () => {
  const d = fakes({ existing: { SKAFTOR_OPERATOR_KEY: "old", CRED_ENC_KEY: "keep-me", POSTGRES_PASSWORD: "pg-keep" }, installed: 3, state: STATE });
  const r = await enroll(d, "CODE", { ...LOCAL, address: "https://op.example.com" });
  assert.equal(d.secret.CRED_ENC_KEY, "keep-me");
  assert.equal(d.secret.POSTGRES_PASSWORD, "pg-keep");
  assert.notEqual(d.secret.SKAFTOR_OPERATOR_KEY, "old");
  assert.equal(r.keptCredKey, true);
  assert.equal(r.moved, true);
  const up = d.calls.find((c) => c.cmd === "helm" && c.args[0] === "upgrade");
  assert.ok(up.args.includes("--reuse-values") && up.args.includes("-f"));
  assert.deepEqual(d.values.at(-1).operator, { id: "op_1", orgId: "org_1", address: "https://op.example.com" });
  const order = d.calls.map((c) => (c.args?.includes("apply") ? "write" : c.cmd === "helm" && c.args[0] === "upgrade" ? "upgrade" : null)).filter(Boolean);
  assert.deepEqual(order, ["write", "upgrade"], "…after the new key is written");
  assert.equal(d.state.pending, false);
});

test("enroll again, the move fails: the new id is already saved (pending) with the way to finish — never the new key under the old id", async () => {
  const d = fakes({ existing: { SKAFTOR_OPERATOR_KEY: "old", CRED_ENC_KEY: "k", POSTGRES_PASSWORD: "p" }, installed: 3, helmUpgrade: "fail-new-revision", state: STATE });
  await assert.rejects(enroll(d, "CODE", { ...LOCAL, address: "https://op.example.com" }), /enrolled as op_1 and its key is stored[\s\S]*finish with: skaftor operator upgrade --tag/);
  assert.equal(d.state.operatorId, "op_1");
  assert.equal(d.state.pending, true);
});

test("enroll: a read that fails for any reason but 'not found' stops before the code is spent (no new credentials key)", async () => {
  for (const [store, extra] of [["k8s", {}], ["gcp", { store: "gcp", project: "p" }]]) {
    const d = fakes({ readError: "Error from server (Forbidden): secrets is forbidden", existing: { CRED_ENC_KEY: "keep" } });
    await assert.rejects(enroll(d, "CODE", { ...CTX, ...extra, address: "https://op.example.com" }), /could not read/, store);
    assert.ok(!d.calls.some((c) => c.cmd === "fetch"), `${store}: Skaftor Cloud never called`);
    assert.equal(d.secret.CRED_ENC_KEY, "keep", `${store}: the credentials key untouched`);
  }
  const s = fakes({ statusError: "Error: Kubernetes cluster unreachable: the server has asked for the client to provide credentials" });
  await assert.rejects(enroll(s, "CODE", { ...CTX, address: "https://op.example.com" }), /could not tell whether the Operator is installed/);
  assert.ok(!s.calls.some((c) => c.cmd === "fetch"));
});

test("enroll: a refused code, or an answer that is not ids, stores nothing", async () => {
  const d = fakes({ enrollStatus: 409 });
  await assert.rejects(enroll(d, "OLD", { ...CTX, address: "https://op.example.com" }), /refused the enrolment: that code is no longer valid/);
  assert.equal(d.secret.SKAFTOR_OPERATOR_KEY, undefined);
  assert.equal(d.state, null);
  const odd = fakes({ enrollAnswer: { operatorId: "op_1", fingerprint: "F" } });
  await assert.rejects(enroll(odd, "C", { ...CTX, address: "https://op.example.com" }), /not one this CLI understands/);
  assert.equal(odd.state, null);
  const inject = fakes({ enrollAnswer: { operatorId: "x,secrets.existingSecret=other", orgId: "o", fingerprint: "F" } });
  await assert.rejects(enroll(inject, "C", { ...CTX, address: "https://op.example.com" }), /not one this CLI understands/);
});

test("enroll --store gcp: secrets to the customer's Secret Manager on stdin; an installed Operator waits for External Secrets, then moves", async () => {
  const d = fakes();
  await enroll(d, "CODE", { ...CTX, store: "gcp", project: "cust-proj", address: "https://op.example.com" });
  const adds = d.calls.filter((c) => c.cmd === "gcloud" && c.args[2] === "add");
  assert.deepEqual(adds.map((c) => c.args[3]).sort(), ["skaftor-operator-cred-enc-key", "skaftor-operator-key", "skaftor-operator-postgres-password"]);
  assert.ok(adds.every((c) => c.args.includes("--data-file=-") && c.args.includes("--project=cust-proj") && c.input));
  assert.ok(!argvOf(d).includes("PRIVATE KEY"));
  const again = fakes({ existing: { CRED_ENC_KEY: "k" }, installed: 2, state: { ...STATE, store: "gcp", project: "cust-proj" } });
  const r = await enroll(again, "CODE", { ...LOCAL, store: "gcp", project: "cust-proj", address: "https://op.example.com" });
  assert.equal(r.moved, true);
  const seq = again.calls.map((c) => (c.args?.includes("externalsecret") ? "sync" : c.cmd === "helm" && c.args[0] === "upgrade" ? "upgrade" : null)).filter(Boolean);
  assert.deepEqual(seq, ["sync", "upgrade"], "the new key is in the cluster's Secret before the new id rolls out (review of 5c)");
});

test("install: values in a file — who the Operator is, the version, the options; never a secret, never a --set string", () => {
  const v = installValues(STATE, { ...CTX, tag: "abc1234", postgres: "trial", host: "op.example.com", "tls-secret": "op-tls", gsa: "op@p.iam.gserviceaccount.com", "pull-secret": "reg" });
  assert.deepEqual(v.operator, { cloudUrl: "https://app.skaftor.com", id: "op_0", orgId: "org_1", address: "https://op.example.com" });
  assert.deepEqual(v.image, { tag: "abc1234", pullSecrets: ["reg"] });
  assert.deepEqual(v.ingress, { enabled: true, host: "op.example.com", tlsSecretName: "op-tls" });
  assert.deepEqual(v.serviceAccount.worker.annotations, { "iam.gke.io/gcp-service-account": "op@p.iam.gserviceaccount.com" });
  const comma = installValues(STATE, { ...CTX, tag: "t", host: "a,image.repository=evil/img", "tls-secret": "s" });
  assert.equal(comma.ingress.host, "a,image.repository=evil/img", "a comma is only a character in a value (review of 5c)");
  assert.equal(comma.image.repository, undefined);
  assert.throws(() => installValues(STATE, CTX), /--tag/);
  assert.throws(() => installValues(STATE, { ...CTX, tag: "t", host: "op.example.com" }), /--tls-secret/);
  assert.throws(() => installValues({ ...STATE, store: "gcp" }, { ...CTX, tag: "t" }), /--secret-store/);
});

test("install: refused before any change when the tools, the rights, the secret or the chart version are missing", async () => {
  const noRights = fakes({ canI: "no", existing: { SKAFTOR_OPERATOR_KEY: "k", CRED_ENC_KEY: "c", POSTGRES_PASSWORD: "p" }, state: STATE });
  await assert.rejects(install(noRights, { ...LOCAL, tag: "t", postgres: "trial" }), /you cannot create deployments/);
  assert.ok(!noRights.calls.some((c) => c.cmd === "helm" && c.args[0] === "upgrade"), "helm never ran");
  assert.match((await preflight(fakes({ state: STATE }), STATE, CTX)).join(), /lacks SKAFTOR_OPERATOR_KEY, CRED_ENC_KEY, DATABASE_URL/);
  assert.match((await preflight(fakes({ tools: false }), STATE, CTX)).join(), /helm is not installed/);
  await assert.rejects(install(fakes(), { ...CTX, tag: "t" }), /enroll/);
  await assert.rejects(install(fakes({ state: { ...STATE, chartVersion: undefined } }), { ...CTX, tag: "t" }), /--chart-version/);
});

test("install: one helm upgrade --install, the registry chart pinned; the version is remembered", async () => {
  const d = fakes({ existing: { SKAFTOR_OPERATOR_KEY: "k", CRED_ENC_KEY: "c", POSTGRES_PASSWORD: "p" }, state: { ...STATE, chartVersion: undefined } });
  await install(d, { ...CTX, tag: "t", postgres: "trial", "chart-version": "0.2.0" });
  const up = d.calls.filter((c) => c.cmd === "helm" && c.args[0] === "upgrade");
  assert.equal(up.length, 1);
  assert.ok(up[0].args.includes("--install") && up[0].args.join(" ").includes("--version 0.2.0") && !up[0].args.includes("--set-string"));
  assert.equal(d.state.chartVersion, "0.2.0");
});

test("upgrade: keeps the install's values, sets the version (and who the Operator is) from a file, the chart pinned", async () => {
  const d = fakes({ installed: 4, state: STATE });
  assert.equal((await upgrade(d, { ...CTX, tag: "v2" })).ok, true);
  const up = d.calls.find((c) => c.cmd === "helm" && c.args[0] === "upgrade");
  assert.ok(up.args.includes("--reuse-values") && !up.args.includes("--install") && up.args.join(" ").includes("--version 0.1.0"));
  assert.deepEqual(d.values.at(-1), { operator: { id: "op_0", orgId: "org_1", address: "https://op.example.com" }, image: { tag: "v2" } });
});

test("upgrade: a refused schema step (a new revision) shows why and the rollback to the revision before", async () => {
  const d = fakes({ installed: 4, helmUpgrade: "fail-new-revision", state: STATE });
  const r = await upgrade(d, { ...LOCAL, tag: "v3" });
  assert.equal(r.ok, false);
  assert.match(r.migrateLog, /accept-data-loss/);
  assert.equal(r.rollback, "helm rollback skaftor-operator 4 --kube-context kind-skaftor-op -n skaftor");
});

test("upgrade: no rollback advice when no new revision was made, or when the schema step did not refuse", async () => {
  const early = fakes({ installed: 4, helmUpgrade: "fail-no-revision", state: STATE });
  const r1 = await upgrade(early, { ...LOCAL, tag: "v3" });
  assert.equal(r1.rollback, null);
  assert.equal(r1.newRevision, false);
  const late = fakes({ installed: 4, helmUpgrade: "fail-new-revision", migrateLog: "The database is already in sync", state: STATE });
  const r2 = await upgrade(late, { ...LOCAL, tag: "v3" });
  assert.equal(r2.rollback, null, "an applied schema is forward only");
  assert.equal(r2.newRevision, true);
});

test("upgrade: a bad invocation is refused before anything runs (no rollback advice for what never happened)", async () => {
  const d = fakes({ installed: 4, state: STATE });
  await assert.rejects(upgrade(d, CTX), /--tag/);
  await assert.rejects(upgrade(d, { "kube-context": "other", tag: "v" }), /SKAFTOR_OPERATOR_STATE/);
  assert.equal(d.calls.filter((c) => c.cmd === "helm").length, 0);
});

test("workstations: the engine's address as a value; its token from the shell, only that key under its own field manager", async () => {
  const v = installValues(STATE, { ...CTX, tag: "t", "workstations-url": "http://skaftor-cloud.skaftor:3112/", "workstations-public-url": "https://ws.example.com" });
  assert.deepEqual(v.workstations, { url: "http://skaftor-cloud.skaftor:3112", publicUrl: "https://ws.example.com" });
  assert.throws(() => installValues(STATE, { ...CTX, tag: "t", "workstations-url": "not a url" }), /engine's address/);
  assert.throws(() => installValues(STATE, { ...CTX, tag: "t", "workstations-url": "http://e:3112", "workstations-public-url": "http://ws.example.com" }), /must be https/);
  assert.deepEqual(installValues({ ...STATE, workstationsUrl: "http://e:3112" }, { ...CTX, tag: "t" }).workstations, { url: "http://e:3112" }, "installing again without the flag keeps it (remembered — review)");
  const noToken = fakes({ existing: { SKAFTOR_OPERATOR_KEY: "k", CRED_ENC_KEY: "c", POSTGRES_PASSWORD: "p" }, state: STATE });
  await assert.rejects(install(noToken, { ...LOCAL, tag: "t", postgres: "trial", "workstations-url": "http://ws:3112" }), /SKAFTOR_WORKSTATIONS_TOKEN/);
  const d = fakes({ existing: { SKAFTOR_OPERATOR_KEY: "k", CRED_ENC_KEY: "c", POSTGRES_PASSWORD: "p" }, state: STATE });
  d.env = { SKAFTOR_WORKSTATIONS_TOKEN: "ws-secret-token" };
  await install(d, { ...LOCAL, tag: "t", postgres: "trial", "workstations-url": "http://ws:3112" });
  const apply = d.calls.filter((c) => c.args?.includes("apply")).pop();
  assert.ok(apply.args.includes("--field-manager=skaftor-cli-workstations"), "its own field manager");
  assert.deepEqual(Object.keys(JSON.parse(apply.input).data), ["WORKSTATIONS_TOKEN"], "…applying only that key: a later enroll can't remove it, and it takes no other key (review)");
  assert.equal(d.secret.WORKSTATIONS_TOKEN, "ws-secret-token");
  assert.ok(!argvOf(d).includes("ws-secret-token"), "…never on a command line");
  assert.equal(d.state.workstationsUrl, "http://ws:3112", "remembered for the next install");
  const g = fakes({ state: { ...STATE, store: "gcp", project: "p" } });
  g.env = { SKAFTOR_WORKSTATIONS_TOKEN: "ws-gcp" };
  await install(g, { ...LOCAL, tag: "t", "secret-store": "s", "workstations-url": "http://ws:3112" }).catch(() => {});
  assert.ok(g.calls.some((c) => c.cmd === "gcloud" && c.args.includes("skaftor-operator-workstations-token") && c.input === "ws-gcp"), "with Secret Manager: the token goes there (the chart's ExternalSecret reads it — review)");
});
