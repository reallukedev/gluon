import "server-only";
import { dnsLookup, httpRequest } from "../tools";
import { tryReadConfig } from "../../caddy/routes";
import { networkStatus } from "../../network/status";
import { lookupPublicIpv4 } from "../../network/probes";
import { defaultGateways, hostNameservers, pingSeries } from "./probes";
import { fail, go, kv, ms, ok, skip, warn, type CheckCtx, type CheckSpec } from "./core";

/** Is this server on the internet? Gateway, name lookups, outbound HTTPS, and whether DNS points here. */

export const PROBE_NAME = "cloudflare.com";
export const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";

export const gatewayInfo = (ctx: CheckCtx) => ctx.memo("gateways", defaultGateways);
export const netStatus = (ctx: CheckCtx) => ctx.memo("netstatus", () => networkStatus({ force: true }));

export function gatewayCheck(group: string, hop = false): CheckSpec {
  return {
    id: "internet.gateway",
    group,
    label: "Router",
    hop,
    run: async (ctx) => {
      const gws = await gatewayInfo(ctx);
      const v4 = gws.find((g) => g.family === 4) ?? gws[0];
      if (!v4) return fail("The server has no route to the internet", { detail: "There's no default gateway. Check the network cable and the router, then the server's network settings.", evidence: "ip route show default: (empty)" });
      const p = await pingSeries(v4.gateway, 5, 0.2, ctx.signal);
      const evidence = kv([
        ["Gateway", `${v4.gateway}${v4.dev ? ` via ${v4.dev}` : ""}`],
        ["Replies", `${p.received} of ${p.sent}`],
        ["Round trip", p.avg === null ? null : `${ms(p.min)} min, ${ms(p.avg)} avg, ${ms(p.max)} max`],
      ]);
      if (p.received === 0) {
        return warn(`The router (${v4.gateway}) didn't answer ping`, { value: "no reply", detail: "Some routers ignore ping, so this alone isn't proof of a problem. If the internet checks below also fail, restart the router.", evidence });
      }
      if (p.lossPct >= 20) return warn(`The router answers, but ${p.lossPct}% of pings were lost`, { value: ms(p.avg), detail: "Loss on the local network usually means a bad cable, port or Wi-Fi link.", evidence });
      if ((p.avg ?? 0) > 20) return warn(`The router is slow to answer (${ms(p.avg)})`, { value: ms(p.avg), detail: "On a wired network the router normally answers in a millisecond or two.", evidence });
      return ok(`The router (${v4.gateway}) answers in ${ms(p.avg)}`, { value: ms(p.avg), evidence });
    },
  };
}

export function systemDnsCheck(group: string, hop = false): CheckSpec {
  return {
    id: "internet.dns-system",
    group,
    label: "Name lookups",
    sub: hostNameservers()[0] ?? null,
    hop,
    run: async () => {
      const servers = hostNameservers();
      const server = servers[0];
      if (!server) return fail("The server has no DNS resolver set", { detail: "/etc/resolv.conf lists no nameserver, so nothing can be looked up by name." });
      const r = await dnsLookup(PROBE_NAME, "A", server);
      const evidence = kv([
        ["Resolver", `${server}${servers.length > 1 ? ` (also ${servers.slice(1).join(", ")})` : ""}`],
        ["Status", r.status],
        ["Answers", r.answers.map((a) => a.data).join(", ")],
        ["Query time", ms(r.queryMs)],
      ]);
      if (r.status !== "NOERROR" || !r.answers.length) {
        return fail(`The server's resolver (${server}) can't look up names`, { value: r.status.toLowerCase(), detail: `${r.message} Try 1.1.1.1 in the router's DNS settings, or restart the router.`, evidence });
      }
      if ((r.queryMs ?? 0) > 400) return warn(`Name lookups are slow (${ms(r.queryMs)})`, { value: ms(r.queryMs), detail: "Every new connection waits for this. A faster resolver (like 1.1.1.1) usually helps.", evidence });
      return ok(`Names resolve through ${server} in ${ms(r.queryMs)}`, { value: ms(r.queryMs), evidence });
    },
  };
}

export function publicDnsCheck(group: string): CheckSpec {
  return {
    id: "internet.dns-public",
    group,
    label: "DNS through 1.1.1.1",
    run: async () => {
      const r = await dnsLookup(PROBE_NAME, "A", "cloudflare");
      const evidence = kv([
        ["Resolver", "1.1.1.1"],
        ["Status", r.status],
        ["Answers", r.answers.map((a) => a.data).join(", ")],
        ["Query time", ms(r.queryMs)],
      ]);
      if (r.status !== "NOERROR" || !r.answers.length) return fail("Cloudflare's resolver (1.1.1.1) can't be reached", { detail: `${r.message} Outbound DNS may be blocked, or the internet connection is down.`, evidence });
      return ok(`Cloudflare's resolver answers in ${ms(r.queryMs)}`, { value: ms(r.queryMs), evidence });
    },
  };
}

