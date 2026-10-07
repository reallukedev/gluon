import "server-only";
import { registerCheck } from "../alerts/engine";
import { raise, resolveMissing, type Remedy } from "../findings";
import { coveredByWildcard, tryReadConfig } from "../caddy/routes";
import { listApps } from "../docker/apps";
import { getSetting } from "../settings";
import { networkStatus, pendingFor, xmppVerdict } from "./status";
import { ddnsStatus } from "./ddns";
import { exposureReport } from "./exposure";
import { FALLBACK_ID } from "./routes-meta";

/**
 * Findings for the Network domain:
 *  net.cert     certificate expiring / expired / not issued (pending > 30 min or Caddy reported an error)
 *  net.backend  a public address whose app isn't answering (2 checks in a row)
 *  net.dns      a public name that doesn't resolve, or resolves somewhere else
 *  net.ddns     the dynamic DNS updater is stopped or reporting errors
 *  net.exposed  an app with no login of its own is on the internet
 *  net.xmpp     a chat server people can't sign in to, or whose certificate or federation needs work (2 checks in a row)
 *  net.reach    the router doesn't let people outside reach a chat or voice port (2 checks in a row)
 */

const PENDING_GRACE = 30 * 60_000;
const failures = new Map<string, number>();

const addressHref = (id: string) => `/network?route=${encodeURIComponent(id)}`;

