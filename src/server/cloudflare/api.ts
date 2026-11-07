import "server-only";
import { AppError } from "../errors";
import type { CloudflareZoneT, DnsRecordT } from "@/lib/cloudflare-types";
import type { ExistingRecord } from "./plan";

/** A small client for the parts of Cloudflare's API Gluon uses: zones, DNS records and SSL settings. */

const API = "https://api.cloudflare.com/client/v4";

interface Envelope<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
  result_info?: { page: number; total_pages: number };
}

export class CloudflareError extends AppError {
  constructor(
    message: string,
    /** Cloudflare's HTTP status (0: never reached it). */
    public readonly cfStatus: number,
    public readonly codes: number[] = [],
  ) {
    super("cloudflare", message, cfStatus === 401 || cfStatus === 403 ? 400 : 424);
  }
}

/** Cloudflare's own wording is often an internal code; say what it means for the person. */
function explain(status: number, errors: { code: number; message: string }[]): string {
  const codes = errors.map((e) => e.code);
  if (status === 401 || codes.includes(1000) || codes.includes(6003) || codes.includes(6111)) return "Cloudflare didn't accept the token. Check that it was copied whole and hasn't been deleted.";
  if (status === 403 || codes.includes(9109) || codes.includes(10000)) return "The token is missing a permission this needs.";
  if (status === 429) return "Cloudflare asked Gluon to slow down. Try again in a minute.";
  if (codes.includes(81053) || codes.includes(81057)) return "A record with that name already exists in Cloudflare.";
  const first = errors[0]?.message;
  return first ? `Cloudflare said: ${first}` : `Cloudflare answered ${status}.`;
}

export type Fetch = typeof fetch;

export class Cloudflare {
  constructor(
    private readonly token: string,
    private readonly fetcher: Fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<Envelope<T>> {
    let res: Response;
    try {
      res = await this.fetcher(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      const why = (e as Error).name === "TimeoutError" ? "it took too long to answer" : "the connection failed";
      throw new CloudflareError(`Couldn't reach Cloudflare: ${why}.`, 0);
    }
    let data: Envelope<T> | null = null;
    try {
      data = (await res.json()) as Envelope<T>;
    } catch {
      /* not JSON */
    }
    if (!res.ok || !data?.success) throw new CloudflareError(explain(res.status, data?.errors ?? []), res.status, (data?.errors ?? []).map((e) => e.code));
    return data;
  }

  private async pages<T>(path: string, per = 100): Promise<T[]> {
    const out: T[] = [];
    const join = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= 50; page++) {
      const r = await this.call<T[]>("GET", `${path}${join}per_page=${per}&page=${page}`);
      out.push(...r.result);
      if (!r.result_info || page >= r.result_info.total_pages) break;
    }
    return out;
  }

  async zones(): Promise<CloudflareZoneT[]> {
    const zones = await this.pages<{ id: string; name: string; account: { id: string; name: string } }>("/zones?status=active", 50);
    return zones.map((z) => ({ id: z.id, name: z.name, accountId: z.account.id, accountName: z.account.name }));
  }

  async records(zoneId: string): Promise<ExistingRecord[]> {
    const raw = await this.pages<{ id: string; name: string; type: string; content: string; proxied?: boolean; comment?: string | null }>(`/zones/${zoneId}/dns_records`, 500);
    return raw.map((r) => ({ id: r.id, name: r.name, type: r.type, content: r.content, proxied: !!r.proxied, comment: r.comment ?? null }));
  }

  async createRecord(zoneId: string, name: string, r: DnsRecordT, comment: string): Promise<void> {
    await this.call("POST", `/zones/${zoneId}/dns_records`, { type: r.type, name, content: r.content, proxied: r.proxied, ttl: 1, comment });
  }

  async updateRecord(zoneId: string, id: string, name: string, r: DnsRecordT, comment: string): Promise<void> {
    await this.call("PUT", `/zones/${zoneId}/dns_records/${id}`, { type: r.type, name, content: r.content, proxied: r.proxied, ttl: 1, comment });
  }

  async deleteRecord(zoneId: string, id: string): Promise<void> {
    await this.call("DELETE", `/zones/${zoneId}/dns_records/${id}`);
  }

  /** Edit rights, tried for real: a TXT record made and removed again. */
  async canEditDns(zoneId: string, zone: string): Promise<boolean> {
    const name = `_gluon-check.${zone}`;
    try {
      // One left behind by an interrupted check would make the create fail as a duplicate.
      const left = await this.call<{ id: string }[]>("GET", `/zones/${zoneId}/dns_records?type=TXT&name=${encodeURIComponent(name)}`).catch(() => null);
      for (const r of left?.result ?? []) await this.deleteRecord(zoneId, r.id).catch(() => undefined);
      const r = await this.call<{ id: string }>("POST", `/zones/${zoneId}/dns_records`, { type: "TXT", name, content: "\"gluon\"", ttl: 60, comment: "Gluon checking its token; removed right away" });
      await this.deleteRecord(zoneId, r.result.id).catch(() => undefined);
      return true;
    } catch (e) {
      if (e instanceof CloudflareError && (e.cfStatus === 403 || e.cfStatus === 401)) return false;
      throw e;
    }
  }

  /** The zone's SSL mode (off, flexible, full, strict), or null when the token can't read it. */
  async sslMode(zoneId: string): Promise<string | null> {
    try {
      return (await this.call<{ value: string }>("GET", `/zones/${zoneId}/settings/ssl`)).result.value;
    } catch {
      return null;
    }
  }
}
