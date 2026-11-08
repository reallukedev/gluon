import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/events", () => ({ publish: vi.fn() }));

const { parseCaddyLine, redactUri } = await import("./caddy-log");

const R = "•••";

describe("redactUri", () => {
  it("redacts Subsonic credentials and keeps everything else in place", () => {
    expect(redactUri("/rest/ping.view?u=alice&p=enc:6162&t=abc&s=xyz&v=1.16&c=app")).toBe(
      `/rest/ping.view?u=alice&p=${R}&t=${R}&s=${R}&v=1.16&c=app`,
    );
  });

  it.each([
    "pass",
    "passwd",
    "password",
    "pwd",
    "token",
    "access_token",
    "refresh_token",
    "id_token",
    "api_key",
    "apikey",
    "key",
    "secret",
    "auth",
    "authorization",
    "sig",
    "signature",
    "code",
    "jwt",
    "session",
    "sessionid",
    "sid",
    "x-plex-token",
    "X-Plex-Token",
    "X-Emby-Token",
    "x-mediabrowser-token",
    "X-Amz-Signature",
    "X-Amz-Credential",
    "API_KEY",
    "Token",
  ])("redacts %s", (name) => {
    expect(redactUri(`/api/items?limit=5&${name}=hunter2&sort=asc`)).toBe(`/api/items?limit=5&${name}=${R}&sort=asc`);
  });

  it.each(["page=2", "type=x", "keys=1", "tokenizer=y", "passage=z", "codec=h264", "skey=1", "p2=x"])(
    "leaves %s alone",
    (param) => {
      expect(redactUri(`/search?${param}&q=cats`)).toBe(`/search?${param}&q=cats`);
    },
  );

  it("matches the decoded name but keeps it as written", () => {
    expect(redactUri("/a?api%5Fkey=1")).toBe(`/a?api%5Fkey=${R}`);
    expect(redactUri("/a?%74oken=abc&x=1")).toBe(`/a?%74oken=${R}&x=1`);
  });

  it("leaves parameters without = and empty separators untouched", () => {
    expect(redactUri("/a?token&x=1&&y")).toBe("/a?token&x=1&&y");
  });

  it("redacts JWTs anywhere", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk";
    expect(redactUri(`/x/${jwt}`)).toBe(`/x/${R}`);
    expect(redactUri(`/cb?state=xyz&bearer=${jwt}`)).toBe(`/cb?state=xyz&bearer=${R}`);
    expect(redactUri("/x/eyJabc.def.ghi")).toBe("/x/eyJabc.def.ghi");
  });

  it.each(["/", "/photos/2026", "/p/t/s", "/token/abc", "/search?q=caf%C3%A9"])("leaves %j unchanged", (u) => {
    expect(redactUri(u)).toBe(u);
  });

  it("survives malformed percent-encoding", () => {
    expect(() => redactUri("/a?%E0%A4%A=1&token=x")).not.toThrow();
    expect(redactUri("/a?%E0%A4%A=1&token=x")).toContain(`token=${R}`);
  });
});

