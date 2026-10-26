import "server-only";
import { host } from "../host/exec";

/**
 * `ss` output parsing (iproute2). Addresses look like 0.0.0.0:2283, [::]:2283, *:8080,
 * [::ffff:172.17.0.1]:8581, 192.168.1.10%enp4s0:68, [fe80::1]%enp4s0:546.
 * The process column: users:(("docker-proxy",pid=3208,fd=8),("x",pid=2,fd=3)).
 */

export interface SsSocket {
  proto: "tcp" | "udp";
  state: string | null;
  recvQ: number;
  sendQ: number;
  local: { ip: string; port: number; iface: string | null };
  peer: { ip: string; port: number | null };
  processes: { name: string; pid: number }[];
}

export function parseAddr(s: string): { ip: string; port: number | null; iface: string | null } {
  const i = s.lastIndexOf(":");
  const portStr = i >= 0 ? s.slice(i + 1) : "";
  let ip = i >= 0 ? s.slice(0, i) : s;
  let iface: string | null = null;
  const pct = ip.indexOf("%");
  if (pct >= 0) {
    iface = ip.slice(pct + 1).replace(/\]$/, "");
    ip = ip.slice(0, pct);
  }
  ip = ip.replace(/^\[|\]$/g, "");
  if (ip === "*") ip = "0.0.0.0";
  const port = portStr === "*" || portStr === "" ? null : Number(portStr);
  return { ip, port: Number.isFinite(port) ? port : null, iface };
}

export function parseProcesses(s: string | undefined): { name: string; pid: number }[] {
  if (!s) return [];
  const out: { name: string; pid: number }[] = [];
  const re = /\("((?:[^"\\]|\\.)*)",pid=(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push({ name: m[1]!, pid: Number(m[2]) });
  // Same process listed once per fd: dedupe by pid.
  return out.filter((p, i) => out.findIndex((q) => q.pid === p.pid) === i);
}

/**
 * Parse `ss -H` lines. With a state filter (`state established`) ss drops the State column, so we
 * detect whether column 2 is a state word or a number.
 */
export function parseSs(text: string): SsSocket[] {
  const out: SsSocket[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const usersAt = line.indexOf("users:(");
    const head = (usersAt >= 0 ? line.slice(0, usersAt) : line).trim().split(/\s+/);
    const users = usersAt >= 0 ? line.slice(usersAt) : undefined;
    const netid = head[0];
    if (netid !== "tcp" && netid !== "udp") continue;
    let i = 1;
    let state: string | null = null;
    if (head[1] && !/^\d+$/.test(head[1])) {
      state = head[1];
      i = 2;
    }
    const recvQ = Number(head[i]);
    const sendQ = Number(head[i + 1]);
    const local = head[i + 2];
    const peer = head[i + 3];
    if (!local || !peer) continue;
    const l = parseAddr(local);
    const p = parseAddr(peer);
    if (l.port === null) continue;
    out.push({
      proto: netid,
      state,
      recvQ: Number.isFinite(recvQ) ? recvQ : 0,
      sendQ: Number.isFinite(sendQ) ? sendQ : 0,
      local: { ip: l.ip, port: l.port, iface: l.iface },
      peer: { ip: p.ip, port: p.port },
      processes: parseProcesses(users),
    });
  }
  return out;
}

/** Listening TCP + bound UDP sockets in the host's network namespace. */
export async function hostListeners(): Promise<SsSocket[]> {
  const { stdout } = await host("ss", ["-tulpnH"], { timeoutMs: 8000, maxBuffer: 8 * 1024 * 1024 });
  return parseSs(stdout);
}

/** Established TCP (and connected UDP) sockets in the host's network namespace. */
export async function hostEstablished(): Promise<SsSocket[]> {
  const { stdout } = await host("ss", ["-tunpH", "state", "established"], { timeoutMs: 8000, maxBuffer: 16 * 1024 * 1024 });
  return parseSs(stdout);
}

// ---------------------------------------------------------------- /proc/<pid>/net/{tcp,udp}{,6}

function hexToIpv4(hex: string): string {
  // Little-endian 32-bit word.
  const n = parseInt(hex, 16);
  return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join(".");
}

function hexToIpv6(hex: string): string {
  // Four little-endian 32-bit words.
  const bytes: number[] = [];
  for (let w = 0; w < 4; w++) {
    const word = hex.slice(w * 8, w * 8 + 8);
    for (let b = 3; b >= 0; b--) bytes.push(parseInt(word.slice(b * 2, b * 2 + 2), 16));
  }
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 255 && bytes[11] === 255) return `::ffff:${bytes.slice(12).join(".")}`;
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16));
  return compressIpv6(groups);
}

/** Eight hex groups → canonical text form (lowercase, no leading zeros, longest zero run as ::). */
export function compressIpv6(input: string[]): string {
  const groups = input.map((x) => parseInt(x, 16).toString(16));
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== "0") {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === "0") j++;
    if (j - i > bestLen) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  if (bestLen < 2) return groups.join(":");
  return `${groups.slice(0, best).join(":")}::${groups.slice(best + bestLen).join(":")}`;
}

export interface ProcNetSocket {
  proto: "tcp" | "udp";
  local: { ip: string; port: number };
  remote: { ip: string; port: number };
  /** Kernel TCP state: 01 ESTABLISHED, 0A LISTEN, 07 CLOSE (UDP unconnected) … */
  st: string;
  txQ: number;
  rxQ: number;
}

/** Sockets in the network namespace of `pid` (reads /proc/<pid>/net/*; no process info). */
export function procNetSockets(readFile: (p: string) => string | null, pid: number): ProcNetSocket[] {
  const out: ProcNetSocket[] = [];
  for (const [file, proto, v6] of [
    ["tcp", "tcp", false],
    ["tcp6", "tcp", true],
    ["udp", "udp", false],
    ["udp6", "udp", true],
  ] as const) {
    const text = readFile(`/proc/${pid}/net/${file}`);
    if (!text) continue;
    for (const line of text.split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 5) continue;
      const [lip, lport] = f[1]!.split(":");
      const [rip, rport] = f[2]!.split(":");
      if (!lip || !lport || !rip || !rport) continue;
      const [tx, rx] = (f[4] ?? "0:0").split(":");
      out.push({
        proto,
        local: { ip: v6 ? hexToIpv6(lip) : hexToIpv4(lip), port: parseInt(lport, 16) },
        remote: { ip: v6 ? hexToIpv6(rip) : hexToIpv4(rip), port: parseInt(rport, 16) },
        st: f[3]!.toUpperCase(),
        txQ: parseInt(tx ?? "0", 16) || 0,
        rxQ: parseInt(rx ?? "0", 16) || 0,
      });
    }
  }
  return out;
}
