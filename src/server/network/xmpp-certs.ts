import "server-only";
import { docker } from "../docker/client";
import { listApps } from "../docker/apps";
import { execInContainer } from "../dockerx/containers";
import { httpsMode, tryReadConfig, type SubdomainRoute } from "../caddy/routes";
import { audit } from "../audit";
import { getSetting } from "../settings";
import { writeTar, type TarEntry } from "./tarball";
import { CADDY_CONTAINER, readArchive, readCaddyStore } from "./caddy-certs";
import { readOwnCert } from "./own-certs";
import { certInfo, decideCopy, pickCaddyPair, type CertInfo } from "./xmpp-cert-choice";
import { probeXmpp } from "./xmpp-probe";
import type { XmppCertSync } from "@/lib/network-types";

/**
 * A safety net for a chat server's certificate. Caddy holds (and renews) a certificate for every
 * published name, including the chat domain; the chat server reads its own copy from a folder in
 * its container. When that copy is missing, untrusted or close to expiring, Gluon copies Caddy's
 * in, asks the chat server to reload, then checks the server really presents it.
 *
 * Prosody runs under tini and runuser in its official image, so a SIGHUP would most likely kill
 * runuser rather than reach Prosody. The reload goes through prosodyctl's admin shell instead.
 */

async function reloadChatServer(container: string): Promise<{ ok: boolean; output: string }> {
  const ctr = await docker().getContainer(container).inspect();
  let output = "";
  for (const argv of [
    ["prosodyctl", "shell", "config", "reload"],
    ["prosodyctl", "shell", "config:reload()"],
  ]) {
    output = "";
    const r = await execInContainer(
      { id: ctr.Id, name: container, argv, user: "prosody", workdir: undefined, timeoutSec: 20 },
      (e) => {
        if (e.type === "out" || e.type === "err") output += e.text;
      },
      AbortSignal.timeout(30_000),
    );
    if (r.exitCode === 0) return { ok: true, output };
  }
  return { ok: false, output };
}

type G = typeof globalThis & { __gluonXmppCerts?: { state: Map<string, XmppCertSync>; running: Promise<void> | null; runningFull: boolean } };
const g = globalThis as G;
const st = () => (g.__gluonXmppCerts ??= { state: new Map(), running: null, runningFull: false });

export function certSyncState(routeId: string): XmppCertSync | null {
  return st().state.get(routeId) ?? null;
}

/** uid/gid of the `prosody` user inside the container, so a key Gluon writes is readable by it. */
async function prosodyOwner(container: string): Promise<{ uid: number; gid: number } | null> {
  const passwd = await readArchive(container, "/etc/passwd").catch(() => null);
  const line = passwd?.find((e) => e.type === "file")?.data.toString().split("\n").find((l) => l.startsWith("prosody:"));
  const [, , uid, gid] = line?.split(":") ?? [];
  return uid && gid && /^\d+$/.test(uid) && /^\d+$/.test(gid) ? { uid: Number(uid), gid: Number(gid) } : null;
}

type ChatRoute = SubdomainRoute & { xmpp: NonNullable<SubdomainRoute["xmpp"]> };

/** The configured container if it's running, else the running Prosody container of the route's app. */
async function resolveContainer(name: string, appId: string | null): Promise<{ name: string; image: string } | null> {
  try {
    const info = await docker().getContainer(name).inspect();
    if (info.State.Running) return { name, image: info.Config.Image };
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode !== 404) throw e;
  }
  if (!appId) return null;
  const apps = await listApps().catch(() => []);
  const app = apps.find((a) => a.id === appId) ?? apps.find((a) => a.containers.some((c) => c.name === name));
  const c = app?.containers.find((x) => x.state === "running" && /prosody/i.test(x.image));
  return c ? { name: c.name, image: c.image } : null;
}

async function served(r: ChatRoute) {
  return probeXmpp({ host: r.backend.host, port: r.backend.port, domain: r.host, kind: "client", certDays: getSetting("thresholds").certDays });
}

type CaddyCerts = () => Promise<TarEntry[] | null>;

