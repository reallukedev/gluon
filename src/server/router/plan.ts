import type { Protocol, RouterForward, RouterService } from "./bgw-pages";

/**
 * Which ports Gluon's apps need from the internet, and how they stand on the router: forwarded to
 * this server, forwarded to another device, or not at all. Pure, so it's tested without a router.
 */

/**
 * The longest custom service name Gluon gives the router. No public source states the BGW's limit,
 * so this is a cautious 15; when the router's own form sets a maxlength, the smaller one wins.
 */
export const SERVICE_NAME_MAX = 15;

export interface PortNeed {
  key: string;
  /** Plain name, also the custom service name Gluon gives the router (cut to SERVICE_NAME_MAX). */
  label: string;
  /** What breaks without it. */
  why: string;
  min: number;
  max: number;
  /** Where the range lands on this server. */
  hostPort: number;
  protocol: Protocol;
}

export type NeedStatus = "forwarded" | "elsewhere" | "missing";

export interface NeedState {
  need: PortNeed;
  status: NeedStatus;
  /** The router's service that covers it, when one does. */
  service: string | null;
  /** For "elsewhere": the device it goes to. */
  device: string | null;
}

/**
 * Services the gateway has built in (shown in forwards by name, not in the custom list). Firmware
 * differs on their names: a BGW320 on 6.35 lists "HTTP" and "HTTPS" under NAT/Gaming.
 */
const BUILTIN_NAMES: [string[], Omit<RouterService, "name" | "remove">][] = [
  [["HTTP Server", "HTTP"], { min: 80, max: 80, hostPort: 80, protocol: "tcp" }],
  [["HTTPS Server", "HTTPS"], { min: 443, max: 443, hostPort: 443, protocol: "tcp" }],
];
const BUILTIN: RouterService[] = BUILTIN_NAMES.flatMap(([names, s]) => names.map((name) => ({ ...s, name, remove: null })));

/** Every name the router may give this service: a built-in's other names too. */
export const serviceNames = (name: string): string[] => BUILTIN_NAMES.find(([names]) => names.includes(name))?.[0] ?? [name];

/** A service carries a need when it maps the same ports to the same place over the needed protocol. */
export function covers(s: Pick<RouterService, "min" | "max" | "hostPort" | "protocol">, n: PortNeed): boolean {
  return s.min === n.min && s.max === n.max && s.hostPort === n.hostPort && (s.protocol === "both" || s.protocol === n.protocol);
}

/** Does the router's device label mean this server (hostname, LAN address or MAC)? */
export function isServer(device: string, server: { names: string[] }): boolean {
  const d = device.toLowerCase().trim();
  return server.names.some((raw) => {
    const n = raw.toLowerCase();
    if (!n) return false;
    // A device the router has no name for shows as "unknown" and its MAC without colons.
    if (/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(n) && d === `unknown${n.replace(/:/g, "")}`) return true;
    return d === n || d.split(/[\s/,()]+/).includes(n);
  });
}

/**
 * What each forward of a service that isn't a custom one carries: its ports from the table
 * (built-ins map each port to the same one on the device), else a built-in Gluon knows by name.
 */
function forwardedBuiltins(services: RouterService[], forwards: RouterForward[]): RouterService[] {
  return forwards
    .filter((f) => !services.some((s) => s.name === f.service))
    .flatMap((f) => (f.ports.length ? f.ports.map((p) => ({ ...p, name: f.service, hostPort: p.min, remove: null })) : BUILTIN.filter((b) => b.name === f.service)));
}

export function assess(needs: PortNeed[], services: RouterService[], forwards: RouterForward[], server: { names: string[] }): NeedState[] {
  const all = [...services, ...forwardedBuiltins(services, forwards), ...BUILTIN.filter((b) => !services.some((s) => s.name === b.name))];
  return needs.map((need) => {
    const carriers = all.filter((s) => covers(s, need));
    const fwd = forwards.filter((f) => carriers.some((c) => c.name === f.service));
    const here = fwd.find((f) => isServer(f.device, server));
    if (here) return { need, status: "forwarded", service: here.service, device: here.device };
    const other = fwd[0];
    if (other) return { need, status: "elsewhere", service: other.service, device: other.device };
    // Prefer a service the router already has (the person's own, then a built-in) over adding one.
    const reuse = carriers.find((c) => services.includes(c)) ?? carriers[0] ?? null;
    return { need, status: "missing", service: reuse?.name ?? null, device: null };
  });
}

