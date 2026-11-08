/**
 * Pure parsers behind the security checks. No I/O, so each one is tested on real command output.
 * Everything here reads; nothing builds a command.
 */

// ---------------------------------------------------------------- listening sockets (ss -H -lntup)

export interface Listener {
  proto: "tcp" | "udp";
  /** As ss printed it, without brackets or an interface suffix: "0.0.0.0", "::", "*", "192.168.1.5". */
  addr: string;
  port: number;
  process: string | null;
}

/** `ss -H -lntup`: Netid State Recv-Q Send-Q Local Peer [Process]. */
export function parseSsListen(stdout: string): Listener[] {
  const out: Listener[] = [];
  for (const line of stdout.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const proto = cols[0] === "tcp" || cols[0] === "udp" ? cols[0] : null;
    if (!proto) continue;
    const local = cols[4]!;
    const i = local.lastIndexOf(":");
    if (i <= 0) continue;
    const port = Number(local.slice(i + 1));
    if (!Number.isInteger(port) || port <= 0) continue;
    const addr = local.slice(0, i).replace(/^\[|\]$/g, "").replace(/%.*$/, "");
    const proc = line.match(/users:\(\("([^"]+)"/)?.[1] ?? null;
    out.push({ proto, addr, port, process: proc });
  }
  return out;
}

export const isLoopback = (addr: string) => /^127\./.test(addr) || addr === "::1" || addr === "localhost" || /^::ffff:127\./.test(addr);
export const isAnyAddr = (addr: string) => addr === "0.0.0.0" || addr === "::" || addr === "*";
export const isV6Any = (addr: string) => addr === "::" || addr === "*";

export interface RiskyPort {
  label: string;
  severity: "fail" | "warn";
  why: string;
}

/** Services that shouldn't answer anyone on the network. Docker's own API has its own check. */
export const RISKY_PORTS: Record<string, RiskyPort> = {
  "tcp:23": { label: "Telnet", severity: "fail", why: "sends passwords in plain text" },
  "tcp:512": { label: "rexec", severity: "fail", why: "sends passwords in plain text" },
  "tcp:513": { label: "rlogin", severity: "fail", why: "trusts clients by address" },
  "tcp:514": { label: "rsh", severity: "fail", why: "trusts clients by address" },
  "tcp:21": { label: "FTP", severity: "warn", why: "sends passwords in plain text" },
  "udp:69": { label: "TFTP", severity: "warn", why: "has no login at all" },
  "udp:161": { label: "SNMP", severity: "warn", why: "often answers with a default community string" },
  "tcp:873": { label: "rsync daemon", severity: "warn", why: "can share folders without a password" },
  "tcp:3389": { label: "Remote Desktop", severity: "warn", why: "is a favourite target for password guessing" },
  "tcp:2379": { label: "etcd", severity: "warn", why: "holds cluster secrets and often has no login" },
  "tcp:10250": { label: "Kubernetes kubelet", severity: "warn", why: "can run commands in containers" },
  ...Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`tcp:${5900 + i}`, { label: "VNC remote screen", severity: "warn", why: "often uses a short password or none" } satisfies RiskyPort])),
  ...Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`tcp:${6000 + i}`, { label: "X11 display", severity: "warn", why: "lets anyone who connects watch and type" } satisfies RiskyPort])),
};

export function riskyListeners(list: Listener[]): (Listener & RiskyPort)[] {
  const seen = new Set<string>();
  const out: (Listener & RiskyPort)[] = [];
  for (const l of list) {
    if (isLoopback(l.addr)) continue;
    const risk = RISKY_PORTS[`${l.proto}:${l.port}`];
    const k = `${l.proto}:${l.port}`;
    if (!risk || seen.has(k)) continue;
    seen.add(k);
    out.push({ ...l, ...risk });
  }
  return out.sort((a, b) => (a.severity === b.severity ? a.port - b.port : a.severity === "fail" ? -1 : 1));
}

// ---------------------------------------------------------------- firewall

