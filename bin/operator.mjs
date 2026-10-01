// skaftor operator — install and run a Skaftor Operator (BYOC) in your own cluster.
//
// The Operator is one organization's data plane, in the customer's cloud: Skaftor Cloud keeps sign-in, billing and
// orchestration; content, credentials and runs stay with the customer. These commands drive the Helm chart
// (charts/skaftor-operator) with the customer's own tools and logins: helm, kubectl and, for Secret Manager, gcloud.
//
//   enroll <code>   make the Operator's key, register it with Skaftor Cloud, keep its secrets with the customer
//   install         install the chart (after enroll)
//   upgrade --tag   move to another platform version
//   status          what is running
//
// Safety: every command names its cluster context (--kube-context); no current context is ever assumed, not even a
// kubeconfig's. Secrets travel on stdin, never on a command line (where `ps` would show them); chart values go in a
// values file, never as --set strings (a comma there would set other keys). Zero dependencies.

import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, chmodSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_CLOUD = "https://app.skaftor.com";
export const DEFAULT_CHART = "oci://us-central1-docker.pkg.dev/skaftorai-502111/operator/skaftor-operator";
export const SECRET_NAME = "skaftor-operator";
const ID = /^[A-Za-z0-9_-]{1,64}$/;
// Who the Operator is and where it lives (nothing secret). SKAFTOR_OPERATOR_STATE points elsewhere (a second Operator).
const STATE_FILE = process.env.SKAFTOR_OPERATOR_STATE || join(homedir(), ".skaftor", "operator.json");

/** Runs a tool: argv only (no shell), an optional stdin, its output back. Injected in tests. */
export function realExec(cmd, args, { input, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    // A tool that exits before reading stdin (a bad flag, no login): its own error is the answer, not an EPIPE crash.
    p.stdin.on("error", () => {});
    p.on("error", (e) => reject(Object.assign(new Error(`${cmd}: ${e.message}`), { code: "ENOENT" })));
    p.on("close", (code) => {
      if (code === 0 || allowFail) resolve({ code, out, err });
      else reject(Object.assign(new Error(`${cmd} ${args.slice(0, 3).join(" ")} … failed (${code}): ${err.trim().slice(-600)}`), { code, out, err }));
    });
    if (input !== undefined) p.stdin.end(input); else p.stdin.end();
  });
}

