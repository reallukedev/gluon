import { describe, expect, it } from "vitest";
import { fold, matchScore, prepare, rank, splitVerb } from "./search-match";

const score = (q: string, label: string, extra: { keywords?: string; hint?: string } = {}) => matchScore(prepare(q), { label, ...extra });

describe("matching", () => {
  it("ignores case, accents and punctuation", () => {
    expect(fold("Café-Bar  Ünïcode!")).toBe("cafe bar unicode");
    expect(score("cafe", "Café")).toBe(1);
    expect(score("SONARR", "sonarr")).toBe(1);
    expect(score("strasse", "Straße")).toBe(1);
  });

  it("accepts words in any order", () => {
    expect(score("shows tv", "TV Shows")).toBeGreaterThanOrEqual(0.8);
  });

  it("tolerates a typo in longer words but not in short ones", () => {
    expect(score("jelyfin", "Jellyfin")).toBeGreaterThan(0);
    expect(score("immmich", "Immich")).toBeGreaterThan(0);
    expect(score("homebrige", "Homebridge")).toBeGreaterThan(0);
    expect(score("nas", "Nzb")).toBe(0);
  });

  it("finds by initials, keywords and the hint, ranked below the name", () => {
    const initials = score("hb", "Home Bridge");
    const keyword = score("audit", "Activity", { keywords: "audit log" });
    const hint = score("sda", "2 TB hard drive", { hint: "/dev/sda" });
    expect(initials).toBeGreaterThan(0);
    expect(keyword).toBeGreaterThan(0);
    expect(hint).toBeGreaterThan(0);
    expect(keyword).toBeGreaterThan(hint);
  });

  it("ranks the exact name over a prefix, a prefix over a word inside, and those over a typo", () => {
    const exact = score("jellyfin", "Jellyfin");
    const prefix = score("jelly", "Jellyfin");
    const inside = score("fin", "Jellyfin");
    const typo = score("jellyfim", "Jellyfin");
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(inside);
    expect(inside).toBeGreaterThan(typo);
    expect(typo).toBeGreaterThan(0);
  });

  it("returns 0 when nothing matches, and for an empty query", () => {
    expect(score("plex", "Jellyfin")).toBe(0);
    expect(score("   ", "Jellyfin")).toBe(0);
  });

  it("ranks a list best first (closer names first), dropping non-matches and keeping ties in order", () => {
    const list = ["Immich Machine Learning", "Immich", "Jellyfin", "immich_postgres", "immich_redis1", "immich_redis2"];
    expect(rank(prepare("immich"), list, (label) => ({ label })).map((x) => x.item)).toEqual(["Immich", "immich_redis1", "immich_redis2", "immich_postgres", "Immich Machine Learning"]);
  });
});

describe("splitVerb", () => {
  const verbs = { restart: "restart", stop: "stop", open: "open" };
  it("pulls a verb (or the start of one) out of the query", () => {
    const a = splitVerb(prepare("restart jellyfin"), verbs);
    expect(a.verb).toBe("restart");
    expect(a.rest.folded).toBe("jellyfin");
    expect(splitVerb(prepare("rest jelly"), verbs).verb).toBe("restart");
  });
  it("drops filler words and later verb words around the command", () => {
    const a = splitVerb(prepare("show the logs for jellyfin"), { logs: "logs" });
    expect([a.verb, a.rest.folded]).toEqual(["logs", "jellyfin"]);
    const b = splitVerb(prepare("why won't jellyfin"), { why: "check", won: "check", t: "check" });
    expect([b.verb, b.rest.folded]).toEqual(["check", "jellyfin"]);
  });

  it("leaves a query that is only a verb alone, so the verb is searched for", () => {
    const a = splitVerb(prepare("restart"), verbs);
    expect(a.verb).toBeNull();
    expect(a.rest.folded).toBe("restart");
  });
});
