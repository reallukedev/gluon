/** Settings → Integrations → Cloudflare, as the browser sees it. The API token never leaves the server. */

export type DnsType = "A" | "AAAA" | "CNAME";

export interface DnsRecordT {
  type: DnsType;
  content: string;
  proxied: boolean;
}

/** One name Gluon keeps in Cloudflare, and how it stands after the last sync. */
export interface ManagedName {
  name: string;
  /** What Gluon wants there. Empty: Gluon is removing records it made. */
  want: DnsRecordT[];
  /** What Cloudflare had (A, AAAA and CNAME only). */
  have: DnsRecordT[];
  /**
   * ok: Cloudflare already has it. changed: the last sync fixed it. conflict: records Gluon didn't
   * make are in the way, and Gluon leaves them until told to take the name over. error: Cloudflare
   * refused the change.
   */
  state: "ok" | "changed" | "conflict" | "error";
  message: string | null;
  /** Why the name is here, in a few words ("Base domain", "Photos"). */
  why: string;
  /** The Cloudflare domain it lives in. */
  zone: string;
}

export interface CloudflareZoneT {
  id: string;
  name: string;
  accountId: string;
  accountName: string;
}

export interface TokenCheck {
  /** The token works and can list zones. */
  ok: boolean;
  message: string | null;
  zones: CloudflareZoneT[];
  /** The zone Gluon would pick: the one holding the base domain. */
  suggested: string | null;
  /** Edit rights, tried for real (a TXT record made and removed). null: not tried (no zone yet). */
  dnsEdit: boolean | null;
}

export interface CloudflareStatus {
  connected: boolean;
  /** Public addresses (routes.json) exist, so there's a base domain to manage. */
  network: boolean;
  baseDomain: string | null;
  zone: CloudflareZoneT | null;
  /** Every domain the token can see, the base domain's first. */
  zones: CloudflareZoneT[];
  /** Last four of the token. */
  tokenHint: string | null;
  connectedAt: number | null;
  ipv6: boolean;
  /** Web addresses go through Cloudflare's proxy (orange cloud), unless marked Direct. */
  proxied: boolean;
  sync: {
    at: number | null;
    running: boolean;
    ok: boolean | null;
    /** The address A records point at. */
    ipv4: string | null;
    ipv6: string | null;
    names: ManagedName[];
    /** Problems that aren't about one name (no internet address, token revoked). */
    problems: string[];
  };
  /** The older cloudflare-ddns updater is still running next to Gluon. */
  ddnsContainer: string | null;
}

/**
 * Cloudflare's free edge certificate covers the zone itself and one level under it
 * (example.com, *.example.com). A proxied name deeper than that gets a TLS error at the edge.
 */
export function edgeCovered(host: string, zone: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const z = zone.toLowerCase().replace(/\.$/, "");
  return h === z || (h.endsWith(`.${z}`) && !h.slice(0, -z.length - 1).includes("."));
}

/** Record types Gluon edits itself; anything else is shown and edited in Cloudflare. */
export const EDITABLE_TYPES = ["A", "AAAA", "CNAME", "TXT", "MX", "NS"] as const;
export type EditableType = (typeof EDITABLE_TYPES)[number];

/** One record in a domain, as the DNS editor shows it. */
export interface DnsRecordFull {
  id: string;
  type: string;
  /** Full name, like media.leech.party. */
  name: string;
  content: string;
  proxied: boolean;
  /** Cloudflare can proxy this record (A, AAAA and CNAME). */
  proxiable: boolean;
  /** Seconds; 1 means automatic. */
  ttl: number;
  priority: number | null;
  comment: string | null;
  /** Gluon keeps this record for a public address and rewrites it as needed. */
  managed: boolean;
}

export interface DnsZoneView {
  zone: CloudflareZoneT;
  records: DnsRecordFull[];
  /** Cloudflare's dashboard page for the domain's DNS, for record types Gluon doesn't edit. */
  dashboard: string;
}

export interface DnsRecordInput {
  type: EditableType;
  /** Relative to the domain ("@" for the domain itself, "www") or a full name inside it. */
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
  priority?: number | null;
  comment?: string | null;
}