export interface Step {
  kind: "add-service" | "add-forward";
  need: PortNeed;
  service: string;
}

/**
 * What to do for the needs that are missing: add a custom service when none carries the ports
 * (named after the need, made unique), then forward it to this server. Needs going to another
 * device are left alone: moving them is the person's call.
 */
/** A name of at most `max` characters, with " 2", " 3"… cut in when it's taken. */
export function serviceName(label: string, taken: Set<string>, max = SERVICE_NAME_MAX): string {
  const base = label.trim().replace(/\s+/g, " ");
  for (let i = 1; ; i++) {
    const tail = i === 1 ? "" : ` ${i}`;
    const name = base.slice(0, Math.max(1, max - tail.length)).trimEnd() + tail;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

export function planFixes(states: NeedState[], existingNames: string[], max = SERVICE_NAME_MAX): Step[] {
  const taken = new Set(existingNames.map((n) => n.toLowerCase()));
  const steps: Step[] = [];
  for (const st of states) {
    if (st.status !== "missing") continue;
    let name = st.service;
    if (!name) {
      name = serviceName(st.need.label, taken, max);
      taken.add(name.toLowerCase());
      steps.push({ kind: "add-service", need: st.need, service: name });
    }
    steps.push({ kind: "add-forward", need: st.need, service: name });
  }
  return steps;
}

/** Services Gluon made that no need uses any more, with where the router sends them. */
export function leftovers(created: string[], states: NeedState[], services: RouterService[], forwards: RouterForward[]) {
  const used = new Set(states.map((s) => s.service).filter(Boolean));
  return services
    .filter((s) => created.includes(s.name) && !used.has(s.name))
    .map((s) => ({ service: s.name, min: s.min, max: s.max, hostPort: s.hostPort, protocol: s.protocol, device: forwards.find((f) => f.service === s.name)?.device ?? null }));
}

const overlap = (a: { min: number; max: number; protocol: Protocol }, b: { min: number; max: number; protocol: Protocol }) =>
  a.min <= b.max && b.min <= a.max && (a.protocol === "both" || b.protocol === "both" || a.protocol === b.protocol);
const portsText = (x: { min: number; max: number; protocol: Protocol }) => `${x.protocol === "both" ? "TCP/UDP" : x.protocol.toUpperCase()} ${x.min === x.max ? x.min : `${x.min}-${x.max}`}`;

/**
 * Before forwarding what's missing: would any of it collide with what's already there? A public
 * port can only go one place, so Gluon stops (and says why) rather than add a service or forward
 * whose ports overlap another need of its own, or a service on the router that isn't the same
 * mapping. Only a service that carries exactly the same ports is reused.
 */
export function conflicts(fixing: NeedState[], allNeeds: PortNeed[], services: RouterService[], forwards: RouterForward[], server: { names: string[] }): string[] {
  const out: string[] = [];
  const builtinsInUse = forwardedBuiltins(services, forwards);
  for (const st of fixing) {
    if (st.status !== "missing") continue;
    const n = st.need;
    for (const o of allNeeds) {
      if (o.key !== n.key && overlap(o, n)) out.push(`${n.label} (${portsText(n)}) and ${o.label} (${portsText(o)}) want the same public port. Change one of them first.`);
    }
    for (const sv of [...services, ...builtinsInUse]) {
      if (!overlap(sv, n) || covers(sv, n)) continue;
      const fwd = forwards.find((f) => f.service === sv.name);
      if (fwd && !isServer(fwd.device, server)) out.push(`Public port ${portsText(sv)} already goes to ${fwd.device} through "${sv.name}" on your router, so Gluon didn't forward ${n.label} (${portsText(n)}).`);
      else out.push(`Your router's "${sv.name}" service (${portsText(sv)}) overlaps ${n.label} (${portsText(n)}) without matching it. Change or remove that service on the router first.`);
    }
  }
  return [...new Set(out)];
}
