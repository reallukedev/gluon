import "server-only";
import fs from "node:fs";
import path from "node:path";
import dgram from "node:dgram";
import { host, CommandError } from "../../host/exec";
import { hostPath, readHostFileOr, hostExists } from "../../host/paths";
import { docker } from "../../docker/client";
import { GLUON_NAME, isSelfContainer } from "../../docker/self";
import { listUsers } from "../../auth/users";
import { listInvites } from "../../auth/invites";
import { mfaRequired } from "../../auth/policy";
import { refreshSignIns, signInsSince, zoneOf } from "../../system/logins";
import { formatRelative, listJoin, plural } from "@/lib/format";
import { peopleHref } from "@/lib/settings-links";
import { fail, go, kv, limiter, ok, skip, warn, type CheckCtx, type Outcome } from "./core";
import { exposure, isPrivateIp, sshdConfig } from "./security";
import {
  aptUnattended,
  canLogIn,
  containerRisks,
  dockerTcpHosts,
  emptyPasswords,
  globalV6,
  groupMembers,
  groupOrOtherWritable,
  igdControlUrl,
  iptablesInput,
  isLoopback,
  isV6Any,
  nftInput,
  nopasswdRules,
  octal,
  osRelease,
  otherReadable,
  otherWritable,
  parseAuthorizedKeys,
  parseFail2banJail,
  parseGroup,
  parseMappingEntry,
  parsePasswd,
  parseSshdT,
  parseSsListen,
  parseUfw,
  riskyListeners,
  ssdpLocation,
  SYSCTL_INFO,
  SYSCTL_RULES,
  weakKey,
  weakSshAlgorithms,
  type FilterState,
  type InspectLike,
  type UpnpMapping,
} from "./hardening-parse";

const DAY = 86_400_000;
const TERMINAL = go("Open a terminal", "/terminal");

/** null when it isn't installed. Other failures keep whatever it printed. */
async function tryHost(cmd: string, args: string[], opts: { timeoutMs?: number; okCodes?: number[]; maxBuffer?: number } = {}): Promise<string | null> {
  try {
    return (await host(cmd, args, { timeoutMs: opts.timeoutMs ?? 8000, okCodes: opts.okCodes, maxBuffer: opts.maxBuffer })).stdout;
  } catch (e) {
    if (e instanceof CommandError && (e.code === 127 || /not found|No such file|executable file|ENOENT/i.test(e.stderr + e.message))) return null;
    if (e instanceof CommandError && e.stdout) return e.stdout;
    throw e;
  }
}

const unitActive = async (unit: string) => (await tryHost("systemctl", ["is-active", unit], { okCodes: [3, 4] }))?.trim() === "active";
const unitEnabled = async (unit: string) => /^(enabled|static|alias)/.test((await tryHost("systemctl", ["is-enabled", unit], { okCodes: [1, 4] }))?.trim() ?? "");

/** Listening sockets, or null when ss isn't there to ask (never "nothing listens" by mistake). */
const listeners = (ctx: CheckCtx) =>
  ctx.memo("hard:ss", async () => {
    const out = await tryHost("ss", ["-H", "-lntup"], { timeoutMs: 10_000 });
    return out === null ? null : parseSsListen(out);
  });
const passwd = (ctx: CheckCtx) => ctx.memo("hard:passwd", async () => parsePasswd(readHostFileOr("/etc/passwd", "")));
const sshdT = (ctx: CheckCtx) => ctx.memo("hard:sshdT", async () => {
  const out = await tryHost("sshd", ["-T"]);
  return out ? parseSshdT(out) : null;
});
const sshdLite = (ctx: CheckCtx) => ctx.memo("sshd", sshdConfig);

const sysctl = (key: string) => readHostFileOr(`/proc/sys/${key}`, "").trim() || null;

interface Firewall {
  manager: string | null;
  v4: FilterState | null;
  v6: FilterState | null;
  ufw: ReturnType<typeof parseUfw>;
  evidence: [string, string | number | null][];
}

const firewall = (ctx: CheckCtx) =>
  ctx.memo("hard:firewall", async (): Promise<Firewall> => {
    const [ufwOut, firewalld, nft] = await Promise.all([tryHost("ufw", ["status", "verbose"]).catch(() => null), tryHost("firewall-cmd", ["--state"], { okCodes: [252] }).catch(() => null), tryHost("nft", ["list", "ruleset"], { maxBuffer: 32 * 1024 * 1024, timeoutMs: 12_000 }).catch(() => null)]);
    const ufw = ufwOut ? parseUfw(ufwOut) : null;
    let v4 = nft ? nftInput(nft, ["ip", "inet"]) : null;
    let v6 = nft ? nftInput(nft, ["ip6", "inet"]) : null;
    if (!v4) v4 = iptablesInput((await tryHost("iptables", ["-S", "INPUT"]).catch(() => null)) ?? "");
    if (!v6) v6 = iptablesInput((await tryHost("ip6tables", ["-S", "INPUT"]).catch(() => null)) ?? "");
    const fwd = firewalld?.trim() === "running";
    const manager = ufw?.active ? "ufw" : fwd ? "firewalld" : v4?.filtering || v6?.filtering ? (nft ? "nftables" : "iptables") : null;
    return {
      manager,
      v4,
      v6,
      ufw,
      evidence: [
        ["ufw", ufw ? `${ufw.active ? "active" : "inactive"}${ufw.incoming ? `, incoming ${ufw.incoming}` : ""}` : "not installed"],
        ["firewalld", firewalld === null ? "not installed" : fwd ? "running" : "not running"],
        ["IPv4", v4?.how ?? "couldn't read"],
        ["IPv6", v6?.how ?? "couldn't read"],
      ],
    };
  });