registerCheck("network-status", 120_000, async () => {
  if (!tryReadConfig()) return;
  const status = await networkStatus({ maxAgeMs: 60_000 });
  const certDays = getSetting("thresholds").certDays;
  const apps = await listApps().catch(() => []);
  const openCert = new Set<string>();
  const openBackend = new Set<string>();
  const openDns = new Set<string>();
  const openXmpp = new Set<string>();
  const openReach = new Set<string>();
  const seenHosts = new Set<string>();

  for (const r of status.routes) {
    if (!r.enabled) continue;
    const name = r.app?.name ?? r.name;

    // ---- backend down (debounced)
    if (r.backend) {
      const key = r.id;
      if (!r.backend.reachable) failures.set(key, (failures.get(key) ?? 0) + 1);
      else failures.delete(key);
      if ((failures.get(key) ?? 0) >= 2) {
        const id = `net.backend:${r.id}`;
        openBackend.add(id);
        const app = r.app ? apps.find((a) => a.id === r.app!.appId) : undefined;
        const stopped = app && (app.line === "stopped" || app.containers.every((c) => c.state !== "running"));
        const remedy: Remedy = stopped
          ? { action: "apps.start", label: `Start ${app!.name}`, params: { id: app!.id } }
          : app
            ? { action: "", label: "Open the app", href: `/apps/${encodeURIComponent(app.id)}` }
            : { action: "", label: "Check the address", href: addressHref(r.id) };
        raise({
          id,
          kind: "net.backend",
          severity: "fault",
          subject: r.app?.appId ?? r.id,
          title: `${r.url.replace(/^https:\/\//, "").replace(/\/$/, "")} is down`,
          cause: stopped
            ? `${name} is stopped, so visitors get an error page.`
            : `${name} isn't answering on port ${r.backend.port} (${r.backend.error}), so visitors get an error page.`,
          detail: { route: r.id, port: r.backend.port, error: r.backend.error },
          remedy,
        });
      }
    }

    // ---- certificate (once per host)
    if (r.tls && !seenHosts.has(r.host)) {
      seenHosts.add(r.host);
      const t = r.tls;
      const id = `net.cert:${r.host}`;
      const pendingMs = pendingFor(r.host) ?? 0;
      if (r.https === "own") {
        // Gluon can't renew these, so "ends soon" is news three weeks out, not when renewal fails.
        if (t.status === "expired" || t.status === "expiring" || t.status === "invalid") {
          openCert.add(id);
          raise({
            id,
            kind: "net.cert",
            severity: t.status === "expired" || (t.daysLeft ?? 0) < 3 ? "fault" : "attention",
            subject: r.host,
            title: t.status === "expired" ? `Your certificate for ${r.host} has expired` : t.status === "invalid" ? `Caddy isn't serving your certificate for ${r.host}` : `Your certificate for ${r.host} ends in ${t.daysLeft} day${t.daysLeft === 1 ? "" : "s"}`,
            cause: t.status === "invalid" ? t.message : `${t.status === "expired" ? "Browsers now show a security warning." : "Browsers will show a security warning after that."} You supplied this certificate, so Gluon can't renew it: replace it in the address's HTTPS settings, or point Gluon at the files your renewal tool keeps current.`,
            detail: { host: r.host, daysLeft: t.daysLeft, issuer: t.issuer, validTo: t.validTo, own: true },
            remedy: { action: "", label: "Replace the certificate", href: addressHref(r.id) },
          });
        }
      } else if (t.status === "expired" || (t.status === "expiring" && (t.daysLeft ?? 99) < certDays)) {
        openCert.add(id);
        raise({
          id,
          kind: "net.cert",
          severity: t.status === "expired" || (t.daysLeft ?? 0) < 3 ? "fault" : "attention",
          subject: r.host,
          title: t.status === "expired" ? `The certificate for ${r.host} has expired` : `The certificate for ${r.host} expires in ${t.daysLeft} day${t.daysLeft === 1 ? "" : "s"}`,
          cause:
            t.status === "expired"
              ? "Browsers now show a security warning. Caddy renews automatically, so something is blocking it (DNS, port forwarding, or Let's Encrypt limits)."
              : "Caddy normally renews certificates 30 days before they expire, so renewal seems to be failing. Its log usually says why.",
          detail: { host: r.host, daysLeft: t.daysLeft, issuer: t.issuer, validTo: t.validTo, issueError: t.issueError },
          remedy: { action: "", label: "See Caddy's log", href: "/diagnostics?tab=requests" },
        });
      } else if (t.status === "pending" && (t.issueError || pendingMs > PENDING_GRACE)) {
        openCert.add(id);
        raise({
          id,
          kind: "net.cert",
          severity: "attention",
          subject: r.host,
          title: `Caddy couldn't get a certificate for ${r.host}`,
          cause: t.issueError ?? `It has been waiting ${Math.round(pendingMs / 60_000)} minutes. Check that ${r.host} resolves to this network and that ports 80 and 443 are forwarded to this server.`,
          detail: { host: r.host, issueError: t.issueError, pendingMinutes: Math.round(pendingMs / 60_000) },
          remedy: { action: "", label: "Check DNS and certificates", href: addressHref(r.id) },
        });
      }
    }

    // ---- DNS (subdomains; the base domain is covered by its own entry)
    if (r.dns && (r.type === "subdomain" || r.id === FALLBACK_ID)) {
      const id = `net.dns:${r.host}`;
      if (r.dns.status === "missing" || r.dns.status === "mismatch") {
        openDns.add(id);
        raise({
          id,
          kind: "net.dns",
          severity: r.dns.status === "missing" ? "fault" : "attention",
          subject: r.host,
          title: r.dns.status === "missing" ? `${r.host} has no DNS record` : `${r.host} points somewhere else`,
          cause:
            r.dns.status === "missing"
              ? `Nobody can reach it by name. ${dnsFix(r.host, status)}`
              : `${r.dns.message} ${r.host === status.baseDomain || r.host.endsWith(`.${status.baseDomain}`) ? "The dynamic DNS updater should fix this within a few minutes; if it doesn't, check its log." : `Change its A record to ${status.publicIp.v4 ?? "this network's public address"} wherever the domain's DNS is managed.`}`,
          detail: { host: r.host, a: r.dns.a, aaaa: r.dns.aaaa, publicIp: status.publicIp },
          remedy: { action: "", label: "See DNS", href: "/network?hop=dns" },
        });
      }
    }

    // ---- chat server (debounced like the backend: one failed handshake isn't news)
    if (r.xmpp) {
      const verdict = xmppVerdict(r.xmpp);
      const key = `xmpp:${r.id}`;
      if (verdict) failures.set(key, (failures.get(key) ?? 0) + 1);
      else failures.delete(key);
      if (verdict && (failures.get(key) ?? 0) >= 2) {
        const id = `net.xmpp:${r.id}`;
        openXmpp.add(id);
        raise({
          id,
          kind: "net.xmpp",
          severity: verdict.state,
          subject: r.app?.appId ?? r.id,
          title: verdict.state === "fault" ? `People can't use the chat server at ${r.host}` : `The chat server at ${r.host} needs attention`,
          cause: verdict.summary,
          detail: { route: r.id, c2s: r.xmpp.c2s, s2s: r.xmpp.s2s, certSync: r.xmpp.certSync },
          remedy: { action: "", label: "Check the chat server", href: addressHref(r.id) },
        });
      }
    }

    // ---- the router lets chat or voice apps in (debounced: one lost packet isn't news)
    const reach = r.xmpp?.reach ?? r.voice?.reach ?? null;
    if (reach) {
      const key = `reach:${r.id}`;
      const blocked = reach.state === "blocked" ? reach.ports.filter((p) => p.verdict === "not-forwarded" || p.verdict === "elsewhere") : [];
      if (blocked.length) failures.set(key, (failures.get(key) ?? 0) + 1);
      else failures.delete(key);
      if (blocked.length && (failures.get(key) ?? 0) >= 2) {
        const id = `net.reach:${r.id}`;
        openReach.add(id);
        const what = r.voice ? "voice" : "chat";
        const primary = blocked.some((p) => p.primary);
        raise({
          id,
          kind: "net.reach",
          severity: primary ? "fault" : "attention",
          subject: r.app?.appId ?? r.id,
          title: primary ? `People outside can't reach the ${what} server at ${r.host}` : `Part of the ${what} server at ${r.host} is blocked from outside`,
          cause: blocked.map((p) => p.message).join(" "),
          detail: { route: r.id, publicIp: reach.publicIp, lanIp: reach.lanIp, gateway: reach.gateway, ports: blocked.map((p) => ({ port: p.port, proto: p.proto, verdict: p.verdict })) },
          remedy: { action: "", label: "See what to forward", href: addressHref(r.id) },
        });
      }
    }
  }
  for (const k of [...failures.keys()]) {
    const [kind, ...rest] = k.split(":");
    const id = kind === "xmpp" || kind === "reach" ? rest.join(":") : k;
    if (!status.routes.some((r) => r.id === id && r.enabled && (kind === "xmpp" ? r.xmpp : kind === "reach" ? r.xmpp?.reach || r.voice?.reach : true))) failures.delete(k);
  }
  resolveMissing("net.backend", openBackend);
  resolveMissing("net.cert", openCert);
  resolveMissing("net.dns", openDns);
  resolveMissing("net.xmpp", openXmpp);
  resolveMissing("net.reach", openReach);
});

