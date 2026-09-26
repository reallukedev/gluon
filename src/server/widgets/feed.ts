import "server-only";
import crypto from "node:crypto";
import { child, children, htmlToText, parseXml, textOf, type XmlNode } from "./xml";
import type { FeedData, FeedItem } from "@/lib/widgets-types";

/** RSS 2.0 / 0.9x, RSS 1.0 (RDF), Atom 1.0 and JSON Feed → FeedData. Throws if it isn't a feed. */
export function parseFeed(text: string, feedUrl: string, limit: number): FeedData {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) return parseJsonFeed(trimmed, feedUrl, limit);
  const doc = parseXml(text);
  const root = doc.children.find((c) => c.name !== "#text");
  if (!root) throw new Error("empty");
  const local = root.name.split(":").pop()!.toLowerCase();
  if (local === "rss") return rss(child(root, "channel") ?? root, children(child(root, "channel") ?? root, "item"), feedUrl, limit);
  if (local === "rdf") return rss(child(root, "channel", "rss:channel"), children(root, "item", "rss:item"), feedUrl, limit);
  if (local === "feed") return atom(root, feedUrl, limit);
  if (local === "html") throw new Error("html");
  throw new Error("unknown");
}

function abs(href: string | null | undefined, base: string): string | null {
  if (!href) return null;
  try {
    const u = new URL(href.trim(), base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function date(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s.trim());
  if (Number.isFinite(t)) return t;
  // RFC 822 with a zone abbreviation Date.parse doesn't know: drop it and assume UTC.
  const t2 = Date.parse(s.trim().replace(/\s+[A-Z]{2,5}$/, " +0000"));
  return Number.isFinite(t2) ? t2 : null;
}

const clean = (s: string) => htmlToText(s, 300);

function idFor(...parts: (string | null | undefined)[]): string {
  return crypto.createHash("sha1").update(parts.filter(Boolean).join("|")).digest("base64url").slice(0, 16);
}

function imageFrom(item: XmlNode, base: string, html: string): string | null {
  const media = [...children(item, "media:thumbnail"), ...children(item, "media:content").filter((m) => /image/.test(m.attrs.type ?? m.attrs.medium ?? ""))];
  for (const group of children(item, "media:group")) media.push(...children(group, "media:thumbnail", "media:content"));
  for (const m of media) {
    const u = abs(m.attrs.url, base);
    if (u) return u;
  }
  const enc = children(item, "enclosure").find((e) => /^image\//.test(e.attrs.type ?? ""));
  if (enc) return abs(enc.attrs.url, base);
  const it = child(item, "itunes:image");
  if (it?.attrs.href) return abs(it.attrs.href, base);
  const img = /<img[^>]+src=["']([^"']+)["']/i.exec(html)?.[1];
  return abs(img ?? null, base);
}

function finish(title: string | null, siteUrl: string | null, items: FeedItem[], limit: number): FeedData {
  const dated = items.every((i) => i.publishedAt !== null);
  if (dated) items.sort((a, b) => b.publishedAt! - a.publishedAt!);
  return { title, siteUrl, items: items.slice(0, limit) };
}

function rss(channel: XmlNode | undefined, items: XmlNode[], feedUrl: string, limit: number): FeedData {
  const site = abs(textOf(child(channel, "link")), feedUrl);
  const base = site ?? feedUrl;
  const out: FeedItem[] = items.slice(0, 200).map((it) => {
    const guid = child(it, "guid");
    const link = abs(textOf(child(it, "link")), base) ?? (guid && guid.attrs.isPermaLink !== "false" ? abs(textOf(guid), base) : null);
    const html = textOf(child(it, "content:encoded")) || textOf(child(it, "description")) || textOf(child(it, "summary"));
    const title = clean(textOf(child(it, "title"))) || clean(html).slice(0, 80) || "Untitled";
    return {
      id: idFor(textOf(guid), link, title),
      title,
      url: link,
      publishedAt: date(textOf(child(it, "pubDate", "dc:date", "published", "updated"))),
      summary: clean(html) || null,
      author: clean(textOf(child(it, "dc:creator", "author", "itunes:author"))) || null,
      image: imageFrom(it, base, html),
    };
  });
  return finish(clean(textOf(child(channel, "title"))) || null, site, out, limit);
}

function atomLink(n: XmlNode, base: string): string | null {
  const links = children(n, "link");
  const alt = links.find((l) => !l.attrs.rel || l.attrs.rel === "alternate") ?? links[0];
  return abs(alt?.attrs.href, base);
}

function atom(feed: XmlNode, feedUrl: string, limit: number): FeedData {
  const base = feed.attrs["xml:base"] ? (abs(feed.attrs["xml:base"], feedUrl) ?? feedUrl) : feedUrl;
  const site = atomLink(feed, base);
  const out: FeedItem[] = children(feed, "entry")
    .slice(0, 200)
    .map((e) => {
      const link = atomLink(e, base);
      const html = textOf(child(e, "summary")) || textOf(child(e, "content"));
      const title = clean(textOf(child(e, "title"))) || "Untitled";
      return {
        id: idFor(textOf(child(e, "id")), link, title),
        title,
        url: link,
        publishedAt: date(textOf(child(e, "published")) || textOf(child(e, "updated"))),
        summary: clean(html) || null,
        author: clean(textOf(child(child(e, "author"), "name"))) || null,
        image: imageFrom(e, base, html),
      };
    });
  return finish(clean(textOf(child(feed, "title"))) || null, site, out, limit);
}

function parseJsonFeed(text: string, feedUrl: string, limit: number): FeedData {
  const f = JSON.parse(text) as Record<string, unknown>;
  if (typeof f.version !== "string" || !f.version.includes("jsonfeed.org")) throw new Error("not a json feed");
  const site = abs(typeof f.home_page_url === "string" ? f.home_page_url : null, feedUrl);
  const items = (Array.isArray(f.items) ? f.items : []).slice(0, 200).map((raw) => {
    const it = raw as Record<string, unknown>;
    const s = (k: string) => (typeof it[k] === "string" ? (it[k] as string) : "");
    const authors = Array.isArray(it.authors) ? (it.authors as { name?: string }[]) : it.author ? [it.author as { name?: string }] : [];
    const url = abs(s("url") || s("external_url"), feedUrl);
    const title = clean(s("title")) || clean(s("content_text") || s("content_html")).slice(0, 80) || "Untitled";
    return {
      id: idFor(s("id"), url, title),
      title,
      url,
      publishedAt: date(s("date_published") || s("date_modified")),
      summary: clean(s("summary") || s("content_text") || s("content_html")) || null,
      author: authors[0]?.name ? clean(authors[0].name) : null,
      image: abs(s("image") || s("banner_image"), feedUrl),
    } satisfies FeedItem;
  });
  return finish(typeof f.title === "string" ? clean(f.title) : null, site, items, limit);
}