export async function firewallOutcome(ctx: CheckCtx): Promise<Outcome> {
  const fw = await firewall(ctx);
  const evidence = kv(fw.evidence);
  if (fw.ufw?.active && fw.ufw.incoming && fw.ufw.incoming !== "deny" && fw.ufw.incoming !== "reject") {
    return warn(`The firewall is on but lets everything in`, { detail: "ufw's default for incoming connections is allow, so it only blocks what you've listed. Run: sudo ufw default deny incoming (after allowing SSH and the ports your apps need).", evidence, fix: TERMINAL });
  }
  if (!fw.v4?.filtering) {
    return warn("No firewall is filtering incoming connections", {
      detail: "Every service listening on this machine answers anyone who can reach it. Your router stops most of the internet, but not other devices at home or a port someone forwards. ufw is the simplest way to add one.",
      evidence,
      fix: TERMINAL,
    });
  }
  return ok(`${fw.manager === "ufw" ? "ufw" : fw.manager === "firewalld" ? "firewalld" : "A firewall"} filters incoming connections`, { evidence });
}

export async function ipv6Outcome(ctx: CheckCtx): Promise<Outcome> {
  const [addrOut, fw, ls] = await Promise.all([tryHost("ip", ["-6", "-o", "addr", "show", "scope", "global"]), firewall(ctx), listeners(ctx)]);
  if (addrOut === null || ls === null) return skip("Couldn't list addresses and listening ports (ip or ss is missing)");
  const v6 = globalV6(addrOut);
  const open = ls.filter((l) => isV6Any(l.addr) || (l.addr.includes(":") && !isLoopback(l.addr)));
  const ports = [...new Set(open.map((l) => `${l.port}/${l.proto}`))];
  const evidence = kv([["Global IPv6 addresses", v6.join(", ") || "none"], ["IPv6 firewall", fw.v6?.how ?? "couldn't read"], ["Listening on IPv6", ports.slice(0, 20).join(", ") || "nothing"]]);
  if (!v6.length) return ok("This server has no public IPv6 address", { evidence });
  if (!fw.v6?.filtering && open.length) {
    return warn(`${plural(ports.length, "port")} ${ports.length === 1 ? "is" : "are"} open on a public IPv6 address with no firewall`, {
      detail: "IPv6 skips the router's address sharing, so this machine has its own address on the internet. Most routers block incoming IPv6 by default; check yours does, or add IPv6 rules to the firewall.",
      evidence,
      fix: TERMINAL,
    });
  }
  return ok(fw.v6?.filtering ? "IPv6 is covered by the firewall" : "Nothing listens on IPv6", { evidence });
}

export async function dockerBypassOutcome(ctx: CheckCtx): Promise<Outcome> {
  const [fw, r] = await Promise.all([firewall(ctx), exposure(ctx)]);
  const published = r.lan.filter((l) => l.published && l.scope === "all" && !l.system);
  const evidence = kv(published.slice(0, 30).map((l) => [`${l.port}/${l.proto}`, `${l.app?.name ?? l.container?.name ?? l.label}${l.published ? ` → ${l.published.containerPort}` : ""}`]));
  if (!fw.v4?.filtering) return skip("No firewall to bypass", { evidence: published.length ? evidence : null });
  if (!published.length) return ok("No app publishes a port on every network address", { evidence: null });
  // Docker forwards published ports before the INPUT chain sees them, so no host firewall applies.
  const fwName = fw.manager === "ufw" || fw.manager === "firewalld" ? fw.manager : "the firewall";
  return warn(`Docker opens ${plural(published.length, "port")} past ${fwName}`, {
    detail: `Docker sends traffic for published ports straight to the container, so ${fwName} never sees it and can't block it. When only Caddy needs an app, publish its port on 127.0.0.1 in the compose file.`,
    evidence,
    fix: go("Review exposure", "/network?tab=exposure"),
  });
}

export async function riskyServicesOutcome(ctx: CheckCtx): Promise<Outcome> {
  const ls = await listeners(ctx);
  if (!ls) return skip("Couldn't list listening ports (ss is missing)");
  const risky = riskyListeners(ls);
  const evidence = kv(risky.map((r) => [`${r.port}/${r.proto}`, `${r.label}${r.process ? ` (${r.process})` : ""} on ${r.addr}: ${r.why}`]));
  if (!risky.length) return ok("No old or unsafe remote services are listening", { evidence: null });
  const worst = risky[0]!;
  const out = worst.severity === "fail" ? fail : warn;
  return out(risky.length === 1 ? `${worst.label} is listening on port ${worst.port}` : `${risky.length} unsafe remote services are listening, including ${worst.label}`, {
    detail: `${worst.label} ${worst.why}. Turn off what you don't use, or limit it to this machine.`,
    evidence,
    fix: go("See services", "/system?tab=services"),
  });
}