/** What to add so a name resolves: the DDNS updater for names under the base domain, plain records anywhere else. */
function dnsFix(host: string, status: Awaited<ReturnType<typeof networkStatus>>): string {
  const base = status.baseDomain;
  const v4 = status.publicIp.v4;
  const v6 = status.publicIp.v6[0];
  if (host === base || host.endsWith(`.${base}`)) {
    if (coveredByWildcard(host, base) && status.wildcard?.status === "missing") return `There's no wildcard record for *.${base} either; add one, or add this name to the DDNS updater's DOMAINS.`;
    return "Add a record for it where the domain's DNS is managed, or add it to the DDNS updater's DOMAINS.";
  }
  const records = [`an A record for ${host} pointing at ${v4 ?? "this network's public address"}`, ...(v6 ? [`an AAAA record pointing at ${v6}`] : [])];
  return `Add ${records.join(" and ")} wherever ${host}'s DNS is managed.`;
}

registerCheck("network-ddns", 300_000, async () => {
  const d = await ddnsStatus(true);
  const open = new Set<string>();
  if (d.container.exists && (!d.container.running || d.errors.length)) {
    open.add("net.ddns");
    raise({
      id: "net.ddns",
      kind: "net.ddns",
      severity: "attention",
      subject: d.container.name,
      title: d.container.running ? "Dynamic DNS updates are failing" : "Dynamic DNS updates have stopped",
      cause: d.container.running
        ? `${d.errors.at(-1)?.message ?? "The updater reported an error."} If your internet address changes, your public addresses will stop working until this is fixed.`
        : `${d.container.name} isn't running. If your internet address changes, your public addresses will stop working.`,
      detail: { container: d.container.name, errors: d.errors.map((e) => e.message).slice(-5) },
      remedy:
        !d.container.running && d.container.project
          ? { action: "apps.start", label: "Start the updater", params: { id: d.container.project } }
          : { action: "", label: "Read its log", href: "/network?hop=router" },
    });
  }
  resolveMissing("net.ddns", open);
});

registerCheck("network-exposure", 15 * 60_000, async () => {
  if (!tryReadConfig()) return;
  const report = await exposureReport({ maxAgeMs: 5 * 60_000 });
  const open = new Set<string>();
  for (const x of report.internet) {
    if (x.login.verdict !== "no-login" || x.onlyPaths) continue;
    const id = `net.exposed:${x.routeId}`;
    open.add(id);
    const where = x.url.replace(/^https:\/\//, "").replace(/\/$/, "");
    raise({
      id,
      kind: "net.exposed",
      severity: "attention",
      subject: x.app?.appId ?? x.routeId,
      title: `${x.name} is on the internet without a login`,
      cause: `Anyone who finds ${where} can use it. ${x.login.evidence ?? ""}`.trim(),
      detail: { route: x.routeId, url: x.url, evidence: x.login.evidence, declared: x.login.declared, probe: x.login.probe },
      remedy: { action: "", label: "Review what's exposed", href: `/network?route=${encodeURIComponent(x.routeId)}` },
    });
  }
  resolveMissing("net.exposed", open);
});
