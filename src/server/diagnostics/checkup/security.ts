import "server-only";
import net from "node:net";
import { host, CommandError } from "../../host/exec";
import { exposureReport } from "../../network/exposure";
import { listUsers } from "../../auth/users";
import { all } from "../../db";
import { plural, listJoin } from "@/lib/format";
import type { ExposureReport } from "@/lib/network-types";
import { activityHref } from "@/lib/settings-links";
import { fail, go, kv, ok, skip, warn, type CheckCtx, type CheckSpec, type Outcome } from "./core";
import { mfaRequired } from "../../auth/policy";

/** Security: sshd settings, what's reachable, and admins without two-step sign-in. */

export const exposure = (ctx: CheckCtx, force = false) => ctx.memo(`exposure:${force}`, () => exposureReport(force ? { force: true } : { maxAgeMs: 5 * 60_000 }));

export interface SshdConfig {
  passwordAuthentication: string | null;
  permitRootLogin: string | null;
  kbdInteractive: string | null;
  ports: string[];
  listen: string[];
}

/** `sshd -T` prints the effective configuration (after includes and Match defaults). */
export async function sshdConfig(): Promise<SshdConfig | null> {
  let stdout = "";
  try {
    ({ stdout } = await host("sshd", ["-T"], { timeoutMs: 8000 }));
  } catch (e) {
    if (e instanceof CommandError && (e.code === 127 || /not found|No such file/i.test(e.stderr))) return null;
    if (e instanceof CommandError && e.stdout) stdout = e.stdout;
    else throw e;
  }
  const get = (k: string) => stdout.match(new RegExp(`^${k} (.+)$`, "m"))?.[1]?.trim() ?? null;
  const many = (k: string) => [...stdout.matchAll(new RegExp(`^${k} (.+)$`, "gm"))].map((m) => m[1]!.trim());
  return { passwordAuthentication: get("passwordauthentication"), permitRootLogin: get("permitrootlogin"), kbdInteractive: get("kbdinteractiveauthentication"), ports: many("port"), listen: many("listenaddress") };
}

const sshd = (ctx: CheckCtx) => ctx.memo("sshd", sshdConfig);

export async function sshPasswordOutcome(ctx: CheckCtx): Promise<Outcome> {
  const c = await sshd(ctx);
  if (!c) return skip("SSH isn't installed on this server");
  const evidence = kv([
    ["passwordauthentication", c.passwordAuthentication],
    ["kbdinteractiveauthentication", c.kbdInteractive],
    ["port", c.ports.join(", ")],
    ["listenaddress", c.listen.join(", ")],
  ]);
  if (c.passwordAuthentication === "yes") {
    return warn("SSH accepts passwords", {
      detail: "Anyone who can reach port 22 can keep guessing. Once you sign in with a key, set PasswordAuthentication no in /etc/ssh/sshd_config and reload ssh.",
      evidence,
    });
  }
  return ok("SSH only accepts keys, not passwords", { evidence });
}

export async function sshRootOutcome(ctx: CheckCtx): Promise<Outcome> {
  const c = await sshd(ctx);
  if (!c) return skip("SSH isn't installed on this server");
  const v = c.permitRootLogin;
  const evidence = kv([["permitrootlogin", v]]);
  if (v === "yes") return warn("SSH lets root sign in with a password", { detail: "Set PermitRootLogin prohibit-password (keys only) or no in /etc/ssh/sshd_config.", evidence });
  if (v === "no") return ok("SSH doesn't let root sign in", { evidence });
  return ok("Root can only sign in over SSH with a key", { evidence });
}

