import { EDITABLE_TYPES, type DnsRecordInput } from "@/lib/cloudflare-types";
import type { RecordBody } from "./api";
import { MARK } from "./plan";

/**
 * The DNS editor's rules, kept pure so they can be tested: turn what someone typed into the record
 * Cloudflare gets, or say plainly what's wrong with it.
 */

export class RecordError extends Error {
  constructor(
    message: string,
    public readonly field: "type" | "name" | "content" | "ttl" | "priority" | "comment",
  ) {
    super(message);
  }
}

const LABEL = /^(\*|_?[a-z0-9]([a-z0-9_-]{0,61}[a-z0-9])?)$/;
const HOST = /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
/** Cloudflare accepts these TTLs (1 = automatic). */
export const TTLS = [1, 60, 120, 300, 600, 900, 1800, 3600, 7200, 18000, 43200, 86400] as const;

const norm = (s: string) => s.trim().toLowerCase().replace(/\.$/, "");

/** "@", "www", "www.leech.party" or "" → the full name inside `zone`. */
export function fullName(raw: string, zone: string): string {
  const z = norm(zone);
  const n = norm(raw);
  if (!n || n === "@") return z;
  if (n === z || n.endsWith(`.${z}`)) return n;
  return `${n}.${z}`;
}

/** The name as the editor shows it: "@" for the domain itself, else the part before it. */
export function shortName(full: string, zone: string): string {
  const f = norm(full);
  const z = norm(zone);
  return f === z ? "@" : f.endsWith(`.${z}`) ? f.slice(0, -z.length - 1) : f;
}

function isV6(s: string): boolean {
  if (!/^[0-9a-f:]+$/i.test(s) || !s.includes(":")) return false;
  const halves = s.split("::");
  if (halves.length > 2) return false;
  const groups = halves.flatMap((h) => (h ? h.split(":") : []));
  if (groups.some((g) => g.length < 1 || g.length > 4)) return false;
  return halves.length === 2 ? groups.length < 8 : groups.length === 8;
}

export function toBody(input: DnsRecordInput, zone: string): RecordBody {
  if (!(EDITABLE_TYPES as readonly string[]).includes(input.type)) throw new RecordError("Pick a record type.", "type");
  const name = fullName(input.name, zone);
  const z = norm(zone);
  const labels = name === z ? [] : name.slice(0, -z.length - 1).split(".");
  if (name.length > 253 || labels.some((l) => !LABEL.test(l))) throw new RecordError("Use letters, numbers, dashes and dots, like www or mail.", "name");
  let content = input.content.trim();
  const host = (what: string) => {
    content = norm(content);
    if (!HOST.test(content)) throw new RecordError(`Enter a ${what}, like example.com.`, "content");
  };
  switch (input.type) {
    case "A":
      if (!V4.test(content)) throw new RecordError("Enter an IPv4 address, like 203.0.113.7.", "content");
      break;
    case "AAAA":
      if (!isV6(content)) throw new RecordError("Enter an IPv6 address, like 2001:db8::7.", "content");
      content = content.toLowerCase();
      break;
    case "CNAME":
      host("name to point at");
      if (content === name) throw new RecordError("A name can't point at itself.", "content");
      break;
    case "MX":
    case "NS":
      host(input.type === "MX" ? "mail server" : "name server");
      break;
    case "TXT":
      if (!content) throw new RecordError("Enter the text.", "content");
      if (content.length > 2048) throw new RecordError("Keep the text under 2,048 characters.", "content");
      break;
  }
  if (!(TTLS as readonly number[]).includes(input.ttl)) throw new RecordError("Pick how long resolvers keep it.", "ttl");
  const proxiable = input.type === "A" || input.type === "AAAA" || input.type === "CNAME";
  const proxied = proxiable && input.proxied;
  const body: RecordBody = { type: input.type, name, content, ttl: proxied ? 1 : input.ttl, proxied };
  if (input.type === "MX") {
    const p = input.priority ?? 10;
    if (!Number.isInteger(p) || p < 0 || p > 65535) throw new RecordError("Priority is a number from 0 to 65535.", "priority");
    body.priority = p;
  }
  const comment = input.comment?.trim();
  if (comment) {
    if (comment.length > 100) throw new RecordError("Keep the note under 100 characters.", "comment");
    // That note is how Gluon recognises its own records, which it may rewrite or remove.
    if (comment === MARK) throw new RecordError("That note is kept for records Gluon makes. Write something else.", "comment");
    body.comment = comment;
  }
  return body;
}
