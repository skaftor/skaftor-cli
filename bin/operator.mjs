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
// Safety: every command names its cluster (--kube-context or --kubeconfig); the current context is never assumed.
// Secrets travel on stdin, never on a command line (where `ps` would show them). Zero dependencies.

import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_CLOUD = "https://app.skaftor.com";
export const DEFAULT_CHART = "oci://us-central1-docker.pkg.dev/skaftorai/charts/skaftor-operator";
export const SECRET_NAME = "skaftor-operator";
// Who the Operator is and where it lives (nothing secret). SKAFTOR_OPERATOR_STATE points elsewhere (a second Operator).
const STATE_FILE = process.env.SKAFTOR_OPERATOR_STATE || join(homedir(), ".skaftor", "operator.json");

/** Runs a tool: argv only (no shell), an optional stdin, its output back. Injected in tests. */
export function realExec(cmd, args, { input, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => reject(Object.assign(new Error(`${cmd}: ${e.message}`), { code: "ENOENT" })));
    p.on("close", (code) => {
      if (code === 0 || allowFail) resolve({ code, out, err });
      else reject(Object.assign(new Error(`${cmd} ${args.slice(0, 3).join(" ")} … failed (${code}): ${err.trim().slice(-600)}`), { code, out, err }));
    });
    if (input !== undefined) p.stdin.end(input); else p.stdin.end();
  });
}

/** The cluster flags for kubectl / helm: an explicit context or kubeconfig, never the current context. */
export function clusterFlags(flags, tool) {
  const ctx = typeof flags["kube-context"] === "string" ? flags["kube-context"] : null;
  const cfg = typeof flags.kubeconfig === "string" ? flags.kubeconfig : null;
  if (!ctx && !cfg) throw new Error("name the cluster: --kube-context <context> or --kubeconfig <file> (the current context is never assumed)");
  const out = [];
  if (cfg) out.push("--kubeconfig", cfg);
  if (ctx) out.push(tool === "helm" ? "--kube-context" : "--context", ctx);
  return out;
}

const ns = (flags) => (typeof flags.namespace === "string" ? flags.namespace : "skaftor");

// ── state (not secret: who the Operator is, where it lives) ─────────────────
export function loadState(file = STATE_FILE) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}
export function saveState(s, file = STATE_FILE) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
  try { chmodSync(file, 0o600); } catch {}
}

// ── secret stores ────────────────────────────────────────────────────────────
// k8s: a Secret in the Operator's namespace. gcp: the customer's Secret Manager (the chart reads it through External
// Secrets). Both read what is there first: the credentials key and the database password are kept across a
// re-enrolment (a new credentials key would leave every stored credential unreadable).
const GCP_NAMES = { SKAFTOR_OPERATOR_KEY: "skaftor-operator-key", CRED_ENC_KEY: "skaftor-operator-cred-enc-key", POSTGRES_PASSWORD: "skaftor-operator-postgres-password" };

export async function readSecretKeys(d, flags) {
  if (flags.store === "gcp") {
    const project = asStr(flags.project, "--project (the Google Cloud project whose Secret Manager keeps the Operator's secrets)");
    const found = {};
    for (const [k, name] of Object.entries(GCP_NAMES)) {
      const r = await d.exec("gcloud", ["secrets", "versions", "access", "latest", `--secret=${name}`, `--project=${project}`], { allowFail: true });
      if (r.code === 0 && r.out) found[k] = r.out;
    }
    return found;
  }
  const r = await d.exec("kubectl", [...clusterFlags(flags, "kubectl"), "-n", ns(flags), "get", "secret", SECRET_NAME, "-o", "json"], { allowFail: true });
  if (r.code !== 0) return {};
  const data = JSON.parse(r.out).data ?? {};
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Buffer.from(String(v), "base64").toString("utf8")]));
}