export function httpsCheck(group: string, hop = false): CheckSpec {
  return {
    id: "internet.https",
    group,
    label: "Secure websites",
    sub: "cloudflare.com",
    hop,
    run: async (ctx) => {
      const r = await ctx.memo("trace", () => httpRequest(TRACE_URL, "GET", true, false));
      const f = r.final;
      const evidence = kv([
        ["URL", TRACE_URL],
        ["Status", f?.status ?? f?.error ?? null],
        ["Connected to", f?.remoteAddress ?? null],
        ["DNS / connect / TLS", f ? `${ms(f.timing.dns)} / ${ms(f.timing.connect)} / ${ms(f.timing.tls)}` : null],
        ["First byte", ms(f?.timing.ttfb)],
      ]);
      if (!f || f.error || !f.status) return fail("The server can't open secure websites", { detail: `${r.message} Apps can't download updates or reach online services.`, evidence });
      if (f.status >= 400) return warn(`A test site answered with HTTP ${f.status}`, { evidence });
      const ttfb = f.timing.ttfb;
      if ((ttfb ?? 0) > 1500) return warn(`Secure websites open slowly (${ms(ttfb)} to the first byte)`, { value: ms(ttfb), evidence });
      return ok(`Secure websites open (${ms(ttfb)} to the first byte)`, { value: ms(ttfb), evidence });
    },
  };
}

/** Does the public DNS of every name in routes.json point at this network? */
export function publicIpCheck(group: string): CheckSpec {
  return {
    id: "internet.public-ip",
    group,
    label: "Your domains point here",
    run: async (ctx) => {
      if (!tryReadConfig()) return skip("No public addresses are set up, so there's nothing to compare", {});
      const [st, traced] = await Promise.all([netStatus(ctx), lookupPublicIpv4()]);
      const ip = st.publicIp.v4 ?? traced;
      const hosts = new Map<string, NonNullable<(typeof st.routes)[number]["dns"]>>();
      for (const r of st.routes) if (r.enabled && r.dns && !hosts.has(r.host)) hosts.set(r.host, r.dns);
      if (st.base && !hosts.has(st.base.name)) hosts.set(st.base.name, st.base);
      const rows: [string, string][] = [["This network", `${ip ?? "unknown"}${traced && st.publicIp.v4 && traced !== st.publicIp.v4 ? ` (lookup says ${traced})` : ""}`]];
      const wrong: string[] = [];
      const missing: string[] = [];
      let proxied = 0;
      for (const [name, d] of hosts) {
        rows.push([name, d.proxied ? `Cloudflare proxy (${d.a.join(", ")})` : [...d.a, ...d.aaaa].join(", ") || "no record"]);
        if (d.status === "missing") missing.push(name);
        else if (d.status === "mismatch") wrong.push(name);
        if (d.proxied) proxied++;
      }
      const evidence = kv(rows);
      if (!ip) return warn("Gluon couldn't find this network's public address", { detail: "Neither the DDNS updater's log nor Cloudflare's trace gave one, so DNS couldn't be compared.", evidence });
      if (traced && st.publicIp.v4 && traced !== st.publicIp.v4) {
        return warn(`Your public address changed to ${traced}`, { detail: `The DDNS updater last saw ${st.publicIp.v4}. It should update DNS within a few minutes.`, evidence, fix: go("See DNS", "/network?tab=dns") });
      }
      if (missing.length) return { state: "fail", title: `${missing[0]}${missing.length > 1 ? ` and ${missing.length - 1} more` : ""} ${missing.length > 1 ? "have" : "has"} no DNS record`, detail: "Nobody can reach those addresses by name.", evidence, findings: missing.map((h) => `net.dns:${h}`), fix: go("See DNS", "/network?tab=dns") };
      if (wrong.length) return { state: "warn", title: `${wrong[0]}${wrong.length > 1 ? ` and ${wrong.length - 1} more` : ""} ${wrong.length > 1 ? "point" : "points"} somewhere else`, detail: `This network's address is ${ip}. The DDNS updater should fix it within minutes; if not, check its log.`, evidence, findings: wrong.map((h) => `net.dns:${h}`), fix: go("See DNS", "/network?tab=dns") };
      const direct = hosts.size - proxied;
      return ok(`All ${hosts.size} of your domain names point at this network (${ip})`, { detail: proxied ? `${direct} directly and ${proxied} through Cloudflare's proxy.` : null, evidence });
    },
  };
}

export function internetChecks(): CheckSpec[] {
  const g = "internet";
  return [gatewayCheck(g), systemDnsCheck(g), publicDnsCheck(g), httpsCheck(g), publicIpCheck(g)];
}