export interface FilterState {
  /** Something drops or rejects unwanted incoming connections. */
  filtering: boolean;
  /** How it was decided, for the evidence. */
  how: string;
}

/**
 * `nft list ruleset`: is there an input-hook chain that drops by default, or has drop/reject rules?
 * `families` limits which tables count ("ip", "ip6", "inet").
 */
export function nftInput(ruleset: string, families: ("ip" | "ip6" | "inet")[]): FilterState | null {
  let table: string | null = null;
  let chain: { name: string; hook: boolean; policy: string | null; drops: number } | null = null;
  const found: { name: string; family: string; policy: string | null; drops: number }[] = [];
  let depth = 0;
  for (const raw of ruleset.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const before = depth;
    depth = Math.max(0, depth + (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0));
    if (before === 0) {
      table = line.match(/^table\s+(\S+)\s/)?.[1] ?? null;
      continue;
    }
    if (before === 1) {
      const c = line.match(/^chain\s+(\S+)\s*\{/);
      chain = c && depth >= 2 ? { name: c[1]!, hook: false, policy: null, drops: 0 } : null;
    } else if (chain) {
      if (/type\s+filter\s+hook\s+input\b/.test(line)) {
        chain.hook = true;
        chain.policy = line.match(/policy\s+(\w+)/)?.[1] ?? "accept";
      } else if (/\b(drop|reject)\b/.test(line) || /\bjump\s+ufw/.test(line)) {
        // A jump to ufw's chains carries its drops.
        chain.drops++;
      }
    }
    if (chain && depth < 2) {
      if (chain.hook && table) found.push({ name: chain.name, family: table, policy: chain.policy, drops: chain.drops });
      chain = null;
    }
    if (depth === 0) table = null;
  }
  const relevant = found.filter((f) => (families as string[]).includes(f.family));
  if (!relevant.length) return null;
  const strict = relevant.find((f) => f.policy === "drop");
  if (strict) return { filtering: true, how: `nftables ${strict.family} chain ${strict.name} drops by default` };
  const ruled = relevant.find((f) => f.drops > 0);
  if (ruled) return { filtering: true, how: `nftables ${ruled.family} chain ${ruled.name} has ${ruled.drops} drop rule${ruled.drops === 1 ? "" : "s"}` };
  return { filtering: false, how: `nftables input chains accept everything (${relevant.map((r) => `${r.family} ${r.name}`).join(", ")})` };
}

/** `iptables -S INPUT` (or ip6tables). */
export function iptablesInput(stdout: string): FilterState | null {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const policy = lines.find((l) => l.startsWith("-P INPUT"))?.split(/\s+/)[2] ?? null;
  if (policy === "DROP" || policy === "REJECT") return { filtering: true, how: `iptables INPUT policy ${policy}` };
  const drops = lines.filter((l) => /^-A INPUT\b/.test(l) && /-j\s+(DROP|REJECT|ufw-|f2b-|LOG_DROP|INPUT_direct|IN_)/.test(l));
  if (drops.length) return { filtering: true, how: `iptables INPUT has ${drops.length} filtering rule${drops.length === 1 ? "" : "s"}` };
  return { filtering: false, how: `iptables INPUT policy ${policy ?? "unknown"} with no drop rules` };
}

/** `ufw status verbose`. */
export function parseUfw(stdout: string): { active: boolean; incoming: string | null } | null {
  const status = stdout.match(/^Status:\s*(\w+)/m)?.[1];
  if (!status) return null;
  return { active: status === "active", incoming: stdout.match(/^Default:\s*(\w+)\s*\(incoming\)/m)?.[1] ?? null };
}

// ---------------------------------------------------------------- IPv6

/** `ip -6 -o addr show scope global`: public-looking addresses (not ULA fc00::/7, not deprecated). */
export function globalV6(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/\binet6\s+([0-9a-f:]+)\/\d+/i);
    if (!m || /\bdeprecated\b/.test(line)) continue;
    const a = m[1]!.toLowerCase();
    if (/^f[cd]/.test(a) || a.startsWith("fe80")) continue;
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

// ---------------------------------------------------------------- SSH

/** `sshd -T` into lowercase key → values (repeated keys keep every value). */
export function parseSshdT(stdout: string): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const line of stdout.split("\n")) {
    const i = line.indexOf(" ");
    if (i <= 0) continue;
    const k = line.slice(0, i).toLowerCase();
    const v = line.slice(i + 1).trim();
    m.set(k, [...(m.get(k) ?? []), v]);
  }
  return m;
}