export async function writeSecrets(d, flags, values) {
  if (flags.store === "gcp") {
    const project = asStr(flags.project, "--project");
    for (const [k, v] of Object.entries(values)) {
      const name = GCP_NAMES[k];
      if (!name) continue;
      const exists = (await d.exec("gcloud", ["secrets", "describe", name, `--project=${project}`], { allowFail: true })).code === 0;
      if (!exists) await d.exec("gcloud", ["secrets", "create", name, `--project=${project}`, "--replication-policy=automatic"]);
      await d.exec("gcloud", ["secrets", "versions", "add", name, `--project=${project}`, "--data-file=-"], { input: v });
    }
    return;
  }
  const k = [...clusterFlags(flags, "kubectl")];
  await d.exec("kubectl", [...k, "create", "namespace", ns(flags)], { allowFail: true });
  const manifest = {
    apiVersion: "v1", kind: "Secret", type: "Opaque",
    metadata: { name: SECRET_NAME, namespace: ns(flags), labels: { "app.kubernetes.io/name": "skaftor-operator" } },
    data: Object.fromEntries(Object.entries(values).map(([key, v]) => [key, Buffer.from(v, "utf8").toString("base64")])),
  };
  await d.exec("kubectl", [...k, "apply", "-f", "-"], { input: JSON.stringify(manifest) });
}

