/** The home router as Gluon reads it, shared by the API, Network and the router page. No server imports. */

// ---------------------------------------------------------------- port forwarding

export interface PortNeedT {
  key: string;
  label: string;
  why: string;
  min: number;
  max: number;
  hostPort: number;
  protocol: "tcp" | "udp" | "both";
}

export interface NeedStateT {
  need: PortNeedT;
  /** unknown: Gluon can't read the router (not connected, or not a router it manages). */
  status: "forwarded" | "elsewhere" | "missing" | "unknown";
  service: string | null;
  device: string | null;
  /** Gluon made this service, so it may remove it. */
  ours: boolean;
}

/** A custom service Gluon added that no app needs any more: it can still be removed. */
export interface LeftoverT {
  service: string;
  min: number;
  max: number;
  hostPort: number;
  protocol: "tcp" | "udp" | "both";
  /** Where the router forwards it, if anywhere. */
  device: string | null;
}

export interface RouterStatus {
  gateway: string | null;
  model: string | null;
  firmware: string | null;
  /** A router Gluon knows how to manage. */
  supported: boolean;
  /** Gluon has its access code. */
  connected: boolean;
  /** The router refused the stored code: Gluon stopped using it until it's entered again. */
  codeRejected: boolean;
  /** Who entered the code and when (one code for the whole server). */
  connectedBy: { name: string | null; at: number } | null;
  server: { ip: string | null; mac: string | null; name: string };
  needs: NeedStateT[];
  leftovers: LeftoverT[];
  error: string | null;
}

// ---------------------------------------------------------------- what the router's own pages say

export interface RouterFactsT {
  manufacturer: string | null;
  model: string | null;
  serial: string | null;
  firmware: string | null;
  hardware: string | null;
  /** The router's internet-side MAC address. */
  wanMac: string | null;
  firstUse: number | null;
  /** When the router last started, from its uptime. */
  bootAt: number | null;
}

export interface BroadbandT {
  /** "Fiber", "Ethernet"… as the router names it. */
  source: string | null;
  up: boolean | null;
  ipv4: string | null;
  gateway4: string | null;
  dns: string[];
  mtu: number | null;
  /** The link to the provider's equipment, in Mb/s. */
  lineMbps: number | null;
  ipv6: { available: boolean | null; kind: string | null; address: string | null; gateway: string | null };
  /** Byte counters since the router started (or since someone cleared them). */
  rxBytes: number | null;
  txBytes: number | null;
  errors: number | null;
  /** The fiber terminal's own state, like "OPERATION (O5)". */
  pon: string | null;
}

export interface OpticalT {
  up: boolean | null;
  /** Light arriving from the provider and leaving the router, in dBm. */
  rxDbm: number | null;
  txDbm: number | null;
  /** The router's own "normal" window for the received light. */
  rxWarn: { low: number; high: number } | null;
  rxAlarm: { low: number; high: number } | null;
  temperatureC: number | null;
  module: string | null;
  /** good: inside the router's warning thresholds; weak or strong: outside them; alarm: outside its alarm thresholds. */
  verdict: "good" | "weak" | "strong" | "alarm" | "unknown";
}

export type WifiBand = "2.4 GHz" | "5 GHz" | "6 GHz";

export interface WifiNetworkT {
  band: WifiBand;
  /** The radio for this band is on. */
  radioOn: boolean;
  ssid: string;
  kind: "home" | "guest";
  on: boolean;
  /** "WPA-2", or null when the router shows none. */
  security: string | null;
}

export interface FirewallT {
  packetFilter: boolean | null;
  ipPassthrough: boolean | null;
  natDefaultServer: boolean | null;
  advanced: boolean | null;
}

export interface DeviceT {
  /** Stable within one reading: the MAC when there is one. */
  id: string;
  mac: string | null;
  name: string | null;
  ipv4: string | null;
  ipv6: string[];
  online: boolean;
  lastActivity: number | null;
  /** "dhcp", "fixed", "pending" (waiting for an address) or whatever the router says. */
  allocation: string | null;
  kind: "ethernet" | "wifi" | null;
  /** "LAN-1" for wired devices. */
  port: string | null;
  linkMbps: number | null;
  band: WifiBand | null;
  network: string | null;
  guest: boolean;
  /** Wi-Fi signal, 0 to 5 bars, while it's online. */
  bars: number | null;
  /** This server, by its MAC, address or name. */
  server: boolean;
  /** How many other devices share this name (several "Watch"es): 0 when it's unique. */
  twins: number;
}

export interface RatePointT {
  t: number;
  /** Bytes per second over the interval ending at t; null across a restart or a gap. */
  rx: number | null;
  tx: number | null;
}

export interface RouterEventT {
  at: number;
  kind: "restarted" | "broadband-down" | "broadband-up";
  /** Plain sentence. */
  text: string;
}

export type SectionKey = "facts" | "broadband" | "optical" | "wifi" | "devices" | "firewall";

export interface RouterOverview {
  gateway: string | null;
  /** bgw: an AT&T BGW gateway Gluon reads. other: a router it can't read. none: no router found. unreachable: the address didn't answer. */
  kind: "bgw" | "other" | "none" | "unreachable";
  /** For "other": what Gluon could tell about it, like its web server's name. */
  otherName: string | null;
  facts: RouterFactsT | null;
  broadband: BroadbandT | null;
  optical: OpticalT | null;
  wifi: WifiNetworkT[] | null;
  devices: DeviceT[] | null;
  firewall: FirewallT | null;
  /** When each section was last read from the router. */
  readAt: Partial<Record<SectionKey, number>>;
  /** A read is going on now. */
  refreshing: boolean;
  /** The last read failed, with why (the data above is the last good one). */
  error: string | null;
  traffic: {
    points: RatePointT[];
    /** Since the router started (or its counters were cleared). */
    rxTotal: number | null;
    txTotal: number | null;
    /** Latest rate, when the last two samples are close enough to mean "now". */
    now: { rx: number; tx: number; at: number } | null;
  };
  events: RouterEventT[];
  access: { connected: boolean; canRestart: boolean; codeRejected: boolean; connectedBy: { name: string | null; at: number } | null };
  /** An access-code action Gluon is waiting on. */
  restart: { requestedAt: number; state: "waiting" | "done" | "failed"; message: string | null } | null;
  server: { ip: string | null; mac: string | null; name: string };
}

/** The Home widget's slice: no addresses, safe for everyone in the household. */
export interface RouterGlance {
  model: string | null;
  broadband: boolean | null;
  online: number | null;
  /** Whole-home internet traffic through the router, bytes per second. */
  now: { rx: number; tx: number; at: number } | null;
  bootAt: number | null;
  readAt: number | null;
}