export function internetLoginOutcome(r: ExposureReport): Outcome {
  const noLogin = r.internet.filter((x) => x.login.verdict === "no-login");
  const evidence = kv(r.internet.map((x) => [x.url.replace(/^https:\/\//, ""), `${x.login.verdict === "login" ? "has a login" : x.login.verdict === "no-login" ? "NO LOGIN" : "couldn't tell"}${x.adminUi ? " · admin tool" : ""}${x.viaCloudflare ? " · via Cloudflare" : ""}`]));
  if (!r.internet.length) return ok("Nothing is reachable from the internet", { evidence: null });
  if (noLogin.length) {
    return fail(noLogin.length === 1 ? `${noLogin[0]!.app?.name ?? noLogin[0]!.name} is on the internet without a login` : `${noLogin.length} apps are on the internet without a login`, {
      detail: `Anyone who finds ${noLogin.length === 1 ? "the address" : "those addresses"} can use ${noLogin.length === 1 ? "it" : "them"}. Turn on the app's own login, or take the address off the internet.`,
      evidence,
      findings: noLogin.map((x) => `net.exposed:${x.routeId}`),
      fix: go("Review exposure", "/network?tab=exposure"),
    });
  }
  return ok(`${plural(r.internet.length, "address", "addresses")} ${r.internet.length === 1 ? "is" : "are"} reachable from the internet, and each has a login`, { evidence });
}

export function lanOutcome(r: ExposureReport): Outcome {
  const open = r.lan.filter((l) => !l.system && l.scope === "all");
  const flags = r.flags.filter((f) => f.severity !== "info");
  const evidence = kv(open.slice(0, 40).map((l) => [`${l.port}/${l.proto}`, `${l.label}${l.login ? ` · ${l.login.verdict === "login" ? "login" : l.login.verdict === "no-login" ? "no login" : "login unknown"}` : ""}`]));
  if (flags.length) {
    const f = flags[0]!;
    return (f.severity === "fault" ? fail : warn)(f.title, { detail: `${f.detail}${flags.length > 1 ? ` (${flags.length - 1} more in Network → Exposure.)` : ""}`, evidence, fix: go("Review exposure", f.href ?? "/network?tab=exposure") });
  }
  return ok(`${plural(open.length, "service")} accept${open.length === 1 ? "s" : ""} connections from your network, none of them risky`, { evidence });
}

export function adminMfaOutcome(): Outcome {
  const admins = listUsers().filter((u) => u.role === "admin" && !u.disabled);
  const without = admins.filter((u) => !u.mfa);
  const policy = mfaRequired("admin", "away");
  const evidence = kv([...admins.map((u) => [u.username, u.mfa ? "two-step on" : "two-step OFF"] as [string, string]), ["Two-step required for admins away from home", policy ? "yes" : "no"]]);
  if (!without.length) return ok(`Every admin uses two-step sign-in`, { evidence });
  const names = without.map((u) => u.displayName || u.username);
  return warn(without.length === 1 ? `${names[0]} signs in without two-step verification` : `${without.length} admins sign in without two-step verification`, {
    detail: `${policy ? "Gluon blocks their sign-in from outside the home, but " : ""}a stolen password is all it takes to control this server${policy ? " from inside it" : ""}. Turn it on in Settings → Security.`,
    evidence,
    fix: go("Set up two-step", "/settings/security"),
  });
}

const PRIVATE = (() => {
  const b = new net.BlockList();
  b.addSubnet("10.0.0.0", 8);
  b.addSubnet("172.16.0.0", 12);
  b.addSubnet("192.168.0.0", 16);
  b.addSubnet("127.0.0.0", 8);
  b.addSubnet("169.254.0.0", 16);
  b.addSubnet("100.64.0.0", 10);
  b.addSubnet("fc00::", 7, "ipv6");
  b.addSubnet("fe80::", 10, "ipv6");
  b.addAddress("::1", "ipv6");
  return b;
})();

export const isPrivateIp = (ip: string) => {
  const v = net.isIP(ip);
  return v ? PRIVATE.check(ip.replace(/^::ffff:/, ""), v === 6 && !ip.startsWith("::ffff:") ? "ipv6" : "ipv4") : false;
};

/** Failed SSH sign-ins in the last week, from the ssh unit's journal. */
export async function sshFailuresOutcome(): Promise<Outcome> {
  let stdout = "";
  try {
    ({ stdout } = await host("journalctl", ["-u", "ssh", "-u", "sshd", "--since", "-7d", "--no-pager", "-o", "cat", "-q"], { timeoutMs: 15_000, maxBuffer: 32 * 1024 * 1024, okCodes: [1] }));
  } catch {
    return skip("Gluon couldn't read SSH's log");
  }
  const fails: { user: string; ip: string }[] = [];
  let accepted = 0;
  for (const line of stdout.split("\n")) {
    const m = line.match(/^(?:Failed (?:password|publickey) for (?:invalid user )?(\S+)|Invalid user (\S*)) from (\S+)/);
    if (m) fails.push({ user: m[1] ?? m[2] ?? "?", ip: m[3]! });
    else if (/^Accepted /.test(line)) accepted++;
  }
  const outside = fails.filter((f) => !isPrivateIp(f.ip));
  const byIp = new Map<string, number>();
  for (const f of fails) byIp.set(f.ip, (byIp.get(f.ip) ?? 0) + 1);
  const evidence = kv([
    ["Successful sign-ins", accepted],
    ["Failed attempts", fails.length],
    ["From outside your network", outside.length],
    ...[...byIp.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([ip, n]) => [`  ${ip}`, `${n}${isPrivateIp(ip) ? " (your network)" : ""}`] as [string, string]),
  ]);
  if (outside.length >= 5) return warn(`${plural(outside.length, "SSH sign-in attempt")} from the internet failed this week`, { detail: "Someone outside your network is trying passwords on SSH. Make sure port 22 isn't forwarded on the router, and switch SSH to keys only.", evidence });
  if (!fails.length) return ok("No failed SSH sign-ins this week", { evidence });
  return ok(`${plural(fails.length, "failed SSH sign-in")} this week, all from your own network`, { evidence });
}

/** Gluon's own failed sign-ins in the last day (login_attempts keeps 24 hours). */
export function gluonLoginsOutcome(): Outcome {
  const rows = all<{ key: string; n: number }>("SELECT key, COUNT(*) AS n FROM login_attempts WHERE ok = 0 AND key LIKE 'ip:%' AND at > ? GROUP BY key ORDER BY n DESC LIMIT 20", Date.now() - 86_400_000);
  const total = rows.reduce((a, r) => a + r.n, 0);
  const outside = rows.filter((r) => !isPrivateIp(r.key.slice(3)));
  const evidence = kv(rows.map((r) => [r.key.slice(3), `${r.n}${isPrivateIp(r.key.slice(3)) ? " (your network)" : ""}`]));
  if (!total) return ok("No failed sign-ins to Gluon in the last day", { evidence: null });
  const outsideN = outside.reduce((a, r) => a + r.n, 0);
  if (outsideN >= 10) return warn(`${plural(outsideN, "failed sign-in")} to Gluon from the internet in the last day`, { detail: `From ${listJoin(outside.slice(0, 3).map((r) => r.key.slice(3)))}. Gluon slows these down automatically; two-step sign-in keeps accounts safe even if a password is guessed.`, evidence, fix: go("See activity", activityHref()) });
  return ok(`${plural(total, "failed sign-in")} to Gluon in the last day, ${outsideN ? `${outsideN} from outside` : "all from your network"}`, { evidence });
}

export function securityChecks(): CheckSpec[] {
  const g = "security";
  return [
    { id: "security.ssh-password", group: g, label: "SSH passwords", run: sshPasswordOutcome },
    { id: "security.ssh-root", group: g, label: "SSH root sign-in", run: sshRootOutcome },
    { id: "security.internet-login", group: g, label: "Logins on public apps", timeoutMs: 45_000, run: async (ctx) => internetLoginOutcome(await exposure(ctx)) },
    { id: "security.lan", group: g, label: "Open ports", timeoutMs: 45_000, run: async (ctx) => lanOutcome(await exposure(ctx)) },
    { id: "security.admin-mfa", group: g, label: "Two-step sign-in", run: async () => adminMfaOutcome() },
  ];
}