/** Chart values in a private temp file for `helm -f` — removed after. Injected in tests. */
export async function realWithValuesFile(values, fn) {
  const dir = mkdtempSync(join(tmpdir(), "skaftor-operator-"));
  const file = join(dir, "values.json");
  try {
    writeFileSync(file, JSON.stringify(values), { mode: 0o600 });
    return await fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The cluster flags for kubectl / helm: always a named context (with --kubeconfig, that file's context by name). */
export function clusterFlags(flags, tool) {
  const ctx = typeof flags["kube-context"] === "string" ? flags["kube-context"] : null;
  if (!ctx) throw new Error("name the cluster: --kube-context <context> [--kubeconfig <file>] (no current context is ever assumed)");
  const out = [];
  if (typeof flags.kubeconfig === "string") out.push("--kubeconfig", flags.kubeconfig);
  out.push(tool === "helm" ? "--kube-context" : "--context", ctx);
  return out;
}

const ns = (flags) => (typeof flags.namespace === "string" ? flags.namespace : "skaftor");
const releaseOf = (flags) => (typeof flags.release === "string" ? flags.release : "skaftor-operator");
const notFound = (r) => /not[ _]?found/i.test(`${r.err}\n${r.out}`);

// ── state (not secret: who the Operator is, where it lives) ─────────────────
export function loadState(file = STATE_FILE) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}
export function saveState(s, file = STATE_FILE) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
  try { chmodSync(file, 0o600); } catch {}
}

/** A state belongs to one cluster, namespace and release: another is refused, never mixed (review of 5c). */
export function checkSameCluster(state, flags) {
  const want = { kubeContext: flags["kube-context"], namespace: ns(flags), release: releaseOf(flags) };
  const diff = Object.entries(want).filter(([k, v]) => state[k] !== undefined && state[k] !== v);
  if (diff.length) throw new Error(`this machine's Operator is ${state.release} in ${state.kubeContext}/${state.namespace}; ${diff.map(([k, v]) => `${k} ${v}`).join(", ")} is another. For a second Operator, set SKAFTOR_OPERATOR_STATE to its own file.`);
}

// ── secret stores ────────────────────────────────────────────────────────────
// k8s: a Secret in the Operator's namespace. gcp: the customer's Secret Manager (the chart reads it through External
// Secrets). Both read what is there first: the credentials key and the database password are kept across a
// re-enrolment. Only "not found" counts as absent — a read that fails otherwise stops everything, or a new credentials
// key would replace the one every stored credential is encrypted under (review of 5c).
const GCP_NAMES = { SKAFTOR_OPERATOR_KEY: "skaftor-operator-key", CRED_ENC_KEY: "skaftor-operator-cred-enc-key", POSTGRES_PASSWORD: "skaftor-operator-postgres-password", WORKSTATIONS_TOKEN: "skaftor-operator-workstations-token" };

export async function readSecretKeys(d, flags) {
  if (flags.store === "gcp") {
    const project = asStr(flags.project, "--project (the Google Cloud project whose Secret Manager keeps the Operator's secrets)");
    const found = {};
    for (const [k, name] of Object.entries(GCP_NAMES)) {
      const r = await d.exec("gcloud", ["secrets", "versions", "access", "latest", `--secret=${name}`, `--project=${project}`], { allowFail: true });
      if (r.code === 0) { if (r.out) found[k] = r.out; continue; }
      if (!notFound(r)) throw new Error(`could not read ${name} from Secret Manager (so nothing was changed): ${r.err.trim().slice(-300)}`);
    }
    return found;
  }
  const r = await d.exec("kubectl", [...clusterFlags(flags, "kubectl"), "-n", ns(flags), "get", "secret", SECRET_NAME, "-o", "json"], { allowFail: true });
  if (r.code !== 0) {
    if (notFound(r)) return {};
    throw new Error(`could not read the Secret ${SECRET_NAME} (so nothing was changed): ${r.err.trim().slice(-300)}`);
  }
  const data = JSON.parse(r.out).data ?? {};
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Buffer.from(String(v), "base64").toString("utf8")]));
}

export async function writeSecrets(d, flags, values, opts = {}) {
  if (flags.store === "gcp") {
    const project = asStr(flags.project, "--project");
    for (const [k, v] of Object.entries(values)) {
      const name = GCP_NAMES[k];
      if (!name) continue;
      const exists = await d.exec("gcloud", ["secrets", "describe", name, `--project=${project}`], { allowFail: true });
      if (exists.code !== 0) {
        if (!notFound(exists)) throw new Error(`could not check ${name} in Secret Manager: ${exists.err.trim().slice(-300)}`);
        await d.exec("gcloud", ["secrets", "create", name, `--project=${project}`, "--replication-policy=automatic"]);
      }
      await d.exec("gcloud", ["secrets", "versions", "add", name, `--project=${project}`, "--data-file=-"], { input: v });
    }
    return;
  }
  const k = clusterFlags(flags, "kubectl");
  await d.exec("kubectl", [...k, "create", "namespace", ns(flags)], { allowFail: true });
  const manifest = {
    apiVersion: "v1", kind: "Secret", type: "Opaque",
    metadata: { name: SECRET_NAME, namespace: ns(flags), labels: { "app.kubernetes.io/name": "skaftor-operator" } },
    data: Object.fromEntries(Object.entries(values).map(([key, v]) => [key, Buffer.from(v, "utf8").toString("base64")])),
  };
  // Server-side apply: no last-applied annotation holding a second copy of the key (review of 5c); keys another tool
  // set (a DATABASE_URL added by hand) stay theirs.
  // Each writer owns only its own keys (review): a field manager that re-applied every key would take them all, and its
  // next apply without them would delete them.
  await d.exec("kubectl", [...k, "apply", "--server-side", `--field-manager=${opts.fieldManager || "skaftor-cli"}`, "--force-conflicts", "-f", "-"], { input: JSON.stringify(manifest) });
  // A Secret an older CLI applied client-side still carries that copy: removed.
  await d.exec("kubectl", [...k, "-n", ns(flags), "annotate", "secret", SECRET_NAME, "kubectl.kubernetes.io/last-applied-configuration-"], { allowFail: true });
}