const WEAK: Record<string, RegExp> = {
  ciphers: /(-cbc$|^arcfour|^3des|^blowfish|^cast128|^rijndael)/,
  macs: /(md5|sha1-96|ripemd|umac-32)/,
  kexalgorithms: /(group1-sha1|group14-sha1|group-exchange-sha1|gss-.*-sha1)/,
  hostkeyalgorithms: /^ssh-dss/,
};

/** Algorithms in the effective config that are broken or retired. */
export function weakSshAlgorithms(cfg: Map<string, string[]>): { setting: string; names: string[] }[] {
  const out: { setting: string; names: string[] }[] = [];
  for (const [setting, re] of Object.entries(WEAK)) {
    const names = (cfg.get(setting)?.[0] ?? "").split(",").map((s) => s.trim()).filter((s) => s && re.test(s));
    if (names.length) out.push({ setting, names });
  }
  return out;
}

export interface AuthorizedKey {
  type: string;
  bits: number | null;
  comment: string;
  /** Restrictions in front of the key (from=, command=, restrict). */
  restricted: boolean;
}

const KEY_TYPE = /^(ssh-(rsa|dss|ed25519)|ecdsa-sha2-nistp\d+|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com|ssh-ed448)$/;

/** RSA modulus size straight from the key blob (SSH wire format: string type, mpint e, mpint n). */
export function rsaBits(blobB64: string): number | null {
  let buf: Buffer;
  try {
    buf = Buffer.from(blobB64, "base64");
  } catch {
    return null;
  }
  let off = 0;
  const next = () => {
    if (off + 4 > buf.length) return null;
    const len = buf.readUInt32BE(off);
    off += 4;
    if (off + len > buf.length) return null;
    const v = buf.subarray(off, off + len);
    off += len;
    return v;
  };
  const type = next();
  if (!type || type.toString() !== "ssh-rsa") return null;
  if (!next()) return null;
  const n = next();
  if (!n) return null;
  let i = 0;
  while (i < n.length && n[i] === 0) i++;
  if (i === n.length) return 0;
  return (n.length - i - 1) * 8 + (32 - Math.clz32(n[i]!));
}

/** authorized_keys: one key per line, optionally behind options (which may contain quoted spaces). */
export function parseAuthorizedKeys(text: string): AuthorizedKey[] {
  const keys: AuthorizedKey[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // Split on spaces outside quotes.
    const toks = line.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
    const at = toks.findIndex((t) => KEY_TYPE.test(t));
    if (at < 0) continue;
    const type = toks[at]!;
    const blob = toks[at + 1] ?? "";
    keys.push({ type, bits: type === "ssh-rsa" ? rsaBits(blob) : null, comment: toks.slice(at + 2).join(" "), restricted: at > 0 });
  }
  return keys;
}

export function weakKey(k: AuthorizedKey): string | null {
  if (k.type === "ssh-dss") return "DSA, which OpenSSH no longer trusts";
  if (k.type === "ssh-rsa" && k.bits !== null && k.bits < 2048) return `RSA with only ${k.bits} bits`;
  return null;
}

/** `fail2ban-client status sshd`. */
export function parseFail2banJail(stdout: string): { banned: number | null; total: number | null } {
  const n = (re: RegExp) => {
    const v = stdout.match(re)?.[1];
    return v === undefined ? null : Number(v);
  };
  return { banned: n(/Currently banned:\s*(\d+)/), total: n(/Total banned:\s*(\d+)/) };
}