async function ssdpGateways(signal: AbortSignal): Promise<{ location: string; from: string }[]> {
  return new Promise((resolve) => {
    const found = new Map<string, { location: string; from: string }>();
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const finish = () => {
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      resolve([...found.values()]);
    };
    const timer = setTimeout(finish, 2500);
    signal.addEventListener("abort", finish, { once: true });
    sock.on("error", finish);
    sock.on("message", (msg, rinfo) => {
      const loc = ssdpLocation(msg.toString("utf8"));
      if (!loc) return;
      try {
        const u = new URL(loc);
        // Only follow a description served by the device that answered, on the home network.
        if (u.protocol !== "http:" || u.hostname !== rinfo.address || !isPrivateIp(rinfo.address)) return;
        found.set(loc, { location: loc, from: rinfo.address });
      } catch {
        /* not a URL */
      }
    });
    sock.bind(0, () => {
      for (const st of ["urn:schemas-upnp-org:device:InternetGatewayDevice:1", "urn:schemas-upnp-org:device:InternetGatewayDevice:2"]) {
        const m = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`);
        sock.send(m, 1900, "239.255.255.250", () => {});
      }
    });
  });
}

async function fetchText(url: string, init: RequestInit = {}): Promise<string> {
  const res = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(4000) });
  if (res.status >= 300 && res.status < 400) throw new Error("redirected");
  const text = await res.text();
  return text.slice(0, 256 * 1024);
}

async function upnpMappings(control: { url: string; serviceType: string }): Promise<UpnpMapping[]> {
  const out: UpnpMapping[] = [];
  for (let i = 0; i < 64; i++) {
    const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:GetGenericPortMappingEntry xmlns:u="${control.serviceType}"><NewPortMappingIndex>${i}</NewPortMappingIndex></u:GetGenericPortMappingEntry></s:Body></s:Envelope>`;
    let xml: string;
    try {
      xml = await fetchText(control.url, { method: "POST", body, headers: { "content-type": 'text/xml; charset="utf-8"', soapaction: `"${control.serviceType}#GetGenericPortMappingEntry"` } });
    } catch {
      break;
    }
    const m = parseMappingEntry(xml);
    if (!m) break;
    out.push(m);
  }
  return out;
}

export async function upnpOutcome(ctx: CheckCtx): Promise<Outcome> {
  const gws = await ssdpGateways(ctx.signal);
  if (!gws.length) return ok("The router doesn't let devices open ports on their own", { detail: null, evidence: kv([["UPnP gateways found", 0]]) });
  let control: { url: string; serviceType: string } | null = null;
  let gw = gws[0]!;
  for (const g of gws) {
    try {
      control = igdControlUrl(await fetchText(g.location), g.location);
    } catch {
      control = null;
    }
    if (control) {
      gw = g;
      break;
    }
  }
  if (!control) return warn("The router answers UPnP, so devices can open ports on it", { detail: "Couldn't read which ports are open that way. Turning UPnP off in the router's settings stops apps and devices from opening ports without asking.", evidence: kv([["Router", gw.from], ["Description", gw.location]]) });
  const maps = (await upnpMappings(control)).filter((m) => m.enabled);
  const evidence = kv([["Router", gw.from], ...maps.map((m) => [`${m.externalPort}/${m.protocol}`, `→ ${m.internalClient}:${m.internalPort}${m.description ? ` (${m.description})` : ""}${m.leaseSeconds ? `, expires in ${Math.round(m.leaseSeconds / 60)} min` : ""}`] as [string, string])]);
  if (!maps.length) return ok("UPnP is on, but nothing has opened a port with it", { detail: null, evidence });
  return warn(`${plural(maps.length, "port")} on the router ${maps.length === 1 ? "was" : "were"} opened by a device, not by you`, {
    detail: `Devices opened ${maps.length === 1 ? "it" : "them"} with UPnP: ${listJoin([...new Set(maps.map((m) => m.description || m.internalClient))].slice(0, 4))}. Each is reachable from the internet. Check you expect ${maps.length === 1 ? "it" : "them"}, and turn UPnP off in the router if not.`,
    evidence,
  });
}

export async function sshSettingsOutcome(ctx: CheckCtx): Promise<Outcome> {
  const c = await sshdT(ctx);
  if (!c) return skip("SSH isn't installed on this server");
  const v = (k: string) => c.get(k)?.[0] ?? null;
  const evidence = kv(["permitemptypasswords", "maxauthtries", "logingracetime", "x11forwarding", "permituserenvironment", "gatewayports", "allowtcpforwarding", "allowusers", "allowgroups", "pubkeyauthentication", "usepam"].map((k) => [k, v(k)]));
  if (v("permitemptypasswords") === "yes") return fail("SSH lets accounts with no password sign in", { detail: "Set PermitEmptyPasswords no in /etc/ssh/sshd_config and reload ssh.", evidence, fix: TERMINAL });
  const loose: string[] = [];
  const tries = Number(v("maxauthtries"));
  if (Number.isFinite(tries) && tries > 6) loose.push(`MaxAuthTries is ${tries} (6 or fewer slows guessing)`);
  if (v("permituserenvironment") === "yes") loose.push("PermitUserEnvironment yes lets users change how their session starts");
  if (v("gatewayports") === "yes") loose.push("GatewayPorts yes lets tunnels listen for the whole network");
  if (loose.length) return warn(loose.length === 1 ? `One SSH setting is looser than it needs to be` : `${loose.length} SSH settings are looser than they need to be`, { detail: `${loose.join("; ")}. Change them in /etc/ssh/sshd_config.`, evidence, fix: TERMINAL });
  return ok("SSH's other settings are sensible", { evidence });
}

export async function sshCryptoOutcome(ctx: CheckCtx): Promise<Outcome> {
  const c = await sshdT(ctx);
  if (!c) return skip("SSH isn't installed on this server");
  const weak = weakSshAlgorithms(c);
  const evidence = kv([["ciphers", c.get("ciphers")?.[0]], ["macs", c.get("macs")?.[0]], ["kexalgorithms", c.get("kexalgorithms")?.[0]], ["hostkeyalgorithms", c.get("hostkeyalgorithms")?.[0]]]);
  if (!weak.length) return ok("SSH only offers current encryption", { evidence });
  const names = weak.flatMap((w) => w.names);
  return warn(`SSH still offers ${plural(names.length, "retired algorithm")}`, {
    detail: `${listJoin(names.slice(0, 4))}${names.length > 4 ? " and more" : ""}. Remove them from ${listJoin(weak.map((w) => w.setting === "kexalgorithms" ? "KexAlgorithms" : w.setting === "macs" ? "MACs" : w.setting === "ciphers" ? "Ciphers" : "HostKeyAlgorithms"))} in /etc/ssh/sshd_config. Every current SSH app works without them.`,
    evidence,
    fix: TERMINAL,
  });
}

export async function sshKeysOutcome(ctx: CheckCtx): Promise<Outcome> {
  if (!(await sshdT(ctx))) return skip("SSH isn't installed on this server");
  const users = (await passwd(ctx)).filter((p) => p.uid === 0 || (canLogIn(p) && p.uid >= 1000 && p.home.startsWith("/")));
  const rows: [string, string][] = [];
  const weak: string[] = [];
  const loosePerms: string[] = [];
  let total = 0;
  for (const u of users.slice(0, 200)) {
    const dir = path.posix.join(u.home, ".ssh");
    for (const file of ["authorized_keys", "authorized_keys2"]) {
      const p = path.posix.join(dir, file);
      let text: string;
      let mode: number;
      try {
        const st = fs.statSync(hostPath(p));
        if (!st.isFile()) continue;
        mode = st.mode;
        text = fs.readFileSync(hostPath(p), "utf8");
      } catch {
        continue;
      }
      const keys = parseAuthorizedKeys(text);
      total += keys.length;
      rows.push([`${u.name} ${file}`, `${plural(keys.length, "key")}${keys.length ? `: ${keys.map((k) => `${k.type.replace(/^ssh-/, "")}${k.bits ? ` ${k.bits}` : ""}${k.comment ? ` ${k.comment}` : ""}`).slice(0, 6).join(", ")}` : ""}, mode ${octal(mode)}`]);
      for (const k of keys) {
        const w = weakKey(k);
        if (w) weak.push(`${u.name}${k.comment ? ` (${k.comment})` : ""}: ${w}`);
      }
      if (groupOrOtherWritable(mode)) loosePerms.push(p);
      try {
        const dm = fs.statSync(hostPath(dir)).mode;
        if (groupOrOtherWritable(dm) && !loosePerms.includes(dir)) loosePerms.push(dir);
      } catch {
        /* gone */
      }
    }
  }
  const evidence = kv(rows.length ? rows : [["Keys", "none"]]);
  if (weak.length) return warn(weak.length === 1 ? "One SSH key is too weak to trust" : `${weak.length} SSH keys are too weak to trust`, { detail: `${listJoin(weak.slice(0, 3))}. Make a new ed25519 key (ssh-keygen -t ed25519), add it, then remove the old one.`, evidence, fix: TERMINAL });
  if (loosePerms.length) return warn("Other accounts can change who signs in with SSH", { detail: `${listJoin(loosePerms.slice(0, 3))} can be written by other users. Run chmod 700 on the .ssh folder and chmod 600 on authorized_keys.`, evidence, fix: TERMINAL });
  if (!total) return ok("No accounts have SSH keys", { evidence });
  return ok(`${plural(total, "SSH key")} ${total === 1 ? "is" : "are"} trusted, all strong`, { value: String(total), evidence });
}

export async function bruteForceOutcome(ctx: CheckCtx): Promise<Outcome> {
  const lite = await sshdLite(ctx);
  const [f2b, sshguard, crowdsec] = await Promise.all([unitActive("fail2ban"), unitActive("sshguard"), unitActive("crowdsec")]);
  let jail = { banned: null as number | null, total: null as number | null };
  if (f2b) jail = parseFail2banJail((await tryHost("fail2ban-client", ["status", "sshd"]).catch(() => null)) ?? "");
  const evidence = kv([["fail2ban", f2b ? `running${jail.banned !== null ? `, ${jail.banned} blocked now, ${jail.total ?? "?"} in total` : ", no sshd jail"}` : "not running"], ["sshguard", sshguard ? "running" : "not running"], ["CrowdSec", crowdsec ? "running" : "not running"], ["SSH passwords", lite?.passwordAuthentication ?? "SSH not installed"]]);
  const tool = f2b ? "fail2ban" : sshguard ? "sshguard" : crowdsec ? "CrowdSec" : null;
  if (tool) return ok(`${tool} blocks addresses that keep guessing${jail.banned ? ` (${jail.banned} blocked now)` : ""}`, { value: jail.banned !== null ? String(jail.banned) : null, evidence });
  if (!lite) return skip("SSH isn't installed on this server");
  if (lite.passwordAuthentication !== "yes") return ok("Nothing blocks guessers, but SSH only takes keys so guessing can't work", { evidence });
  return warn("Nothing stops someone guessing SSH passwords", { detail: "SSH accepts passwords and no tool blocks addresses that keep failing. Install fail2ban (sudo apt install fail2ban), or better, switch SSH to keys only.", evidence, fix: TERMINAL });
}

export async function sshAwaySignInsOutcome(): Promise<Outcome> {
  try {
    await refreshSignIns();
  } catch {
    return skip("Couldn't read the sign-in log");
  }
  const since = Date.now() - 7 * DAY;
  const all = signInsSince(since);
  const away = all.filter((s) => s.ip && zoneOf(s.ip) === "away");
  const evidence = kv([["Sign-ins this week", all.length], ["From the internet", away.length], ...away.slice(0, 10).map((s) => [`  ${s.user}`, `${s.ip} · ${s.method} · ${formatRelative(s.start)}`] as [string, string])]);
  if (!away.length) return ok(all.length ? `${plural(all.length, "SSH or console sign-in")} this week, none from the internet` : "No one signed in over SSH this week", { evidence });
  const who = [...new Set(away.map((s) => s.user))];
  return warn(`${plural(away.length, "sign-in")} to this server came from the internet this week`, {
    detail: `As ${listJoin(who.slice(0, 3))}. If that wasn't you, change the password, remove unknown keys and look at what was run.`,
    evidence,
    fix: go("See sign-ins", "/system?tab=sign-ins"),
  });
}

export async function autoUpdatesOutcome(): Promise<Outcome> {
  if (hostExists("/etc/apt/apt.conf.d")) {
    const installed = hostExists("/usr/bin/unattended-upgrade");
    let files: { name: string; text: string }[] = [];
    try {
      files = fs.readdirSync(hostPath("/etc/apt/apt.conf.d")).map((name) => ({ name, text: readHostFileOr(`/etc/apt/apt.conf.d/${name}`, "") }));
    } catch {
      /* unreadable: treat as unset */
    }
    const on = aptUnattended(files);
    const timer = await unitEnabled("apt-daily-upgrade.timer");
    const evidence = kv([["unattended-upgrades", installed ? "installed" : "not installed"], ["APT::Periodic::Unattended-Upgrade", on === null ? "not set" : on ? "on" : "off"], ["apt-daily-upgrade.timer", timer ? "enabled" : "disabled"]]);
    if (installed && on && timer) return ok("Security updates install themselves every day", { evidence });
    return warn("Security updates wait for someone to install them", {
      detail: installed ? "unattended-upgrades is installed but switched off. Run: sudo dpkg-reconfigure -plow unattended-upgrades" : "Install unattended-upgrades (sudo apt install unattended-upgrades) so fixes for known problems go in even when nobody's looking.",
      evidence,
      fix: TERMINAL,
    });
  }
  const dnf = (await unitEnabled("dnf-automatic.timer")) || (await unitEnabled("dnf-automatic-install.timer")) || (await unitEnabled("dnf5-automatic.timer"));
  if (hostExists("/usr/bin/dnf")) {
    const evidence = kv([["dnf-automatic", dnf ? "enabled" : "not enabled"]]);
    return dnf ? ok("Updates install themselves on a timer", { evidence }) : warn("Security updates wait for someone to install them", { detail: "Enable dnf-automatic: sudo systemctl enable --now dnf-automatic-install.timer", evidence, fix: TERMINAL });
  }
  return skip("This system's package manager isn't one Gluon knows");
}

export async function osSupportOutcome(): Promise<Outcome> {
  const os = osRelease(readHostFileOr("/etc/os-release", ""));
  const name = os.PRETTY_NAME ?? os.NAME ?? "This system";
  const code = os.VERSION_CODENAME ?? os.UBUNTU_CODENAME ?? null;
  const tool = os.ID === "ubuntu" ? "ubuntu-distro-info" : os.ID === "debian" || os.ID === "raspbian" ? "debian-distro-info" : null;
  const evidence = (rows: [string, string | null][]) => kv([["System", name], ["Codename", code], ...rows]);
  if (!tool || !code) return skip(`Can't tell how long ${name} gets security updates`, { evidence: evidence([]) });
  const [all, supported, extra] = await Promise.all([tryHost(tool, ["--all"]), tryHost(tool, ["--supported"]), tryHost(tool, [os.ID === "ubuntu" ? "--supported-esm" : "--lts"]).catch(() => null)]);
  if (all === null || supported === null) return skip(`Can't tell how long ${name} gets security updates`, { detail: `Install distro-info to check (sudo apt install distro-info).`, evidence: evidence([]) });
  const has = (list: string | null) => (list ?? "").split("\n").map((s) => s.trim()).includes(code);
  if (!has(all)) return skip(`Can't tell how long ${name} gets security updates`, { detail: "The release list on this server is older than the system. Installing updates refreshes it.", evidence: evidence([]) });
  const ev = evidence([["Standard support", has(supported) ? "yes" : "ended"], [os.ID === "ubuntu" ? "Ubuntu Pro (ESM)" : "Debian LTS", has(extra) ? "yes" : "no"]]);
  if (has(supported)) return ok(`${name} still gets security updates`, { evidence: ev });
  if (has(extra)) return warn(`${name} is past standard support`, { detail: os.ID === "ubuntu" ? "Security fixes now only come with Ubuntu Pro (free for personal use). Upgrade to the next LTS, or turn on Pro." : "Only Debian LTS still patches it, and not every package. Plan an upgrade to the current release.", evidence: ev, fix: go("Open updates", "/system?tab=updates") });
  return fail(`${name} no longer gets security updates`, { detail: "New problems found in it won't be fixed. Upgrade to a supported release.", evidence: ev, fix: go("Open updates", "/system?tab=updates") });
}

export async function hostAccountsOutcome(ctx: CheckCtx): Promise<Outcome> {
  const pw = await passwd(ctx);
  if (!pw.length) return skip("Couldn't read the server's accounts");
  const uid0 = pw.filter((p) => p.uid === 0 && p.name !== "root").map((p) => p.name);
  const empty = emptyPasswords(readHostFileOr("/etc/shadow", ""), pw);
  const people = pw.filter((p) => canLogIn(p) && (p.uid === 0 || p.uid >= 1000) && p.uid < 60000);
  const evidence = kv([["Accounts that can sign in", people.map((p) => p.name).join(", ")], ["Other root-level accounts", uid0.join(", ") || "none"], ["Without a password", empty.join(", ") || "none"]]);
  if (uid0.length) return fail(`${listJoin(uid0)} ${uid0.length === 1 ? "has" : "have"} the same powers as root`, { detail: "An extra account with user id 0 is a classic backdoor. If you didn't make it on purpose, remove it.", evidence, fix: TERMINAL });
  if (empty.length) return fail(`${listJoin(empty)} can sign in without a password`, { detail: `Lock ${empty.length === 1 ? "it" : "them"} with sudo passwd -l, or set a password.`, evidence, fix: TERMINAL });
  return ok(`${plural(people.length, "account")} can sign in to the server, each with a password or key`, { evidence });
}

export async function sudoOutcome(ctx: CheckCtx): Promise<Outcome> {
  const pw = await passwd(ctx);
  const groups = parseGroup(readHostFileOr("/etc/group", ""));
  const admins = [...new Set(["sudo", "wheel", "admin"].flatMap((g) => groupMembers(g, groups, pw)))];
  const dockerGroup = groupMembers("docker", groups, pw);
  const texts = [readHostFileOr("/etc/sudoers", "")];
  try {
    for (const f of fs.readdirSync(hostPath("/etc/sudoers.d"))) if (!f.includes(".") && !f.endsWith("~")) texts.push(readHostFileOr(`/etc/sudoers.d/${f}`, ""));
  } catch {
    /* no drop-in folder */
  }
  const nopass = [...new Set(texts.flatMap(nopasswdRules))];
  const evidence = kv([["Can use sudo", admins.join(", ") || "nobody"], ["In the docker group (root-level)", dockerGroup.join(", ") || "nobody"], ["sudo without a password", nopass.join(", ") || "nobody"]]);
  if (nopass.length) {
    return warn(`${listJoin(nopass.map((n) => (n.startsWith("%") ? `the ${n.slice(1)} group` : n)))} can use sudo without a password`, {
      detail: "Anyone who gets into that account, even through an app bug, controls the whole server. Remove NOPASSWD from the rule in /etc/sudoers.d unless a script needs it.",
      evidence,
      fix: TERMINAL,
    });
  }
  return ok(`${plural(admins.length, "account")} can become root, and each must type a password`, { evidence });
}

interface PermProblem {
  /** A whole sentence: "Anyone can read /etc/shadow". */
  text: string;
  serious: boolean;
}

const SENSITIVE_FILES: { path: string; check: (mode: number) => PermProblem | null }[] = [
  { path: "/etc/shadow", check: (m) => (otherReadable(m) || otherWritable(m) ? { text: "Anyone can read the password hashes in /etc/shadow", serious: true } : null) },
  { path: "/etc/gshadow", check: (m) => (otherReadable(m) || otherWritable(m) ? { text: "Anyone can read /etc/gshadow", serious: true } : null) },
  { path: "/etc/passwd", check: (m) => (groupOrOtherWritable(m) ? { text: "Other users can change /etc/passwd", serious: true } : null) },
  { path: "/etc/group", check: (m) => (groupOrOtherWritable(m) ? { text: "Other users can change /etc/group", serious: true } : null) },
  { path: "/etc/sudoers", check: (m) => (groupOrOtherWritable(m) || otherReadable(m) ? { text: "Other users can read or change /etc/sudoers", serious: true } : null) },
  { path: "/etc/ssh/sshd_config", check: (m) => (groupOrOtherWritable(m) ? { text: "Other users can change SSH's settings", serious: true } : null) },
  { path: "/etc/crontab", check: (m) => (groupOrOtherWritable(m) ? { text: "Other users can schedule commands as root in /etc/crontab", serious: true } : null) },
  { path: "/root", check: (m) => (otherReadable(m) ? { text: "Anyone can look in root's home folder", serious: false } : null) },
];

export async function filePermsOutcome(): Promise<Outcome> {
  const problems: PermProblem[] = [];
  const rows: [string, string][] = [];
  for (const f of SENSITIVE_FILES) {
    try {
      const st = fs.statSync(hostPath(f.path));
      rows.push([f.path, `${octal(st.mode)} uid ${st.uid}`]);
      const p = f.check(st.mode);
      if (p) problems.push(p);
    } catch {
      /* not present */
    }
  }
  try {
    for (const name of fs.readdirSync(hostPath("/etc/ssh"))) {
      if (!/^ssh_host_.*_key$/.test(name)) continue;
      const st = fs.statSync(hostPath(`/etc/ssh/${name}`));
      rows.push([`/etc/ssh/${name}`, octal(st.mode)]);
      if (st.mode & 0o044) problems.push({ text: `Other users can read the server's private key ${name}`, serious: true });
    }
  } catch {
    /* no ssh */
  }
  // World-writable files where root reads config or runs programs.
  const ww = await tryHost("find", ["/etc", "/usr/local/bin", "/usr/local/sbin", "/usr/bin", "/usr/sbin", "-xdev", "-type", "f", "-perm", "-0002"], { timeoutMs: 20_000, okCodes: [1] }).catch(() => null);
  const worldWritable = (ww ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  rows.push(["Files anyone can change", worldWritable.length ? worldWritable.slice(0, 10).join(", ") : "none"]);
  if (worldWritable.length) problems.push({ text: worldWritable.length === 1 ? `Anyone can change ${worldWritable[0]}` : `Anyone can change ${worldWritable.length} system files, like ${worldWritable[0]}`, serious: true });
  const evidence = kv(rows);
  if (problems.length) {
    return (problems.some((p) => p.serious) ? fail : warn)(problems.length === 1 ? problems[0]!.text : `${problems.length} system files have unsafe permissions`, {
      detail: `${problems.length > 1 ? `${problems.slice(0, 3).map((p) => p.text).join(". ")}. ` : ""}Put the usual permissions back, for example sudo chmod 640 /etc/shadow or sudo chmod o-w on the file.`,
      evidence,
      fix: TERMINAL,
    });
  }
  return ok("Passwords, keys and system files are only readable by root", { evidence });
}

export async function kernelOutcome(): Promise<Outcome> {
  const weak: string[] = [];
  const rows: [string, string | null][] = [];
  for (const r of SYSCTL_RULES) {
    const v = sysctl(r.key);
    rows.push([r.key.replace(/\//g, "."), v]);
    if (v === null) continue;
    const w = r.weak(v);
    if (w) weak.push(`${r.label} is ${w}`);
  }
  for (const k of SYSCTL_INFO) rows.push([k.replace(/\//g, "."), sysctl(k)]);
  const evidence = kv(rows);
  if (!rows.some((r) => r[1] !== null)) return skip("Couldn't read the kernel's settings");
  if (weak.length) return warn(weak.length === 1 ? `${weak[0]}` : `${weak.length} kernel protections are weaker than the default`, { detail: `${weak.length > 1 ? `${listJoin(weak)}. ` : ""}Something turned ${weak.length === 1 ? "it" : "them"} down; put the value back in /etc/sysctl.d and run sudo sysctl --system.`, evidence, fix: TERMINAL });
  return ok("The kernel's built-in protections are on", { evidence });
}

export async function confinementOutcome(): Promise<Outcome> {
  const aa = readHostFileOr("/sys/module/apparmor/parameters/enabled", "").trim() === "Y";
  const profiles = readHostFileOr("/sys/kernel/security/apparmor/profiles", "").split("\n").filter(Boolean);
  const enforced = profiles.filter((p) => /\(enforce\)/.test(p)).length;
  const se = readHostFileOr("/sys/fs/selinux/enforce", "").trim();
  const evidence = kv([["AppArmor", aa ? `on${profiles.length ? `, ${enforced} of ${profiles.length} profiles enforced` : ""}` : "off"], ["SELinux", se === "1" ? "enforcing" : se === "0" ? "permissive" : "not present"]]);
  if (se === "1") return ok("SELinux is enforcing", { evidence });
  if (aa) return ok("AppArmor confines programs and containers", { evidence });
  if (se === "0") return warn("SELinux is only watching, not enforcing", { detail: "It logs what it would block but lets it happen. Set SELINUX=enforcing in /etc/selinux/config.", evidence, fix: TERMINAL });
  return warn("Programs and containers run without AppArmor or SELinux", { detail: "These limit what a program can do even after it's broken into. Debian and Ubuntu ship AppArmor; it's usually just switched off at boot.", evidence, fix: TERMINAL });
}

interface Inspected {
  name: string;
  risks: ReturnType<typeof containerRisks>;
}

const inspected = (ctx: CheckCtx) =>
  ctx.memo("hard:inspect", async (): Promise<Inspected[] | null> => {
    let list;
    try {
      list = await docker().listContainers({ all: false });
    } catch {
      return null;
    }
    const lim = limiter(6);
    const out = await Promise.all(
      list.slice(0, 300).map((c) =>
        lim(async () => {
          const name = (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, "");
          // Gluon needs its powers to manage the server; judging it here would only be noise.
          if (isSelfContainer(c.Id) || GLUON_NAME.test(name)) return null;
          try {
            return { name, risks: containerRisks((await docker().getContainer(c.Id).inspect()) as unknown as InspectLike) };
          } catch {
            return null;
          }
        }),
      ),
    );
    return out.filter((x): x is Inspected => !!x);
  });

export async function dockerApiOutcome(ctx: CheckCtx): Promise<Outcome> {
  const [ls, unit] = await Promise.all([listeners(ctx), tryHost("systemctl", ["show", "docker.service", "-p", "ExecStart", "--value"]).catch(() => null)]);
  const cfg = dockerTcpHosts(readHostFileOr("/etc/docker/daemon.json", ""), unit ?? "");
  const tcp = (ls ?? []).filter((l) => l.proto === "tcp" && l.process === "dockerd" && !isLoopback(l.addr));
  const evidence = kv([["Configured hosts", cfg.hosts.join(", ") || "only the local socket"], ["TLS client check", cfg.tlsverify ? "on" : "off"], ["dockerd listening on", tcp.map((l) => `${l.addr}:${l.port}`).join(", ") || "no network port"]]);
  if (!tcp.length && !cfg.hosts.some((h) => !/127\.0\.0\.1|localhost|\[::1\]/.test(h))) return ok("Docker only takes orders from this machine", { evidence });
  if (!cfg.tlsverify) return fail("Docker accepts commands from the network without a password", { detail: "Anyone who reaches that port can start a container that takes over the server. Remove the tcp:// host from /etc/docker/daemon.json or docker.service and restart Docker.", evidence, fix: TERMINAL });
  return warn("Docker takes commands over the network", { detail: "It checks client certificates, which is safe if only you hold them. Keep the port off the internet.", evidence });
}

export async function privilegedOutcome(ctx: CheckCtx): Promise<Outcome> {
  const cs = await inspected(ctx);
  if (!cs) return skip("Couldn't reach Docker to check privileged apps");
  const bad = cs.filter((c) => c.risks.privileged);
  const evidence = kv(cs.length ? bad.map((c) => [c.name, "privileged"]) : [["Running containers", 0]]);
  if (!bad.length) return ok(`None of ${plural(cs.length, "running container")} ${cs.length === 1 ? "is" : "are"} privileged`, { evidence: null });
  return warn(bad.length === 1 ? `${bad[0]!.name} runs with full access to the server` : `${bad.length} containers run with full access to the server`, {
    detail: `Privileged containers can reach every device and undo Docker's isolation, so a bug in ${bad.length === 1 ? "it" : "one of them"} is a bug in the server. Remove privileged: true unless the app's docs require it, and give it only the devices it needs.`,
    evidence,
    fix: go("Open apps", "/apps"),
  });
}

export async function dockerSocketOutcome(ctx: CheckCtx): Promise<Outcome> {
  const cs = await inspected(ctx);
  if (!cs) return skip("Couldn't reach Docker to check which apps control Docker");
  const bad = cs.filter((c) => c.risks.dockerSocket);
  if (!bad.length) return ok("No app can control Docker", { evidence: null });
  return warn(`${listJoin(bad.slice(0, 3).map((c) => c.name))}${bad.length > 3 ? ` and ${bad.length - 3} more` : ""} can control Docker`, {
    detail: "Access to the Docker socket is the same as root on the server. Tools like Portainer or Watchtower need it; anything else shouldn't have it. A socket proxy can limit what they're allowed to do.",
    evidence: kv(bad.map((c) => [c.name, "docker.sock mounted"])),
    fix: go("Open apps", "/apps"),
  });
}

export async function hostFoldersOutcome(ctx: CheckCtx): Promise<Outcome> {
  const cs = await inspected(ctx);
  if (!cs) return skip("Couldn't reach Docker to check apps' folders");
  const bad = cs.filter((c) => c.risks.hostPaths.length);
  if (!bad.length) return ok("No app has the server's system folders mounted", { evidence: null });
  const writable = bad.filter((c) => c.risks.hostPaths.some((p) => p.endsWith("(writable)")));
  const evidence = kv(bad.map((c) => [c.name, c.risks.hostPaths.join(", ")]));
  return warn(`${plural(bad.length, "app")} can ${writable.length ? "change" : "read"} the server's system folders`, {
    detail: `${listJoin(bad.slice(0, 3).map((c) => c.name))} ${bad.length === 1 ? "has" : "have"} folders like / or /etc mounted${writable.length ? " with write access" : ""}. Mount only the folders the app needs, read-only where you can.`,
    evidence,
    fix: go("Open apps", "/apps"),
  });
}

export async function containerPowersOutcome(ctx: CheckCtx): Promise<Outcome> {
  const cs = await inspected(ctx);
  if (!cs) return skip("Couldn't reach Docker to check apps' isolation");
  const bad = cs.filter((c) => c.risks.powers.length && !c.risks.privileged);
  const evidence = kv(bad.map((c) => [c.name, c.risks.powers.join(", ")]));
  if (!bad.length) return ok("Apps keep Docker's normal isolation", { evidence: null });
  const unconfined = bad.filter((c) => c.risks.powers.some((p) => /unconfined|SYS_ADMIN|SYS_MODULE|ALL|host processes/.test(p)));
  if (!unconfined.length) return ok(`${plural(bad.length, "app")} ${bad.length === 1 ? "shares" : "share"} the host's network or has an extra permission it likely needs`, { evidence });
  return warn(`${plural(unconfined.length, "app")} ${unconfined.length === 1 ? "has" : "have"} isolation switched off`, {
    detail: `${listJoin(unconfined.slice(0, 3).map((c) => `${c.name} (${c.risks.powers.slice(0, 2).join(", ")})`))}. These let a broken-into app reach past its container. Check the app really needs them.`,
    evidence,
    fix: go("Open apps", "/apps"),
  });
}

export function staleAdminsOutcome(): Outcome {
  const t = Date.now();
  const admins = listUsers().filter((u) => u.role === "admin" && !u.disabled);
  const stale = admins.filter((u) => (u.lastLoginAt ? t - u.lastLoginAt > 90 * DAY : t - u.createdAt > 14 * DAY));
  const evidence = kv(admins.map((u) => [u.username, u.lastLoginAt ? `last signed in ${formatRelative(u.lastLoginAt)}` : "never signed in"]));
  if (!stale.length) return ok(`${plural(admins.length, "admin")}, all in use`, { evidence });
  const names = stale.map((u) => u.displayName || u.username);
  return warn(stale.length === 1 ? `${names[0]} is an admin but hasn't signed in for months` : `${stale.length} admin accounts haven't been used for months`, {
    detail: "An account nobody watches is an easy way in. Turn it off in People, or make it a household account.",
    evidence,
    fix: go("Open People", peopleHref()),
  });
}

export function invitesOutcome(): Outcome {
  const t = Date.now();
  const open = listInvites().filter((i) => !i.usedAt && i.expiresAt > t);
  const evidence = kv(open.map((i) => [i.displayName ?? "invite", `${i.role}, expires ${formatRelative(i.expiresAt)}`]));
  const admin = open.filter((i) => i.role === "admin");
  if (!open.length) return ok("No invite links are waiting", { evidence: null });
  if (admin.length) return warn(admin.length === 1 ? "An admin invite link hasn't been used yet" : `${admin.length} admin invite links haven't been used yet`, { detail: "Whoever opens the link becomes an admin. Revoke it if you don't know where it went.", evidence, fix: go("Open People", peopleHref({ tab: "access" })) });
  return ok(`${plural(open.length, "household invite")} waiting`, { evidence });
}

export async function gluonPublicOutcome(ctx: CheckCtx): Promise<Outcome> {
  const r = await exposure(ctx);
  const port = Number(process.env.PORT ?? 8130);
  const own = r.internet.filter((x) => x.backend.port === port || (x.listener?.container && GLUON_NAME.test(x.listener.container)));
  const policy = mfaRequired("admin", "away");
  const evidence = kv([...own.map((x) => [x.url, x.viaCloudflare ? "through Cloudflare" : "direct"] as [string, string]), ["Two-step for admins away from home", policy ? "required" : "not required"]]);
  if (!own.length) return ok("Gluon is only reachable from home", { evidence });
  if (!policy) return fail("Gluon is on the internet and admins can sign in with just a password", { detail: "Gluon controls the whole server. Require two-step sign-in away from home in Settings → Server.", evidence, fix: go("Open server settings", "/settings/server") });
  return ok("Gluon is on the internet, and admins need two-step sign-in there", { evidence });
}
