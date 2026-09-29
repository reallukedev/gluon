/**
 * Shapes for the Home widgets that read from this machine rather than a connected app: Internet, Running out of
 * space, Power, Coming up and Guest Wi-Fi. Isomorphic (no server imports).
 * Timestamps are epoch milliseconds, sizes bytes, power watts, energy watt-hours.
 */

// ------------------------------------------------------------------ Internet

/** One character per minute in the 24-hour strip. */
export type InternetCell =
  /** answered at a normal speed */
  | "o"
  /** answered, but slowly (well above the usual latency) */
  | "s"
  /** some probes in the minute got no answer, but the internet never went away */
  | "l"
  /** the internet didn't answer at all, the router did */
  | "d"
  /** the router itself didn't answer: the home network was down */
  | "r"
  /** Gluon wasn't measuring (restarting, or before it started) */
  | "-";

export interface InternetOutage {
  start: number;
  /** null while it's still going on */
  end: number | null;
  /** "internet": the router answered but nothing beyond it did. "router": the router didn't answer either. */
  cause: "internet" | "router";
}

/** GET /api/widgets/internet — everyone. */
export interface InternetData {
  /** What the last round found. `waiting` before the first round has finished. */
  state: "ok" | "slow" | "down" | "router" | "waiting";
  latencyMs: number | null;
  checkedAt: number | null;
  /** The usual latency: median over the last 24 hours. */
  baselineMs: number | null;
  /** Minute strip over the last 24 hours, oldest first; `start` is the first minute. */
  strip: { start: number; step: number; cells: string; ms: (number | null)[] };
  /** Outages over the last 48 hours, oldest first (enough to say "today" in any time zone). */
  outages: InternetOutage[];
  /** Share of probes that got no answer over the last 24 hours (0…1), counting only measured minutes. */
  loss24h: number | null;
  /** What Gluon checks: two public addresses and, when it can find one, the router. */
  targets: string[];
  router: string | null;
  /** When the first stored minute was recorded (how much history there is). */
  since: number | null;
  /** How often a round runs while things are fine. */
  intervalMs: number;
}

// ------------------------------------------------------------------ Running out of space

export interface SpaceDisk {
  mount: string;
  size: number;
  used: number;
  avail: number;
  pct: number;
  /** Bytes per day over the last week (negative = shrinking); null without enough history. */
  perDay: number | null;
  /** Days until full at `perDay`; null unless it's filling. */
  daysToFull: number | null;
  trend: "filling" | "steady" | "shrinking" | "learning";
  /** Hours of history the trend is based on. */
  historyHours: number;
}

/** GET /api/widgets/space — admins. */
export interface SpaceData {
  disks: SpaceDisk[];
  checkedAt: number;
}

// ------------------------------------------------------------------ Power

/** GET /api/widgets/power?dayStart=<ms> — admins. */
export type PowerData =
  | { available: false; reason: string }
  | {
      available: true;
      /** "package-0", "package-1"… the processor packages that are summed. */
      domains: string[];
      /** Watts right now (last few seconds), null until two readings exist. */
      watts: number | null;
      at: number | null;
      /** Last hour, one point per minute: [ts, watts]. */
      hour: [number, number][];
      /** Last 24 hours, one point per 10 minutes: [ts, watts]. */
      day: [number, number][];
      /** Energy since `dayStart`, measured minutes only. */
      todayWh: number;
      /** Fraction of the time since `dayStart` that was measured (0…1). */
      todayCoverage: number;
      /** Average draw over the last 7 days (or as much as there is). */
      avgWatts: number | null;
      /** Hours of history behind `avgWatts`. */
      avgHours: number;
    };

// ------------------------------------------------------------------ Coming up

export interface ScheduleItem {
  id: string;
  /** "Tidy up log files" */
  name: string;
  /** The systemd unit, for admins who want to know. */
  unit: string | null;
  next: number | null;
  last: number | null;
  /** How the previous run went, when systemd knows. */
  lastResult: "success" | "failed" | null;
  source: "system" | "gluon" | "certificate";
  /** The time is an estimate (certificate renewals, Gluon's update window). */
  approx: boolean;
  /** Extra words, e.g. the certificate's host name. */
  detail: string | null;
}

/** GET /api/widgets/schedule — admins. */
export type ScheduleData = { available: false; reason: string } | { available: true; items: ScheduleItem[]; checkedAt: number };

// ------------------------------------------------------------------ Guest Wi-Fi

export type WifiSecurity = "WPA" | "WEP" | "nopass";

/** GET /api/widgets/guest-wifi — everyone (the point is to show guests). */
export type GuestWifiData =
  | { configured: false }
  | {
      configured: true;
      ssid: string;
      security: WifiSecurity;
      password: string | null;
      hidden: boolean;
      /** The QR code as a square bit matrix, row by row ("1" = dark module). */
      qr: { size: number; bits: string };
      updatedAt: number;
    };

/** PUT /api/widgets/guest-wifi — admins. Leave `password` out to keep the stored one. */
export interface GuestWifiInput {
  ssid: string;
  security: WifiSecurity;
  password?: string;
  hidden: boolean;
}

// ------------------------------------------------------------------ availability (catalog)

/** Home widgets that depend on this machine; the catalog marks them unavailable with the reason. */
export interface LocalWidgetAvailability {
  /** Home widget type, e.g. "server.power". */
  type: string;
  available: boolean;
  reason: string | null;
}