/** gcp: have External Secrets copy the new key into the cluster now, and wait until the Secret the pods read holds it. */
async function syncExternalSecret(d, flags, pem) {
  const k = clusterFlags(flags, "kubectl");
  const name = `${releaseOf(flags)}-secrets`;
  await d.exec("kubectl", [...k, "-n", ns(flags), "annotate", "externalsecret", name, `force-sync=${Date.now()}`, "--overwrite"]);
  const want = createHash("sha256").update(pem).digest("hex");
  for (let i = 0; i < 40; i++) {
    const r = await d.exec("kubectl", [...k, "-n", ns(flags), "get", "secret", name, "-o", "jsonpath={.data.SKAFTOR_OPERATOR_KEY}"], { allowFail: true });
    if (r.code === 0 && createHash("sha256").update(Buffer.from(r.out.trim(), "base64").toString("utf8")).digest("hex") === want) return;
    await d.sleep(3000);
  }
  throw new Error(`External Secrets has not copied the new key into ${name} yet`);
}

async function releaseInstalled(d, flags) {
  const r = await d.exec("helm", ["status", releaseOf(flags), ...clusterFlags(flags, "helm"), "-n", ns(flags), "-o", "json"], { allowFail: true });
  if (r.code === 0) return JSON.parse(r.out || "{}").version ?? 0;
  if (notFound(r)) return null;
  throw new Error(`could not tell whether the Operator is installed (so nothing was changed): ${r.err.trim().slice(-300)}`);
}