// ── enroll ───────────────────────────────────────────────────────────────────
export async function enroll(d, code, flags) {
  if (!code) throw new Error("usage: skaftor operator enroll <code> --address https://operator.example.com --kube-context <ctx> [--store k8s|gcp --project <p>] [--cloud <url>]");
  const address = asStr(flags.address, "--address (where browsers will reach this Operator, https)");
  let addr;
  try { addr = new URL(address); } catch { throw new Error("--address must be a URL"); }
  if (addr.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(addr.hostname)) throw new Error("--address must be https (browsers reach the Operator directly)");
  const cloud = String(flags.cloud || DEFAULT_CLOUD).replace(/\/+$/, "");
  if (flags.store !== "gcp") clusterFlags(flags, "kubectl"); // the cluster is named before anything is made

  const existing = await d.readSecretKeys(d, flags);
  const { privateKey, publicKey } = d.keyPair();
  const r = await d.fetch(`${cloud}/api/operator/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, address: addr.origin, publicKey: publicKey.export({ format: "jwk" }) }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.operatorId) throw new Error(`Skaftor Cloud refused the enrolment: ${j.error ?? `HTTP ${r.status}`}`);

  const values = {
    SKAFTOR_OPERATOR_KEY: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    CRED_ENC_KEY: existing.CRED_ENC_KEY || d.random(32),
    POSTGRES_PASSWORD: existing.POSTGRES_PASSWORD || d.random(24),
  };
  if (existing.DATABASE_URL) values.DATABASE_URL = existing.DATABASE_URL;
  await d.writeSecrets(d, flags, values);
  // An Operator already installed runs as its old enrolment (its id is a chart value, its key read at start): move it
  // onto the new one — the id and the key together, in one rollout (found live: a restart alone kept the old id).
  let restarted = false;
  if (flags.store !== "gcp") {
    const release = String(flags.release || "skaftor-operator");
    const h = clusterFlags(flags, "helm");
    const installed = (await d.exec("helm", ["status", release, ...h, "-n", ns(flags)], { allowFail: true })).code === 0;
    if (installed) {
      await d.exec("helm", ["upgrade", release, String(flags.chart || DEFAULT_CHART), ...h, "-n", ns(flags), "--reuse-values", "--wait", "--timeout", String(flags.timeout || "10m"),
        "--set-string", `operator.id=${j.operatorId}`, "--set-string", `operator.orgId=${j.orgId}`, "--set-string", `operator.address=${addr.origin}`]);
      restarted = true;
    }
  }
  const state = { operatorId: j.operatorId, orgId: j.orgId, fingerprint: j.fingerprint, cloud, address: addr.origin, namespace: ns(flags), store: flags.store === "gcp" ? "gcp" : "k8s", ...(flags.project ? { project: String(flags.project) } : {}), enrolledAt: new Date().toISOString() };
  d.saveState(state);
  return { ...state, keptCredKey: !!existing.CRED_ENC_KEY, restarted };
}

// ── install / upgrade ────────────────────────────────────────────────────────
/** The helm arguments for an install or upgrade — no secret among them (they come from the Secret / Secret Manager). */
export function helmArgs(state, flags, mode) {
  const tag = asStr(flags.tag, "--tag (the platform version to run)");
  const a = ["upgrade", ...(mode === "install" ? ["--install"] : []), String(flags.release || "skaftor-operator"), String(flags.chart || DEFAULT_CHART), ...clusterFlags(flags, "helm"), "-n", state.namespace, "--wait", "--timeout", String(flags.timeout || "10m")];
  const set = (k, v) => a.push("--set-string", `${k}=${v}`);
  if (mode === "upgrade") a.push("--reuse-values");
  set("image.tag", tag);
  if (mode === "install") {
    set("operator.cloudUrl", state.cloud);
    set("operator.id", state.operatorId);
    set("operator.orgId", state.orgId);
    set("operator.address", state.address);
    if (flags.image) set("image.repository", flags.image);
    if (flags["pull-policy"]) set("image.pullPolicy", flags["pull-policy"]);
    if (flags["pull-secret"]) set("image.pullSecrets[0]", flags["pull-secret"]);
    if (flags.postgres === "trial") a.push("--set", "postgres.enabled=true");
    if (flags["postgres-storage"]) set("postgres.storage", flags["postgres-storage"]);
    if (state.store === "gcp") {
      a.push("--set", "secrets.externalSecrets.enabled=true");
      set("secrets.externalSecrets.storeRef.name", asStr(flags["secret-store"], "--secret-store (the External Secrets store for your Secret Manager)"));
    }
    if (flags.host) {
      a.push("--set", "ingress.enabled=true");
      set("ingress.host", flags.host);
      set("ingress.tlsSecretName", asStr(flags["tls-secret"], "--tls-secret (browsers reach the Operator over TLS only)"));
      if (flags["ingress-class"]) set("ingress.className", flags["ingress-class"]);
    }
    if (flags.gsa) set("serviceAccount.worker.annotations.iam\\.gke\\.io/gcp-service-account", flags.gsa);
  }
  return a;
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
  if (state.store === "k8s") {
    const keys = Object.keys(await d.readSecretKeys(d, { ...flags, namespace: state.namespace }));
    const need = ["SKAFTOR_OPERATOR_KEY", "CRED_ENC_KEY", flags.postgres === "trial" ? "POSTGRES_PASSWORD" : "DATABASE_URL"];
    const missing = need.filter((x) => !keys.includes(x));
    if (missing.length) problems.push(`the Secret ${SECRET_NAME} in ${state.namespace} lacks ${missing.join(", ")}${missing.includes("DATABASE_URL") ? " (add your database's address, or use --postgres trial)" : " (run skaftor operator enroll)"}`);
  }
  return problems;
}

export async function install(d, flags) {
  const state = d.loadState();
  if (!state) throw new Error("not enrolled here yet — run `skaftor operator enroll <code>` first");
  if (flags.namespace && flags.namespace !== state.namespace) throw new Error(`this Operator was enrolled for namespace ${state.namespace}`);
  const problems = await preflight(d, state, flags);
  if (problems.length) throw new Error(`cannot install:\n  - ${problems.join("\n  - ")}`);
  await d.exec("helm", helmArgs(state, flags, "install"));
  return state;
}

export async function upgrade(d, flags) {
  const state = d.loadState();
  if (!state) throw new Error("no Operator enrolled here — run `skaftor operator enroll <code>` first");
  try {
    await d.exec("helm", helmArgs(state, flags, "upgrade"));
    return { ok: true, state };
  } catch (e) {
    // The schema step refuses a change that would drop data: the new pods wait in Init, the running version serves.
    const k = clusterFlags(flags, "kubectl");
    const pods = await d.exec("kubectl", [...k, "-n", state.namespace, "get", "pods", "-l", "app.kubernetes.io/name=skaftor-operator,app.kubernetes.io/component=web", "--sort-by=.metadata.creationTimestamp", "-o", "name"], { allowFail: true });
    const newest = pods.out.trim().split("\n").filter(Boolean).pop();
    const logs = newest ? (await d.exec("kubectl", [...k, "-n", state.namespace, "logs", newest, "-c", "migrate", "--tail=20"], { allowFail: true })).out : "";
    return { ok: false, state, error: e.message, migrateLog: logs.trim(), rollback: `helm rollback ${flags.release || "skaftor-operator"} ${clusterFlags(flags, "helm").join(" ")} -n ${state.namespace}` };
  }
}

export async function status(d, flags) {
  const state = d.loadState();
  if (!state) throw new Error("no Operator enrolled here");
  const k = clusterFlags(flags, "kubectl");
  const pods = await d.exec("kubectl", [...k, "-n", state.namespace, "get", "pods", "-l", "app.kubernetes.io/name=skaftor-operator", "-o", "wide"], { allowFail: true });
  const rel = await d.exec("helm", ["status", String(flags.release || "skaftor-operator"), ...clusterFlags(flags, "helm"), "-n", state.namespace], { allowFail: true });
  return { state, pods: pods.out.trim(), release: rel.out.split("\n").filter((l) => /^(STATUS|REVISION|LAST DEPLOYED):/.test(l)).join("\n") };
}

function asStr(v, name) {
  if (typeof v !== "string" || !v) throw new Error(`missing ${name}`);
  return v;
}

export function realDeps() {
  return {
    exec: realExec,
    fetch: (...a) => fetch(...a),
    keyPair: () => generateKeyPairSync("ed25519"),
    random: (n) => randomBytes(n).toString("base64url"),
    loadState: () => loadState(),
    saveState: (s) => saveState(s),
    readSecretKeys,
    writeSecrets,
  };
}

export const operatorHelp = (bold) => `${bold("OPERATOR (BYOC)")}   ${"— your own cluster; always name it: --kube-context <ctx> | --kubeconfig <file>"}
  operator enroll <code> --address <https-url> [--store k8s|gcp --project p] [--cloud url] [--namespace n]
                           Make the Operator's key, register it with Skaftor Cloud, keep its secrets with you
  operator install --tag <version> [--postgres trial] [--host h --tls-secret s] [--gsa sa] [--pull-secret s]
                           Install the Operator (Helm) after enrolling
  operator upgrade --tag <version>   Move to another platform version (a data-losing schema change stops)
  operator status                    What is running`;

export async function runOperator(sub, rest, flags, out = console) {
  const d = realDeps();
  switch (sub) {
    case "enroll": {
      const r = await enroll(d, rest[0], flags);
      out.log(`enrolled Operator ${r.operatorId} for organization ${r.orgId}; key fingerprint ${r.fingerprint}`);
      out.log(`secrets kept in ${r.store === "gcp" ? `Secret Manager (project ${r.project})` : `Kubernetes Secret ${SECRET_NAME} (namespace ${r.namespace})`}${r.keptCredKey ? "; the existing credentials key was kept" : ""}`);
      if (r.restarted) out.log("the installed Operator was moved onto the new enrolment (its id and key)");
      else if (r.store === "gcp") out.log("if an Operator is already running, restart it once External Secrets has refreshed (it reads its key at start)");
      if (!r.restarted) out.log(`next: skaftor operator install --tag <version> ${flags["kube-context"] ? `--kube-context ${flags["kube-context"]}` : `--kubeconfig ${flags.kubeconfig}`}`);
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
      out.error(`\nthe running version keeps serving. To return to it cleanly: ${r.rollback}`);
      process.exitCode = 1;
      return;
    }
    case "status": {
      const r = await status(d, flags);
      out.log(`Operator ${r.state.operatorId} (org ${r.state.orgId}) → ${r.state.address}\n${r.release}\n\n${r.pods}`);
      return;
    }
    default:
      throw new Error("usage: skaftor operator <enroll|install|upgrade|status> … (see skaftor help)");
  }
}