// ---------------------------------------------------------------- host accounts

export interface PasswdEntry {
  name: string;
  /** The second field: "x" means the hash is in /etc/shadow. */
  pass: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
}

export function parsePasswd(text: string): PasswdEntry[] {
  const out: PasswdEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#") || line.startsWith("+") || line.startsWith("-")) continue;
    const f = line.split(":");
    if (f.length < 7) continue;
    const uid = Number(f[2]);
    if (!Number.isInteger(uid)) continue;
    out.push({ name: f[0]!, pass: f[1]!, uid, gid: Number(f[3]), home: f[5]!, shell: f[6]! });
  }
  return out;
}

export const canLogIn = (p: PasswdEntry) => !/(nologin|false|sync|shutdown|halt)$/.test(p.shell) && p.shell !== "";

/** Accounts with no password at all (an empty hash field); locked ("!", "*") ones don't count. */
export function emptyPasswords(shadow: string, passwd: PasswdEntry[]): string[] {
  const loginNames = new Set(passwd.filter(canLogIn).map((p) => p.name));
  const out = new Set<string>(passwd.filter((p) => canLogIn(p) && p.pass === "").map((p) => p.name));
  for (const line of shadow.split("\n")) {
    const f = line.split(":");
    if (f.length < 2) continue;
    if (f[1] === "" && loginNames.has(f[0]!)) out.add(f[0]!);
  }
  return [...out];
}

/** /etc/group into group → members (supplementary only; primary-group users are added by the caller). */
export function parseGroup(text: string): Map<string, { gid: number; members: string[] }> {
  const m = new Map<string, { gid: number; members: string[] }>();
  for (const line of text.split("\n")) {
    const f = line.split(":");
    if (f.length < 4 || !f[0]) continue;
    m.set(f[0], { gid: Number(f[2]), members: f[3]!.split(",").map((s) => s.trim()).filter(Boolean) });
  }
  return m;
}

/** Members of a group, including users whose primary group it is. */
export function groupMembers(name: string, groups: ReturnType<typeof parseGroup>, passwd: PasswdEntry[]): string[] {
  const g = groups.get(name);
  if (!g) return [];
  return [...new Set([...g.members, ...passwd.filter((p) => p.gid === g.gid).map((p) => p.name)])];
}