async function syncOne(r: ChatRoute, caddyCerts: CaddyCerts): Promise<XmppCertSync> {
  const target = { ...r.xmpp.cert_sync! };
  const host = r.host;
  const prev = st().state.get(r.id);
  const base: XmppCertSync = { container: target.container, checkedAt: Date.now(), copiedAt: prev?.copiedAt ?? null, ok: false, message: "" };

  const resolved = await resolveContainer(target.container, r.app ?? null);
  if (!resolved) return { ...base, message: `There's no running container called ${target.container} any more. Edit the chat address to pick the right one.` };
  if (!/prosody/i.test(resolved.image)) return { ...base, message: `Gluon only keeps Prosody's certificate current, and ${resolved.name} runs ${resolved.image}.` };
  // An app moved to Gluon gets new container names; follow it instead of the stopped original.
  target.container = resolved.name;
  base.container = resolved.name;

  const before = await served(r);
  // An address with its own certificate hands that one on, not whatever Caddy has in its store.
  const own = httpsMode(r) === "own";
  let src: { crt: Buffer; key: Buffer; info: CertInfo } | null;
  if (own) src = readOwnCert(host);
  else {
    const caddy = await caddyCerts();
    if (!caddy) return { ...base, message: `Gluon can't find Caddy's certificates in the ${CADDY_CONTAINER} container.` };
    src = pickCaddyPair(caddy, host);
  }

  const inChat = await readArchive(target.container, target.dir);
  if (!inChat) return { ...base, message: `${target.dir} doesn't exist in ${target.container}. Check the folder the chat server reads its certificate from.` };
  const dirName = target.dir.split("/").pop()!;
  const folder = inChat.find((e) => e.type === "dir" && e.name === dirName);
  const oldCrt = inChat.find((e) => e.name === `${dirName}/${host}.crt`);
  const oldKey = inChat.find((e) => e.name === `${dirName}/${host}.key`);
  const onDisk = oldCrt ? certInfo(oldCrt.data, host) : null;
  const decision = decideCopy(src?.info ?? null, onDisk, host, Date.now(), before.tls ? before.tls.trusted : null, own ? "own" : "caddy");

  if (!decision.copy) {
    // The file can be right while the server still presents an older one (a reload that didn't
    // take): only call it done when what chat apps see matches what's on disk.
    if (decision.ok && onDisk && before.tls?.fingerprint && before.tls.fingerprint !== onDisk.fingerprint) {
      const reload = await reloadChatServer(target.container).catch(() => ({ ok: false, output: "" }));
      const after = await served(r);
      if (after.tls?.fingerprint === onDisk.fingerprint) return { ...base, ok: true, message: `${decision.reason} Gluon reloaded the chat server so it uses it.` };
      return { ...base, message: `The certificate file is current, but the chat server still presents an older one${reload.ok ? "" : " and didn't reload"}. Restart ${target.container} to load it.` };
    }
    return { ...base, ok: decision.ok, message: decision.reason };
  }

  const prosody = await prosodyOwner(target.container);
  const crtOwner = oldCrt ?? (prosody ? { ...prosody, mode: 0o644 } : folder);
  const keyOwner = oldKey ?? (prosody ? { ...prosody, mode: 0o600 } : folder);
  const tar = writeTar([
    { name: `${host}.crt`, data: src!.crt, mode: oldCrt?.mode ?? 0o644, uid: crtOwner?.uid ?? 0, gid: crtOwner?.gid ?? 0 },
    { name: `${host}.key`, data: src!.key, mode: oldKey?.mode ?? 0o600, uid: keyOwner?.uid ?? 0, gid: keyOwner?.gid ?? 0 },
  ]);
  await docker().getContainer(target.container).putArchive(tar, { path: target.dir });
  const until = new Date(src!.info.notAfter).toISOString().slice(0, 10);
  audit(null, {
    action: "network.xmpp.cert",
    target: host,
    summary: `Copied the certificate for ${host} into ${target.container}`,
    detail: { container: target.container, dir: target.dir, validUntil: until, why: decision.reason },
    outcome: "ok",
  });

  const reload = await reloadChatServer(target.container).catch((e: Error) => ({ ok: false, output: e.message }));
  const after = await served(r);
  const whose = own ? "your certificate" : "Caddy's certificate";
  if (after.tls?.fingerprint === src!.info.fingerprint) return { ...base, copiedAt: Date.now(), ok: true, message: `Copied ${whose} (valid until ${until}) and the chat server is using it.` };
  const why = reload.ok
    ? "the chat server still presents the old one. If restarting doesn't help, check that Prosody can read the key file."
    : `the chat server didn't reload${reload.output.trim() ? ` (${reload.output.trim().slice(0, 160)})` : ""}.`;
  return { ...base, copiedAt: Date.now(), message: `Copied ${whose}, but ${why} Restart ${target.container} to load it.` };
}

const RECHECK_OK_MS = 6 * 60 * 60_000;

/**
 * Compare and, where needed, copy the certificate for every chat address that asks for it.
 * `onlyDue` skips addresses checked recently that were fine, so a frequent timer can retry the
 * ones that need attention without re-reading every certificate.
 */
export function syncChatCertificates(opts: { onlyDue?: boolean } = {}): Promise<void> {
  const s = st();
  // A full check asked for while a partial (timer) pass runs waits for it, then runs in full.
  if (s.running) return opts.onlyDue || s.runningFull ? s.running : s.running.then(() => syncChatCertificates(opts));
  s.runningFull = !opts.onlyDue;
  // Caddy's certificate tree is read once per pass, however many chat addresses there are.
  let caddyTree: Promise<TarEntry[] | null> | null = null;
  const caddyCerts: CaddyCerts = () => (caddyTree ??= readCaddyStore());
  s.running = (async () => {
    const cfg = tryReadConfig();
    // Plain-HTTP and no-web-side addresses have no certificate here to copy.
    const routes = (cfg?.routes ?? []).filter((r): r is ChatRoute => r.type === "subdomain" && r.enabled !== false && !!r.xmpp?.cert_sync && (httpsMode(r) === "auto" || httpsMode(r) === "own"));
    const keep = new Set(routes.map((r) => r.id));
    for (const id of [...s.state.keys()]) if (!keep.has(id)) s.state.delete(id);
    for (const r of routes) {
      const prev = s.state.get(r.id);
      if (opts.onlyDue && prev?.ok && prev.checkedAt && Date.now() - prev.checkedAt < RECHECK_OK_MS && prev.container === r.xmpp.cert_sync!.container) continue;
      try {
        s.state.set(r.id, await syncOne(r, caddyCerts));
      } catch (e) {
        s.state.set(r.id, { container: r.xmpp.cert_sync!.container, checkedAt: Date.now(), copiedAt: prev?.copiedAt ?? null, ok: false, message: `Couldn't check the certificate: ${(e as Error).message}` });
      }
    }
  })().finally(() => {
    s.running = null;
  });
  return s.running;
}
