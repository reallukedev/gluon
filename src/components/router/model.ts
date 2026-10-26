import type { DeviceT, RouterOverview } from "@/lib/router-types";

/** Words for the router page, kept apart from the markup so they read the same everywhere. */

export const OVERVIEW_URL = "/api/network/router/overview";

/** "10 Gb/s", "1 Gb/s", "100 Mb/s". */
export function mbps(n: number | null): string | null {
  if (!n) return null;
  return n >= 1000 ? `${+(n / 1000).toFixed(n % 1000 ? 1 : 0)} Gb/s` : `${n} Mb/s`;
}

/** "BGW320-500" without the maker in front. */
export const shortModel = (o: RouterOverview) => o.facts?.model ?? null;

/** Days since a moment, in plain words: "6 days", "3 hours", "a few minutes". */
export function since(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 5) return "a few minutes";
  if (m < 90) return `${m} minutes`;
  const h = Math.round(m / 60);
  if (h < 36) return h === 1 ? "an hour" : `${h} hours`;
  const d = Math.round(h / 24);
  return d === 1 ? "a day" : `${d} days`;
}

export function connectionWords(d: DeviceT): string {
  if (d.kind === "ethernet") return ["Ethernet", d.port, mbps(d.linkMbps)].filter(Boolean).join(", ");
  if (d.kind === "wifi") return [d.band ? `Wi-Fi ${d.band}` : "Wi-Fi", d.guest ? "guest" : null, d.network].filter(Boolean).join(", ");
  return "Connection unknown";
}

/** What tells a device apart from others with the same name: the end of its MAC, or its address. */
export function twinHint(d: DeviceT): string | null {
  if (!d.twins) return null;
  if (d.mac) return `ending ${d.mac.slice(-5)}`;
  return d.ipv4;
}

export type Filter = "all" | "online" | "wifi" | "wired";

export function matches(d: DeviceT, filter: Filter, q: string): boolean {
  if (filter === "online" && !d.online) return false;
  if (filter === "wifi" && d.kind !== "wifi") return false;
  if (filter === "wired" && d.kind !== "ethernet") return false;
  if (!q) return true;
  const hay = [d.name, d.ipv4, d.mac, d.network, d.port, d.band, d.server ? "this server" : null, ...d.ipv6].filter(Boolean).join(" ").toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}