/** NOPASSWD rules in sudoers text: who they cover ("%sudo", "pi"). Defaults and aliases are skipped. */
export function nopasswdRules(text: string): string[] {
  const out: string[] = [];
  // Join continuation lines first.
  const joined = text.replace(/\\\n/g, " ");
  for (const raw of joined.split("\n")) {
    const line = raw.replace(/(^|\s)#(?!include).*$/, "").trim();
    if (!line || /^(Defaults|User_Alias|Runas_Alias|Host_Alias|Cmnd_Alias|@include|#include)/.test(line)) continue;
    if (!/\bNOPASSWD\s*:/.test(line)) continue;
    const who = line.split(/\s+/)[0]!;
    if (!out.includes(who)) out.push(who);
  }
  return out;
}

// ---------------------------------------------------------------- automatic updates (apt)

/** The effective APT::Periodic::Unattended-Upgrade from apt.conf.d files, read in apt's order. */
export function aptUnattended(files: { name: string; text: string }[]): boolean | null {
  let v: boolean | null = null;
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const body = f.text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of body.matchAll(/APT::Periodic::Unattended-Upgrade\s+"([^"]*)"/g)) v = m[1] !== "0" && m[1] !== "";
  }
  return v;
}

// ---------------------------------------------------------------- kernel settings

export interface SysctlRule {
  key: string;
  label: string;
  /** Returns a problem sentence when the value is weak, or null. */
  weak: (v: string) => string | null;
}

export const SYSCTL_RULES: SysctlRule[] = [
  { key: "kernel/randomize_va_space", label: "Memory layout randomisation", weak: (v) => (v === "2" ? null : v === "1" ? "only partly on" : "off") },
  { key: "fs/protected_symlinks", label: "Symlink protection", weak: (v) => (v === "1" ? null : "off") },
  { key: "fs/protected_hardlinks", label: "Hardlink protection", weak: (v) => (v === "1" ? null : "off") },
  { key: "net/ipv4/tcp_syncookies", label: "SYN flood protection", weak: (v) => (v === "0" ? "off" : null) },
  { key: "net/ipv4/conf/all/accept_source_route", label: "Source-routed packets", weak: (v) => (v === "0" ? null : "accepted") },
  { key: "net/ipv4/icmp_echo_ignore_broadcasts", label: "Broadcast ping replies", weak: (v) => (v === "0" ? "on (smurf amplification)" : null) },
];

/** Shown in the evidence only: stricter settings some guides recommend, which distributions vary on. */
export const SYSCTL_INFO = ["kernel/kptr_restrict", "kernel/dmesg_restrict", "kernel/yama/ptrace_scope", "kernel/unprivileged_bpf_disabled", "net/ipv4/conf/all/rp_filter", "net/ipv4/conf/all/accept_redirects", "net/ipv4/ip_forward", "fs/suid_dumpable"];

// ---------------------------------------------------------------- UPnP

/** An SSDP reply's LOCATION header. */
export function ssdpLocation(reply: string): string | null {
  return reply.match(/^location:\s*(\S+)\s*$/im)?.[1] ?? null;
}

/** The WAN connection service's control URL from a device description, resolved against `base`. */
export function igdControlUrl(xml: string, base: string): { url: string; serviceType: string } | null {
  const urlBase = xml.match(/<URLBase>\s*([^<\s]+)\s*<\/URLBase>/i)?.[1];
  for (const svc of xml.matchAll(/<service>([\s\S]*?)<\/service>/gi)) {
    const body = svc[1]!;
    const type = body.match(/<serviceType>\s*([^<\s]+)\s*<\/serviceType>/i)?.[1];
    const ctrl = body.match(/<controlURL>\s*([^<\s]+)\s*<\/controlURL>/i)?.[1];
    if (!type || !ctrl || !/:service:WAN(IP|PPP)Connection:\d/.test(type)) continue;
    try {
      return { url: new URL(ctrl, urlBase ?? base).toString(), serviceType: type };
    } catch {
      return null;
    }
  }
  return null;
}

export interface UpnpMapping {
  externalPort: number;
  protocol: string;
  internalClient: string;
  internalPort: number;
  description: string;
  enabled: boolean;
  leaseSeconds: number | null;
}

/** A GetGenericPortMappingEntry response, or null for a SOAP fault (past the end of the table). */
export function parseMappingEntry(xml: string): UpnpMapping | null {
  if (/<(\w+:)?Fault>/i.test(xml)) return null;
  const tag = (n: string) => xml.match(new RegExp(`<(?:\\w+:)?${n}>([^<]*)</(?:\\w+:)?${n}>`, "i"))?.[1]?.trim() ?? null;
  const ext = Number(tag("NewExternalPort"));
  if (!Number.isInteger(ext) || ext <= 0) return null;
  const lease = tag("NewLeaseDuration");
  return {
    externalPort: ext,
    protocol: (tag("NewProtocol") ?? "").toUpperCase(),
    internalClient: tag("NewInternalClient") ?? "",
    internalPort: Number(tag("NewInternalPort")) || ext,
    description: (tag("NewPortMappingDescription") ?? "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"),
    enabled: tag("NewEnabled") !== "0",
    leaseSeconds: lease === null ? null : Number(lease),
  };
}

// ---------------------------------------------------------------- containers

/** The parts of `docker inspect` the container checks read. */
export interface InspectLike {
  Name?: string;
  HostConfig?: {
    Privileged?: boolean;
    NetworkMode?: string;
    PidMode?: string;
    IpcMode?: string;
    UsernsMode?: string;
    CapAdd?: string[] | null;
    SecurityOpt?: string[] | null;
    Devices?: unknown[] | null;
  };
  Mounts?: { Type?: string; Source?: string; Destination?: string; RW?: boolean }[];
}

export interface ContainerRisks {
  privileged: boolean;
  dockerSocket: boolean;
  /** Sensitive host folders mounted in: "/", "/etc" … with (rw) when writable. */
  hostPaths: string[];
  /** Host namespaces, dangerous capabilities and turned-off confinement. */
  powers: string[];
}

const DANGEROUS_CAPS = new Set(["ALL", "SYS_ADMIN", "SYS_MODULE", "SYS_PTRACE", "SYS_RAWIO", "DAC_READ_SEARCH", "NET_ADMIN", "SYS_BOOT", "BPF", "PERFMON"]);
const SENSITIVE = [/^\/$/, /^\/etc(\/(shadow|sudoers|ssh)?)?$/, /^\/root(\/|$)/, /^\/boot$/, /^\/(usr|bin|sbin|lib)$/, /^\/var\/lib\/docker(\/|$)/, /^\/proc$/, /^\/sys$/, /^\/dev$/, /^\/home$/];
const SOCKETS = /(^|\/)(docker|podman|containerd)\.sock$/;

export function containerRisks(c: InspectLike): ContainerRisks {
  const hc = c.HostConfig ?? {};
  const mounts = (c.Mounts ?? []).filter((m) => m.Type === "bind" && m.Source);
  const powers: string[] = [];
  if (hc.NetworkMode === "host") powers.push("host network");
  if (hc.PidMode === "host") powers.push("host processes");
  if (hc.IpcMode === "host") powers.push("host IPC");
  if (hc.UsernsMode === "host") powers.push("host users");
  for (const cap of hc.CapAdd ?? []) {
    const n = cap.toUpperCase().replace(/^CAP_/, "");
    if (DANGEROUS_CAPS.has(n)) powers.push(`CAP_${n}`);
  }
  for (const o of hc.SecurityOpt ?? []) {
    if (/^(apparmor|seccomp)[=:]unconfined$/i.test(o)) powers.push(o.replace(":", "=").toLowerCase());
    if (/^label[=:]disable$/i.test(o)) powers.push("selinux labels off");
  }
  return {
    privileged: !!hc.Privileged,
    dockerSocket: mounts.some((m) => SOCKETS.test(m.Source!)),
    hostPaths: mounts.filter((m) => SENSITIVE.some((re) => re.test(m.Source!.replace(/\/+$/, "") || "/"))).map((m) => `${m.Source}${m.RW ? " (writable)" : ""}`),
    powers,
  };
}

/** Docker daemon config: plain-TCP API hosts and whether TLS client verification is on. */
export function dockerTcpHosts(daemonJson: string, execStart: string): { hosts: string[]; tlsverify: boolean } {
  const hosts: string[] = [];
  let tlsverify = false;
  try {
    const j = JSON.parse(daemonJson || "{}") as { hosts?: unknown; tlsverify?: unknown };
    if (Array.isArray(j.hosts)) for (const h of j.hosts) if (typeof h === "string" && /^tcp:\/\//.test(h)) hosts.push(h);
    tlsverify = j.tlsverify === true;
  } catch {
    /* not JSON: dockerd wouldn't start either; ignore */
  }
  for (const m of execStart.matchAll(/(?:-H|--host)[=\s]+(tcp:\/\/\S+)/g)) if (!hosts.includes(m[1]!)) hosts.push(m[1]!);
  if (/--tlsverify\b/.test(execStart)) tlsverify = true;
  return { hosts, tlsverify };
}

// ---------------------------------------------------------------- distribution support

export function osRelease(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

// ---------------------------------------------------------------- file modes

/** "0640" style, and which unsafe bits are set. */
export const octal = (mode: number) => `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
export const otherWritable = (mode: number) => (mode & 0o002) !== 0;
export const otherReadable = (mode: number) => (mode & 0o004) !== 0;
export const groupOrOtherWritable = (mode: number) => (mode & 0o022) !== 0;
