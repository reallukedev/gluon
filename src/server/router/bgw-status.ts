import type { BroadbandT, DeviceT, FirewallT, OpticalT, RouterFactsT, WifiBand, WifiNetworkT } from "@/lib/router-types";

/**
 * Reading the AT&T BGW pages anyone on the home network can open (sysinfo, broadbandstatistics,
 * fiberstat, home, devices, firewall). Pure: HTML in, plain data out. The pages are tables of
 * `<th scope="row">label</th><td>value</td>`, often with tags left open, so labels and values are
 * paired straight from the markup rather than through a DOM, and every value is optional.
 */

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };

/** A cell's text: <br> becomes a line break, an image its alt text in brackets, entities decoded. */
export function cellText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/gi, (_, alt: string) => (alt ? ` [${alt}] ` : " "))
    .replace(/<[^>]*>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .split("\n")
    .map((l) => l.replace(/[\s ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export interface Pair {
  label: string;
  value: string;
  /** The value's raw HTML, for images and line breaks. */
  html: string;
}

/** Every row label in order with the cell that follows it ("" when the row has none). */
export function pairs(html: string): Pair[] {
  const out: Pair[] = [];
  const re = /<th\b[^>]*>([\s\S]*?)<\/th>\s*(?:<td\b[^>]*>([\s\S]*?)(?:<\/td>|(?=<\/?tr\b|<th\b)))?/gi;
  for (const m of html.matchAll(re)) {
    const label = cellText(m[1] ?? "");
    if (!label) continue;
    out.push({ label, value: cellText(m[2] ?? ""), html: m[2] ?? "" });
  }
  return out;
}

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** First value whose label is `label` (compared without case, spaces or punctuation). */
const pick = (ps: Pair[], ...labels: string[]) => ps.find((p) => labels.some((l) => key(p.label) === key(l)))?.value ?? null;
const blank = (v: string | null) => (v && v !== "-" && v.toLowerCase() !== "n/a" ? v : null);
const num = (v: string | null) => {
  const m = v?.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
};
const onOff = (v: string | null): boolean | null => {
  const t = v?.toLowerCase().trim();
  if (!t) return null;
  if (/^(on|up|enabled|available|yes)\b/.test(t)) return true;
  if (/^(off|down|disabled|unavailable|no)\b/.test(t)) return false;
  return null;
};

/** The page's main content, without the help panel (which repeats every label as prose). */
function content(html: string): string {
  const i = html.search(/id="content-sub"/);
  const j = html.search(/id="help"/);
  return html.slice(i >= 0 ? i : 0, j > i ? j : undefined);
}

/** Split at each <h2> heading: { heading: html under it }. Text before the first heading is "". */
function sections(html: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = html.split(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
  out.set("", parts[0] ?? "");
  for (let i = 1; i < parts.length; i += 2) out.set(key(cellText(parts[i] ?? "")), parts[i + 1] ?? "");
  return out;
}

/** Seconds, from "518420" or "6:00:00:20" (days:hours:minutes:seconds). */
export function parseUptime(v: string | null): number | null {
  const t = v?.trim();
  if (!t) return null;
  if (/^\d+$/.test(t)) return Number(t);
  const parts = t.split(":").map(Number);
  if (parts.length < 2 || parts.length > 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const unit = [86_400, 3600, 60, 1].slice(4 - parts.length);
  return parts.reduce((acc, n, i) => acc + n * unit[i]!, 0);
}

/**
 * The router keeps local time without a zone ("2026-10-25T15:47:22"). Comparing it with when the
 * page was read gives its offset from UTC (to the nearest quarter hour), which turns its other
 * local times into real instants.
 */
export function routerOffset(localNow: string | null, readAt: number): number | null {
  const t = localNow?.trim();
  if (!t || /Z$/.test(t)) return t ? 0 : null;
  const asUtc = Date.parse(`${t.replace(" ", "T")}Z`);
  if (!Number.isFinite(asUtc)) return null;
  const q = 15 * 60_000;
  const off = Math.round((asUtc - readAt) / q) * q;
  return Math.abs(off) <= 14 * 3_600_000 ? off : null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** "Sun Oct 18 00:01:43 2026" in the router's local time, to epoch ms. */
export function routerTime(v: string | null, offset: number | null): number | null {
  const m = v?.match(/([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})/);
  if (!m || offset === null) return null;
  const month = MONTHS.indexOf(m[1]!.toLowerCase());
  if (month < 0) return null;
  return Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])) - offset;
}

// ---------------------------------------------------------------- System Information

export interface Sysinfo extends RouterFactsT {
  uptimeS: number | null;
  /** The router's clock offset from UTC in ms, when it shows the time. */
  offset: number | null;
}

export function readSysinfo(html: string, readAt: number): Sysinfo {
  const ps = pairs(content(html));
  const uptimeS = parseUptime(pick(ps, "Time Since Last Reboot"));
  const firstUse = blank(pick(ps, "First Use Date"));
  return {
    manufacturer: blank(pick(ps, "Manufacturer")),
    model: blank(pick(ps, "Model Number")),
    serial: blank(pick(ps, "Serial Number")),
    firmware: blank(pick(ps, "Software Version")),
    hardware: blank(pick(ps, "Hardware Version")),
    wanMac: blank(pick(ps, "MAC Address"))?.toLowerCase() ?? null,
    firstUse: firstUse && Number.isFinite(Date.parse(firstUse)) ? Date.parse(firstUse) : null,
    uptimeS,
    bootAt: uptimeS !== null ? readAt - uptimeS * 1000 : null,
    offset: routerOffset(blank(pick(ps, "Current Date/Time")), readAt),
  };
}

// ---------------------------------------------------------------- Broadband Status

export function readBroadband(html: string): BroadbandT {
  const sec = sections(content(html));
  const main = pairs(sec.get("primarybroadband") ?? sec.get("") ?? "");
  const eth = pairs(sec.get("ethernetstatus") ?? "");
  const v6 = pairs(sec.get("ipv6") ?? "");
  const st = pairs(sec.get("ipv4statistics") ?? "");
  const pon = pairs(sec.get("gponstatus") ?? sec.get("xgsponstatus") ?? "");
  const source = blank(pick(main, "Broadband Connection Source"));
  const n = (label: string) => num(pick(st, label));
  const errs = [n("Receive Errors"), n("Transmit Errors")].filter((x): x is number => x !== null);
  return {
    source: source ? source.charAt(0) + source.slice(1).toLowerCase() : null,
    up: onOff(pick(main, "Broadband Connection")),
    ipv4: blank(pick(main, "Broadband IPv4 Address")),
    gateway4: blank(pick(main, "Gateway IPv4 Address")),
    dns: [pick(main, "Primary DNS"), pick(main, "Secondary DNS")].map(blank).filter((x): x is string => !!x),
    mtu: num(pick(main, "MTU")),
    lineMbps: num(pick(eth, "Current Speed (Mbps)", "Current Speed")),
    ipv6: {
      available: onOff(pick(v6, "Status")),
      kind: blank(pick(v6, "Service Type")),
      address: blank(pick(v6, "Global Unicast IPv6 Address")),
      gateway: blank(pick(v6, "Default IPv6 Gateway Address")),
    },
    rxBytes: n("Receive Bytes"),
    txBytes: n("Transmit Bytes"),
    errors: errs.length ? errs.reduce((a, b) => a + b, 0) : null,
    pon: blank(pick(pon, "PON Link Status")),
  };
}

// ---------------------------------------------------------------- Fiber Status

/** One "Rx Power  Currently -179" block: the value and its alarm and warning thresholds. */
function measure(html: string, name: string): { now: number; alarm: [number, number] | null; warn: [number, number] | null } | null {
  const re = new RegExp(`<h1[^>]*>\\s*${name}(?:&nbsp;|\\s)*Currently\\s*(-?\\d+(?:\\.\\d+)?)\\s*</h1>([\\s\\S]*?)</table>`, "i");
  const m = html.match(re);
  if (!m) return null;
  const row = (label: string): [number, number] | null => {
    const r = m[2]!.match(new RegExp(`>\\s*${label}\\s*</td>([\\s\\S]*?)</tr>`, "i"));
    const th = [...(r?.[1] ?? "").matchAll(/Threshold\s*(-?\d+(?:\.\d+)?)/gi)].map((x) => Number(x[1]));
    return th.length === 2 ? [th[0]!, th[1]!] : null;
  };
  return { now: Number(m[1]), alarm: row("Alarm"), warn: row("Warning") };
}

const tenth = (x: number) => Math.round(x) / 10;

export function readOptical(html: string): OpticalT {
  const body = content(html);
  const ps = pairs(body);
  const rx = measure(body, "Rx Power");
  const tx = measure(body, "Tx Power");
  const temp = measure(body, "Temperature");
  // The page gives light levels in tenths of a dBm.
  const rxDbm = rx ? tenth(rx.now) : null;
  const rxWarn = rx?.warn ? { low: tenth(rx.warn[0]), high: tenth(rx.warn[1]) } : null;
  const rxAlarm = rx?.alarm ? { low: tenth(rx.alarm[0]), high: tenth(rx.alarm[1]) } : null;
  let verdict: OpticalT["verdict"] = "unknown";
  if (rxDbm !== null && rxWarn) {
    if (rxAlarm && (rxDbm <= rxAlarm.low || rxDbm >= rxAlarm.high)) verdict = "alarm";
    else if (rxDbm < rxWarn.low) verdict = "weak";
    else if (rxDbm > rxWarn.high) verdict = "strong";
    else verdict = "good";
  }
  const vendor = blank(pick(ps, "Vendor Name"));
  const part = blank(pick(ps, "Vendor PN"));
  return {
    up: onOff(pick(ps, "Optical WAN Operational Status")) ?? onOff(pick(ps, "Link State")),
    rxDbm,
    txDbm: tx ? tenth(tx.now) : null,
    rxWarn,
    rxAlarm,
    temperatureC: temp ? temp.now : null,
    module: [vendor, part].filter(Boolean).join(" ") || null,
    verdict,
  };
}

// ---------------------------------------------------------------- Firewall Status

export function readFirewall(html: string): FirewallT {
  const ps = pairs(content(html));
  return {
    packetFilter: onOff(pick(ps, "Packet Filter")),
    ipPassthrough: onOff(pick(ps, "IP Passthrough")),
    natDefaultServer: onOff(pick(ps, "NAT Default Server")),
    advanced: onOff(pick(ps, "Firewall Advanced")),
  };
}

// ---------------------------------------------------------------- Status (home.ha): Wi-Fi and the quick device table

const bandOf = (s: string | null): WifiBand | null => {
  const m = s?.match(/\b(2\.4|5|6)\s*GHz/i);
  return m ? (`${m[1]} GHz` as WifiBand) : null;
};

export function readWifi(html: string): WifiNetworkT[] {
  const body = content(html);
  const start = body.search(/<h2>\s*Wi-Fi\s*<\/h2>/i);
  if (start < 0) return [];
  const end = body.slice(start).search(/<\/table>/i);
  const ps = pairs(body.slice(start, end > 0 ? start + end : undefined));
  const out: WifiNetworkT[] = [];
  let band: WifiBand | null = null;
  let radioOn = false;
  let cur: WifiNetworkT | null = null;
  for (const p of ps) {
    const head = p.label.match(/^(2\.4|5|6)\s*GHz Frequency Status$/i);
    if (head) {
      band = `${head[1]} GHz` as WifiBand;
      radioOn = onOff(p.value) ?? false;
      continue;
    }
    if (!band) continue;
    const k = key(p.label);
    if (k === "networknamessid") {
      cur = { band, radioOn, ssid: p.value, kind: "home", on: false, security: null };
      out.push(cur);
    } else if (cur && k === "type") cur.kind = /guest/i.test(p.value) ? "guest" : "home";
    else if (cur && k === "status") cur.on = onOff(p.value) ?? false;
    else if (cur && k === "authenticationtype") cur.security = blank(p.value) && !/^disabled$/i.test(p.value) ? p.value : null;
  }
  // A guest network belongs to whichever radios carry it; the router lists it once, under 2.4 GHz.
  return out.filter((n) => n.ssid);
}

interface QuickDevice {
  ipv4: string | null;
  name: string | null;
  online: boolean;
  kind: "ethernet" | "wifi" | null;
  bars: number | null;
  band: WifiBand | null;
  guest: boolean;
  network: string | null;
}

const barsOf = (s: string) => {
  const m = s.match(/\[Wi-Fi (\d) bars?\]/i);
  return m ? Number(m[1]) : null;
};
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** "192.168.1.91 / Mac", "Mac", "192.168.1.91": the address and the name, either may be missing. */
function addressName(v: string): { ipv4: string | null; name: string | null } {
  const [a, ...rest] = v.split(/\s*\/\s*/);
  if (a && IPV4.test(a)) return { ipv4: a, name: rest.join(" / ").trim() || null };
  return { ipv4: null, name: v.trim() || null };
}

/** Home Network Devices on the Status page: every device in one line each. */
export function readQuickDevices(html: string): QuickDevice[] {
  const body = content(html);
  const t = body.match(/<table[^>]*summary="LAN Host Discovery Table"[^>]*>([\s\S]*?)<\/table>/i);
  if (!t) return [];
  const out: QuickDevice[] = [];
  for (const r of t[1]!.matchAll(/<tr>\s*<td\b[\s\S]*?<\/tr>/gi)) {
    const cells = [...r[0].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => cellText(c[1] ?? ""));
    if (cells.length < 4) continue;
    const { ipv4, name } = addressName(cells[0]!);
    const conn = cells[2] ?? "";
    const where = (cells[3] ?? "").split(/\s*,\s*/);
    out.push({
      ipv4,
      name,
      online: onOff(cells[1] ?? "") ?? false,
      kind: /ethernet/i.test(conn) ? "ethernet" : /wi-?fi/i.test(conn) ? "wifi" : null,
      bars: barsOf(conn),
      band: bandOf(where[0] ?? null),
      guest: /guest/i.test(where[1] ?? ""),
      network: where.slice(2).join(", ") || null,
    });
  }
  return out;
}

// ---------------------------------------------------------------- Device List (devices.ha)

export interface ServerIds {
  mac: string | null;
  ip: string | null;
}

const MAC = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

/**
 * Device List: one block per device, separated by rules. Merged with the Status page's table,
 * which on some firmware lists devices the Device List leaves out (this server, for one).
 */
export function readDevices(devicesHtml: string, homeHtml: string | null, offset: number | null, me: ServerIds): DeviceT[] {
  const body = content(devicesHtml);
  const table = body.match(/<table[^>]*summary="This table displays info for each LAN-side device"[^>]*>([\s\S]*?)<\/table>/i)?.[1] ?? "";
  const list: DeviceT[] = [];
  for (const chunk of table.split(/<hr\b[^>]*class="reshr"[^>]*>/i)) {
    const ps = pairs(chunk);
    const mac = blank(pick(ps, "MAC Address"))?.toLowerCase() ?? null;
    if (!mac || !MAC.test(mac)) continue;
    const an = addressName(pick(ps, "IPv4 Address / Name") ?? pick(ps, "Name") ?? "");
    const connP = ps.find((p) => key(p.label) === "connectiontype");
    const conn = connP?.value ?? "";
    const lines = conn.split("\n");
    const kind = /^ethernet/i.test(conn) ? "ethernet" : /^wi-?fi/i.test(conn) ? "wifi" : null;
    const net = lines.find((l) => /^Name:/i.test(l))?.replace(/^Name:\s*/i, "") ?? null;
    const type = lines.find((l) => /^Type:/i.test(l))?.replace(/^Type:\s*/i, "") ?? null;
    const speed = num(pick(ps, "Connection Speed"));
    const online = onOff(pick(ps, "Status")) ?? false;
    list.push({
      id: mac,
      mac,
      name: an.name,
      ipv4: an.ipv4,
      ipv6: ps.filter((p) => key(p.label) === "ipv6address" && p.value).map((p) => p.value.toLowerCase()),
      online,
      lastActivity: routerTime(pick(ps, "Last Activity"), offset),
      allocation: blank(pick(ps, "Allocation"))?.toLowerCase() ?? null,
      kind,
      port: kind === "ethernet" ? (conn.match(/LAN-?\d+/i)?.[0]?.toUpperCase() ?? null) : null,
      linkMbps: speed && speed > 0 ? speed : null,
      band: kind === "wifi" ? bandOf(conn) : null,
      network: kind === "wifi" ? net : null,
      guest: /guest/i.test(type ?? ""),
      bars: online ? barsOf(conn) : null,
      server: false,
      twins: 0,
    });
  }

  // Devices only the Status page lists: those with an address the Device List doesn't have.
  if (homeHtml) {
    const known = new Set(list.map((d) => d.ipv4).filter(Boolean));
    for (const q of readQuickDevices(homeHtml)) {
      if (!q.ipv4 || known.has(q.ipv4)) continue;
      known.add(q.ipv4);
      list.push({ id: `ip:${q.ipv4}`, mac: null, name: q.name, ipv4: q.ipv4, ipv6: [], online: q.online, lastActivity: null, allocation: null, kind: q.kind, port: null, linkMbps: null, band: q.band, network: q.network, guest: q.guest, bars: q.online ? q.bars : null, server: false, twins: 0 });
    }
  }

  // By MAC or address only: names repeat (a phone that rotates its MAC shows up once per MAC under
  // the same name), except the router's own name for a device it can't name, "unknown<mac>".
  const macHex = me.mac?.replace(/:/g, "").toLowerCase();
  for (const d of list) {
    d.server = (!!me.mac && d.mac === me.mac.toLowerCase()) || (!!me.ip && d.ipv4 === me.ip) || (!!macHex && d.name?.toLowerCase() === `unknown${macHex}`);
  }
  const count = new Map<string, number>();
  for (const d of list) if (d.name) count.set(d.name.toLowerCase(), (count.get(d.name.toLowerCase()) ?? 0) + 1);
  for (const d of list) d.twins = d.name ? (count.get(d.name.toLowerCase()) ?? 1) - 1 : 0;
  return list;
}

/** Online first, then the most recently active, then by name. */
export function sortDevices(list: DeviceT[]): DeviceT[] {
  return [...list].sort((a, b) => Number(b.online) - Number(a.online) || Number(b.server) - Number(a.server) || (b.lastActivity ?? 0) - (a.lastActivity ?? 0) || (a.name ?? "").localeCompare(b.name ?? ""));
}