// ── enroll ───────────────────────────────────────────────────────────────────
export async function enroll(d, code, flags) {
  if (!code) throw new Error("usage: skaftor operator enroll <code> --address https://operator.example.com --kube-context <ctx> [--store k8s|gcp --project <p>] [--cloud <url>]");
  const address = asStr(flags.address, "--address (where browsers will reach this Operator, https)");
  let addr;
  try { addr = new URL(address); } catch { throw new Error("--address must be a URL"); }
  if (addr.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(addr.hostname)) throw new Error("--address must be https (browsers reach the Operator directly)");
  const cloud = String(flags.cloud || DEFAULT_CLOUD).replace(/\/+$/, "");
  // Skaftor Cloud's keys verify every token: https only (localhost excepted, for a developer's machine — security review).
  if (!isSecureCloud(cloud)) throw new Error("--cloud must be https (Skaftor Cloud's keys verify every token)");
  clusterFlags(flags, "kubectl"); // the cluster is named before anything is made
  const prev = d.loadState();
  if (prev) checkSameCluster(prev, flags);

  // Everything that can fail by reading fails here, before the one-time code is spent.
  const installed = await releaseInstalled(d, flags);
  const existing = await d.readSecretKeys(d, flags);
  const { privateKey, publicKey } = d.keyPair();
  const r = await d.fetch(`${cloud}/api/operator/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, address: addr.origin, publicKey: publicKey.export({ format: "jwk" }) }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.operatorId) throw new Error(`Skaftor Cloud refused the enrolment: ${j.error ?? `HTTP ${r.status}`}`);
  if (!ID.test(String(j.operatorId)) || !ID.test(String(j.orgId ?? "")) || typeof j.fingerprint !== "string") throw new Error("Skaftor Cloud's answer to the enrolment is not one this CLI understands (nothing was stored)");

  // Accepted: the new enrolment is recorded at once, pending until the running Operator is on it (review of 5c).
  const state = { ...(prev ?? {}), operatorId: j.operatorId, orgId: j.orgId, fingerprint: j.fingerprint, cloud: prev?.cloud ?? cloud, address: addr.origin, kubeContext: flags["kube-context"], ...(typeof flags.kubeconfig === "string" ? { kubeconfig: flags.kubeconfig } : {}), namespace: ns(flags), release: releaseOf(flags), store: flags.store === "gcp" ? "gcp" : "k8s", ...(flags.project ? { project: String(flags.project) } : {}), enrolledAt: new Date().toISOString(), pending: installed !== null };
  d.saveState(state);

  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const values = { SKAFTOR_OPERATOR_KEY: pem, CRED_ENC_KEY: existing.CRED_ENC_KEY || d.random(32), POSTGRES_PASSWORD: existing.POSTGRES_PASSWORD || d.random(24) };
  await d.writeSecrets(d, flags, values);

  // An Operator already installed runs as its old enrolment (its id is a chart value, its key read at start): move it
  // onto the new one — id and key together, in one rollout (found live: a restart alone kept the old id).
  let moved = false;
  if (installed !== null) {
    try {
      if (state.store === "gcp") await syncExternalSecret(d, flags, pem);
      await moveRelease(d, state, flags);
      moved = true;
    } catch (e) {
      throw new Error(`enrolled as ${j.operatorId} and its key is stored, but the running Operator is not on it yet: ${e.message}\nfinish with: skaftor operator upgrade --tag <the version you run> --kube-context ${flags["kube-context"]}${flags.kubeconfig ? ` --kubeconfig ${flags.kubeconfig}` : ""}`);
    }
  }
  d.saveState({ ...state, pending: false });
  return { ...state, pending: false, keptCredKey: !!existing.CRED_ENC_KEY, moved };
}

/** helm upgrade that keeps the install's values and sets who the Operator is (from the state). */
async function moveRelease(d, state, flags, tag) {
  const values = { operator: { id: state.operatorId, orgId: state.orgId, address: state.address }, ...(tag ? { image: { tag } } : {}) };
  await d.withValuesFile(values, (file) => d.exec("helm", ["upgrade", state.release ?? releaseOf(flags), chartOf(flags), ...chartVersionArgs(flags, state), ...clusterFlags(flags, "helm"), "-n", state.namespace, "--reuse-values", "-f", file, "--wait", "--timeout", String(flags.timeout || "10m")]));
}

// ── install / upgrade ────────────────────────────────────────────────────────
const chartOf = (flags) => String(flags.chart || DEFAULT_CHART);
const isLocalChart = (chart) => !chart.startsWith("oci://") && existsSync(chart);
/** A registry chart is always pinned: --chart-version, or the version this Operator was installed with (review of 5c). */
function chartVersionArgs(flags, state) {
  if (isLocalChart(chartOf(flags))) return [];
  const v = typeof flags["chart-version"] === "string" ? flags["chart-version"] : state?.chartVersion;
  if (!v) throw new Error("missing --chart-version (the chart version Skaftor gives with the platform version)");
  return ["--version", v];
}

/** The chart values for an install — no secret among them (they come from the Secret / Secret Manager). */
export function installValues(state, flags) {
  const tag = asStr(flags.tag, "--tag (the platform version to run)");
  const v = { image: { tag }, operator: { cloudUrl: state.cloud, id: state.operatorId, orgId: state.orgId, address: state.address, ...(/^http:/.test(state.cloud) && isSecureCloud(state.cloud) ? { allowInsecureCloudUrl: true } : {}) } };
  if (flags.image) v.image.repository = String(flags.image);
  if (flags["pull-policy"]) v.image.pullPolicy = String(flags["pull-policy"]);
  if (flags["pull-secret"]) v.image.pullSecrets = [String(flags["pull-secret"])];
  if (flags.postgres === "trial") v.postgres = { enabled: true, ...(flags["postgres-storage"] ? { storage: String(flags["postgres-storage"]) } : {}) };
  if (state.store === "gcp") v.secrets = { externalSecrets: { enabled: true, storeRef: { name: asStr(flags["secret-store"], "--secret-store (the External Secrets store for your Secret Manager)") } } };
  if (flags.host) v.ingress = { enabled: true, host: String(flags.host), tlsSecretName: asStr(flags["tls-secret"], "--tls-secret (browsers reach the Operator over TLS only)"), ...(flags["ingress-class"] ? { className: String(flags["ingress-class"]) } : {}) };
  if (flags.gsa) v.serviceAccount = { worker: { annotations: { "iam.gke.io/gcp-service-account": String(flags.gsa) } } };
  // Workstations: the customer's own engine (skaftor-cloud's GKE kit) in the same cluster; its token is in the Secret.
  // Remembered in the state, so installing again without the flags keeps them (review).
  const wsUrl = flags["workstations-url"] ?? state.workstationsUrl;
  const wsPublic = flags["workstations-public-url"] ?? state.workstationsPublicUrl;
  if (wsUrl) {
    const u = String(wsUrl);
    if (!/^https?:\/\/[^\s/]+(:\d+)?\/?$/.test(u)) throw new Error("--workstations-url must be the engine's address, e.g. http://skaftor-cloud.skaftor:3112");
    if (wsPublic && !/^https:\/\/[^\s/]+(:\d+)?\/?$/.test(String(wsPublic))) throw new Error("--workstations-public-url must be https (developers' terminals connect there with a credential)");
    v.workstations = { url: u.replace(/\/+$/, ""), ...(wsPublic ? { publicUrl: String(wsPublic).replace(/\/+$/, "") } : {}) };
  }
  return v;
}

export async function preflight(d, state, flags) {
  const problems = [];
  for (const [tool, args] of [["helm", ["version", "--short"]], ["kubectl", ["version", "--client"]]]) {
    try { await d.exec(tool, args); } catch { problems.push(`${tool} is not installed`); }
  }
  if (problems.length) return problems;
  const k = clusterFlags(flags, "kubectl");
  for (const [verb, res] of [["create", "deployments"], ["create", "services"], ["create", "serviceaccounts"], ["get", "secrets"]]) {
    const r = await d.exec("kubectl", [...k, "auth", "can-i", verb, res, "-n", state.namespace], { allowFail: true });
    if (r.out.trim() !== "yes") problems.push(`you cannot ${verb} ${res} in namespace ${state.namespace}`);
  }
  const wantsWs = !!(flags["workstations-url"] ?? state.workstationsUrl);
  if (wantsWs && !d.env.SKAFTOR_WORKSTATIONS_TOKEN) {
    const have = Object.keys(await d.readSecretKeys(d, { ...flags, namespace: state.namespace, store: state.store, project: state.project }));
    if (!have.includes("WORKSTATIONS_TOKEN")) problems.push("workstations need the engine's service token: set SKAFTOR_WORKSTATIONS_TOKEN in your shell for this command (it goes into your secrets, never on a command line)");
  }
  if (state.store === "k8s") {
    const keys = Object.keys(await d.readSecretKeys(d, { ...flags, namespace: state.namespace }));
    const need = ["SKAFTOR_OPERATOR_KEY", "CRED_ENC_KEY", flags.postgres === "trial" ? "POSTGRES_PASSWORD" : "DATABASE_URL"];
    const missing = need.filter((x) => !keys.includes(x));
    if (missing.length) problems.push(`the Secret ${SECRET_NAME} in ${state.namespace} lacks ${missing.join(", ")}${missing.includes("DATABASE_URL") ? " (add your database's address, or use --postgres trial)" : " (run skaftor operator enroll)"}`);
  }
  return problems;
}

function enrolledState(d, flags) {
  const state = d.loadState();
  if (!state) throw new Error("no Operator enrolled here yet — run `skaftor operator enroll <code>` first");
  clusterFlags(flags, "kubectl");
  checkSameCluster(state, flags);
  return state;
}

export async function install(d, flags) {
  const state = enrolledState(d, flags);
  const values = installValues(state, flags);
  const version = chartVersionArgs(flags, state);
  const problems = await preflight(d, state, flags);
  if (problems.length) throw new Error(`cannot install:\n  - ${problems.join("\n  - ")}`);
  // The engine's token, from the shell into the org's secrets — only that key, under its own field manager (review),
  // in the Kubernetes Secret or Secret Manager alike; never on a command line.
  if (wantsWsToken(flags, state) && d.env.SKAFTOR_WORKSTATIONS_TOKEN) {
    await d.writeSecrets(d, { ...flags, namespace: state.namespace, store: state.store, project: state.project }, { WORKSTATIONS_TOKEN: d.env.SKAFTOR_WORKSTATIONS_TOKEN }, { fieldManager: "skaftor-cli-workstations" });
  }
  await d.withValuesFile(values, (file) => d.exec("helm", ["upgrade", "--install", state.release, chartOf(flags), ...version, ...clusterFlags(flags, "helm"), "-n", state.namespace, "-f", file, "--wait", "--timeout", String(flags.timeout || "10m")]));
  const saved = { ...state, pending: false, ...(version[1] ? { chartVersion: version[1] } : {}), ...(values.workstations ? { workstationsUrl: values.workstations.url, ...(values.workstations.publicUrl ? { workstationsPublicUrl: values.workstations.publicUrl } : {}) } : {}) };
  d.saveState(saved);
  return saved;
}

export async function upgrade(d, flags) {
  const state = enrolledState(d, flags);
  const tag = asStr(flags.tag, "--tag (the platform version to run)");
  chartVersionArgs(flags, state); // a bad invocation is refused before anything runs, with no rollback advice
  const before = await releaseInstalled(d, flags);
  if (before === null) throw new Error("the Operator is not installed in this cluster — run `skaftor operator install`");
  try {
    await moveRelease(d, state, flags, tag);
    const v = chartVersionArgs(flags, state)[1];
    d.saveState({ ...state, pending: false, ...(v ? { chartVersion: v } : {}) });
    return { ok: true, state };
  } catch (e) {
    const after = await releaseInstalled(d, flags).catch(() => before);
    const k = clusterFlags(flags, "kubectl");
    const pods = await d.exec("kubectl", [...k, "-n", state.namespace, "get", "pods", "-l", "app.kubernetes.io/name=skaftor-operator,app.kubernetes.io/component=web", "--sort-by=.metadata.creationTimestamp", "-o", "name"], { allowFail: true });
    const newest = pods.out.trim().split("\n").filter(Boolean).pop();
    const log = newest ? (await d.exec("kubectl", [...k, "-n", state.namespace, "logs", newest, "-c", "migrate", "--tail=20"], { allowFail: true })).out.trim() : "";
    // Rollback is the way back only when a new revision exists and its schema step refused: nothing was applied. After
    // an applied schema it is not (forward only); before any revision it would roll back the good one (review of 5c).
    const refused = after !== null && after > before && /data loss|accept-data-loss/i.test(log);
    const h = clusterFlags(flags, "helm").join(" ");
    return { ok: false, state, error: e.message, migrateLog: log, rollback: refused ? `helm rollback ${state.release} ${before} ${h} -n ${state.namespace}` : null, newRevision: after !== null && after > before };
  }
}

export async function status(d, flags) {
  const state = enrolledState(d, flags);
  const k = clusterFlags(flags, "kubectl");
  const pods = await d.exec("kubectl", [...k, "-n", state.namespace, "get", "pods", "-l", "app.kubernetes.io/name=skaftor-operator", "-o", "wide"], { allowFail: true });
  const rel = await d.exec("helm", ["status", state.release, ...clusterFlags(flags, "helm"), "-n", state.namespace], { allowFail: true });
  return { state, pods: pods.out.trim(), release: rel.out.split("\n").filter((l) => /^(STATUS|REVISION|LAST DEPLOYED):/.test(l)).join("\n") };
}

export function isSecureCloud(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "host.docker.internal"].includes(u.hostname));
  } catch { return false; }
}

function wantsWsToken(flags, state) { return !!(flags["workstations-url"] ?? state.workstationsUrl); }

function asStr(v, name) {
  if (typeof v !== "string" || !v) throw new Error(`missing ${name}`);
  return v;
}

export function realDeps() {
  return {
    exec: realExec,
    env: process.env,
    withValuesFile: realWithValuesFile,
    fetch: (...a) => fetch(...a),
    keyPair: () => generateKeyPairSync("ed25519"),
    random: (n) => randomBytes(n).toString("base64url"),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    loadState: () => loadState(),
    saveState: (s) => saveState(s),
    readSecretKeys,
    writeSecrets,
  };
}

export const operatorHelp = (bold) => `${bold("OPERATOR (BYOC)")}   — your own cluster; always name it: --kube-context <ctx> [--kubeconfig <file>]
  operator enroll <code> --address <https-url> [--store k8s|gcp --project p] [--cloud url] [--namespace n]
                           Make the Operator's key, register it with Skaftor Cloud, keep its secrets with you
  operator install --tag <version> --chart-version <v> [--postgres trial] [--host h --tls-secret s] [--gsa sa]
                   [--workstations-url <in-cluster engine> --workstations-public-url <https>]  (token: SKAFTOR_WORKSTATIONS_TOKEN)
                           Install the Operator (Helm) after enrolling
  operator upgrade --tag <version> [--chart-version <v>]   Move to another platform version
  operator status                    What is running`;

export async function runOperator(sub, rest, flags, out = console) {
  const d = realDeps();
  switch (sub) {
    case "enroll": {
      const r = await enroll(d, rest[0], flags);
      out.log(`enrolled Operator ${r.operatorId} for organization ${r.orgId}; key fingerprint ${r.fingerprint}`);
      out.log(`secrets kept in ${r.store === "gcp" ? `Secret Manager (project ${r.project})` : `Kubernetes Secret ${SECRET_NAME} (namespace ${r.namespace})`}${r.keptCredKey ? "; the existing credentials key was kept" : ""}`);
      if (r.moved) out.log("the installed Operator was moved onto the new enrolment (its id and key)");
      else out.log(`next: skaftor operator install --tag <version> --kube-context ${flags["kube-context"]}`);
      return;
    }
    case "install": {
      const s = await install(d, flags);
      out.log(`installed: Operator ${s.operatorId} in namespace ${s.namespace}. Ask Skaftor to switch your organization to it (Settings → Operator).`);
      return;
    }
    case "upgrade": {
      const r = await upgrade(d, flags);
      if (r.ok) { out.log(`upgraded to ${flags.tag}`); return; }
      out.error(`upgrade did not complete: ${r.error}`);
      if (r.migrateLog) out.error(`\nthe schema step said:\n${r.migrateLog}`);
      if (r.rollback) out.error(`\nthe schema step refused, so nothing was applied and the running version keeps serving. To return to it cleanly: ${r.rollback}`);
      else if (r.newRevision) out.error("\nthe new version did not become ready. Its schema may already be applied, so a rollback is not the way back (the schema is forward only): see `skaftor operator status`, fix the cause, and upgrade again.");
      else out.error("\nnothing changed in the cluster; the running version keeps serving.");
      process.exitCode = 1;
      return;
    }
    case "status": {
      const r = await status(d, flags);
      out.log(`Operator ${r.state.operatorId} (org ${r.state.orgId}) → ${r.state.address}${r.state.pending ? "  [pending: run `skaftor operator upgrade --tag <version>` to finish the enrolment]" : ""}\n${r.release}\n\n${r.pods}`);
      return;
    }
    default:
      throw new Error("usage: skaftor operator <enroll|install|upgrade|status> … (see skaftor help)");
  }
}
