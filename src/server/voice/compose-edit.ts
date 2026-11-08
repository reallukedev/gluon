import { Scalar, YAMLSeq, isMap, isScalar, isSeq, type Document, type YAMLMap } from "yaml";
import { parseCompose, parsePortString, readService, serviceNode, stringify } from "@/lib/builder/compose";

/** Edits are made in place so comments, other services and keys Gluon doesn't know survive. */

export const ICE_CONTAINER_PORT = 6502;
export const ENV_FILE = "gluon-voice.env";

/** Variables the manage step takes over: Ice's address and secrets, and the admin password Mumble re-applies at every start. */
const TAKEN_OVER = /^MUMBLE_(CONFIG_ICE(SECRET(READ|WRITE)?)?|SUPERUSER_PASSWORD)$/;

export interface EnvEdit {
  set?: Record<string, string>;
  remove?: (name: string) => boolean;
}

function envKeyOf(item: unknown): string | null {
  const s = isScalar(item) ? String(item.value ?? "") : typeof item === "string" ? item : null;
  if (s === null) return null;
  const eq = s.indexOf("=");
  return eq > 0 ? s.slice(0, eq) : s || null;
}

/** Handles both the map and the KEY=value list forms. */
function editEnv(doc: Document, svc: YAMLMap, edit: EnvEdit): string[] {
  const removed: string[] = [];
  const set = edit.set ?? {};
  const drop = (k: string) => k in set || !!edit.remove?.(k);
  let env = svc.get("environment", true);
  if (!env && Object.keys(set).length) {
    svc.set("environment", doc.createNode({}));
    env = svc.get("environment", true);
  }
  if (isMap(env)) {
    for (const p of [...env.items]) {
      const k = isScalar(p.key) ? String(p.key.value) : String(p.key);
      if (drop(k)) {
        env.delete(k);
        if (!(k in set)) removed.push(k);
      }
    }
    for (const [k, v] of Object.entries(set)) env.set(k, doc.createNode(v.replace(/\$/g, "$$$$")));
  } else if (isSeq(env)) {
    env.items = env.items.filter((it) => {
      const k = envKeyOf(it);
      if (k && drop(k)) {
        if (!(k in set)) removed.push(k);
        return false;
      }
      return true;
    });
    for (const [k, v] of Object.entries(set)) env.items.push(doc.createNode(`${k}=${v.replace(/\$/g, "$$$$")}`));
  }
  if ((isMap(env) || isSeq(env)) && env.items.length === 0) svc.delete("environment");
  return removed;
}

function quoted(doc: Document, v: string): Scalar {
  const s = doc.createNode(v) as Scalar;
  s.type = Scalar.QUOTE_DOUBLE;
  return s;
}

function containerPortOf(item: unknown): number | null {
  if (isMap(item)) {
    const t = Number((item.get("target") as unknown) ?? NaN);
    return Number.isFinite(t) ? t : null;
  }
  const s = isScalar(item) ? String(item.value ?? "") : typeof item === "string" ? item : "";
  const r = parsePortString(s);
  return r.raw === null ? r.container : null;
}

export interface ManageEdit {
  text: string;
  /** Variables that left the file (they move to the secret file, or Gluon stops setting them). */
  removed: string[];
  hostNetwork: boolean;
}

/**
 * Ice's secrets come from `envFile`, or for builder apps (envFile null) from the builder's secrets.
 * With its own network Docker publishes Ice on 127.0.0.1 only; on the host's network there is nothing
 * to publish, so Ice listens on 127.0.0.1.
 */
export function manageCompose(text: string, service: string, opts: { port: number; envFile: string | null }): ManageEdit {
  const parsed = parseCompose(text);
  if (!parsed.ok) throw new Error("The compose file has errors, so Gluon can't change it safely. Fix it in the Compose tab first.");
  const doc = parsed.doc;
  const svc = serviceNode(doc, service);
  if (!svc) throw new Error(`The compose file has no service called ${service}.`);
  const form = readService(doc, service);
  const ice = form.hostNetwork ? `tcp -h 127.0.0.1 -p ${opts.port}` : `tcp -h 0.0.0.0 -p ${ICE_CONTAINER_PORT}`;
  const removed = editEnv(doc, svc, { set: { MUMBLE_CONFIG_ICE: ice }, remove: (k) => TAKEN_OVER.test(k) });

  if (!form.hostNetwork) {
    let ports = svc.get("ports", true);
    if (!isSeq(ports)) {
      svc.set("ports", new YAMLSeq());
      ports = svc.get("ports", true);
    }
    const seq = ports as unknown as YAMLSeq;
    seq.items = seq.items.filter((it) => containerPortOf(it) !== ICE_CONTAINER_PORT);
    seq.items.push(quoted(doc, `127.0.0.1:${opts.port}:${ICE_CONTAINER_PORT}`));
  }

  if (opts.envFile) {
    const cur = svc.get("env_file", true);
    const names = (isSeq(cur) ? cur.items : cur ? [cur] : []).map((it) => (isMap(it) ? String(it.get("path") ?? "") : isScalar(it) ? String(it.value ?? "") : String(it)));
    if (!names.some((n) => n.replace(/^\.\//, "") === opts.envFile)) {
      const seq = isSeq(cur) ? cur : new YAMLSeq();
      if (!isSeq(cur) && cur) seq.items.push(cur as Scalar);
      seq.items.push(doc.createNode(opts.envFile));
      svc.set("env_file", seq);
    }
  }
  return { text: stringify(doc), removed, hostNetwork: form.hostNetwork };
}

export function editServiceEnv(text: string, service: string, edit: EnvEdit): { text: string; removed: string[] } {
  const parsed = parseCompose(text);
  if (!parsed.ok) throw new Error("The compose file has errors, so Gluon can't change it safely. Fix it in the Compose tab first.");
  const svc = serviceNode(parsed.doc, service);
  if (!svc) throw new Error(`The compose file has no service called ${service}.`);
  const removed = editEnv(parsed.doc, svc, edit);
  return { text: stringify(parsed.doc), removed };
}

/** Values are base64url, so they never need quoting. */
export function iceEnvFile(secrets: { write: string; read: string }): string {
  return `# Written by Gluon: the secrets it uses to manage this voice server. Keep this file private.\nMUMBLE_CONFIG_ICESECRETWRITE=${secrets.write}\nMUMBLE_CONFIG_ICESECRETREAD=${secrets.read}\n`;
}

export function mumbleService(text: string): string | null {
  const parsed = parseCompose(text);
  if (!parsed.ok) return null;
  const services = parsed.doc.get("services", true);
  if (!isMap(services)) return null;
  for (const p of services.items) {
    const name = isScalar(p.key) ? String(p.key.value) : String(p.key);
    const image = readService(parsed.doc, name).image;
    if (/(^|\/)(mumble-?server|murmur)(:|@|$)|mumblevoip\//i.test(image)) return name;
  }
  return null;
}