describe("parseCaddyLine: JSON", () => {
  afterEach(() => vi.useRealTimers());

  const SAMPLE = {
    level: "info",
    ts: 1790383637.41,
    logger: "http.log.access.log0",
    msg: "handled request",
    request: {
      client_ip: "::ffff:203.0.113.5",
      proto: "HTTP/2.0",
      method: "GET",
      host: "Photos.Example.com:443",
      uri: "/api?token=abc&page=2",
      headers: { "user-agent": ["Mozilla/5.0"] },
    },
    duration: 0.0024,
    size: 1251,
    status: 200,
  };

  it("parses the sample access line", () => {
    expect(parseCaddyLine(JSON.stringify(SAMPLE))).toEqual({
      kind: "access",
      format: "json",
      level: "info",
      entry: {
        time: 1790383637410,
        host: "photos.example.com",
        method: "GET",
        uri: `/api?token=${R}&page=2`,
        status: 200,
        duration: 2.4,
        size: 1251,
        remoteIp: "203.0.113.5",
        userAgent: "Mozilla/5.0",
        proto: "HTTP/2.0",
        country: null,
      },
    });
  });

  it("normalises host, ip, user agent and duration", () => {
    const line = (over: Record<string, unknown>, req: Record<string, unknown> = {}) =>
      JSON.stringify({ ...SAMPLE, ...over, request: { ...SAMPLE.request, ...req } });
    const entry = (over: Record<string, unknown>, req?: Record<string, unknown>) => {
      const r = parseCaddyLine(line(over, req));
      if (r?.kind !== "access") throw new Error("not an access line");
      return r.entry;
    };
    expect(entry({}, { host: "Media.Example.com:80" }).host).toBe("media.example.com");
    expect(entry({}, { host: "a.example.com:8443" }).host).toBe("a.example.com:8443");
    expect(entry({}, { client_ip: undefined, remote_ip: "198.51.100.7" }).remoteIp).toBe("198.51.100.7");
    expect(entry({}, { client_ip: "2001:db8::42" }).remoteIp).toBe("2001:db8::42");
    expect(entry({}, { headers: { "User-Agent": ["Jellyfin/10.10", "x"] } }).userAgent).toBe("Jellyfin/10.10");
    expect(entry({}, { headers: { "USER-AGENT": ["A".repeat(1000)] } }).userAgent).toBe("A".repeat(400));
    expect(entry({}, { headers: {} }).userAgent).toBe("");
    expect(entry({ duration: 1.234567 }).duration).toBe(1234.57);
    expect(entry({ duration: "12.5ms" }).duration).toBe(12.5);
    expect(entry({ duration: "0.5s" }).duration).toBe(500);
    expect(entry({ ts: "2026-09-26T00:47:17.381Z" }).time).toBe(Date.UTC(2026, 8, 26, 0, 47, 17, 381));
    expect(entry({}, { proto: undefined }).proto).toBeNull();
    expect(entry({}, { uri: `/long?q=${"z".repeat(5000)}` }).uri).toHaveLength(2000);
  });

  it("fills missing fields with defaults", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-08T09:00:00Z"));
    const r = parseCaddyLine(JSON.stringify({ logger: "http.log.access", request: {} }));
    expect(r).toMatchObject({
      kind: "access",
      format: "json",
      level: "info",
      entry: {
        host: "",
        method: "",
        uri: "",
        status: 0,
        duration: 0,
        size: 0,
        remoteIp: "",
        userAgent: "",
        proto: null,
        country: null,
      },
    });
    if (r?.kind === "access") expect(Math.abs(r.entry.time - Date.now())).toBeLessThan(5000);
  });

  it("reports other loggers as other, with the whole object as fields", () => {
    const obj = {
      level: "warn",
      ts: 1790383637.4105,
      logger: "tls.cache.maintenance",
      msg: "certificate expires soon",
      identifier: "x.example.com",
    };
    expect(parseCaddyLine(JSON.stringify(obj))).toEqual({
      kind: "other",
      format: "json",
      time: 1790383637411,
      level: "warn",
      logger: "tls.cache.maintenance",
      msg: "certificate expires soon",
      fields: obj,
    });
  });

  it.each(["{bad json", "", "   ", "\x1b[0m  \x1b[0m", "random text"])("returns null for %j", (line) => {
    expect(parseCaddyLine(line)).toBeNull();
  });
});

describe("parseCaddyLine: console", () => {
  it("parses the sample access line, stripping colour codes", () => {
    const line =
      '2026/09/26 00:47:17.381\t\x1b[34mINFO\x1b[0m\thttp.log.access.log0\thandled request\t{"request":{"remote_ip":"192.168.1.20","method":"POST","host":"a.example.com","uri":"/"},"duration":"12.5ms","status":502,"size":0}';
    expect(parseCaddyLine(`  ${line}\r\n`)).toEqual({
      kind: "access",
      format: "console",
      level: "info",
      entry: {
        time: Date.UTC(2026, 8, 26, 0, 47, 17, 381),
        host: "a.example.com",
        method: "POST",
        uri: "/",
        status: 502,
        duration: 12.5,
        size: 0,
        remoteIp: "192.168.1.20",
        userAgent: "",
        proto: null,
        country: null,
      },
    });
  });

  it("parses other loggers and reads fractional seconds as milliseconds", () => {
    expect(
      parseCaddyLine(
        '2026/09/26 00:47:17\tERROR\ttls.obtain\tcould not get certificate\t{"identifier":"x.example.com","error":"boom"}',
      ),
    ).toEqual({
      kind: "other",
      format: "console",
      time: Date.UTC(2026, 8, 26, 0, 47, 17),
      level: "error",
      logger: "tls.obtain",
      msg: "could not get certificate",
      fields: { identifier: "x.example.com", error: "boom" },
    });
    expect(parseCaddyLine("2026/09/26 00:47:17.5\tWARN\tadmin\tstopped previous server")).toMatchObject({
      kind: "other",
      time: Date.UTC(2026, 8, 26, 0, 47, 17, 500),
      level: "warn",
      fields: {},
    });
    expect(parseCaddyLine("2026/09/26 00:47:17.381234\tINFO\tadmin\tx\t{not json")).toMatchObject({
      time: Date.UTC(2026, 8, 26, 0, 47, 17, 381),
      fields: {},
    });
  });

  it.each([
    "2026/09/26 00:47:17\tINFO\tadmin",
    "Sep 26 00:47:17\tINFO\tadmin\tmsg",
    "random text",
    "26/09/2026 00:47:17\tINFO\ta\tb",
  ])("returns null for %j", (line) => {
    expect(parseCaddyLine(line)).toBeNull();
  });
});
