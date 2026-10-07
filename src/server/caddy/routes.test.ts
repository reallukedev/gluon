import { describe, expect, test } from "vitest";
import { cleanConfig, publicPorts, renderCaddyfile, routeUrl, type RoutesConfig } from "./routes";

const base: RoutesConfig = {
  base_domain: "example.test",
  fallback: { name: "Home", backend: { host: "host.docker.internal", port: 80, tls: false } },
  routes: [],
};

function chat(xmpp: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { id: "chat", type: "subdomain", name: "Chat", enabled: true, host: "chat.example.test", backend: { host: "host.docker.internal", port: 5222, tls: false }, xmpp, ...extra };
}

/** The site block Caddy gets for one host. */
function block(caddyfile: string, host: string): string {
  const start = caddyfile.indexOf(`\n${host} {\n`);
  expect(start).toBeGreaterThan(-1);
  return caddyfile.slice(start, caddyfile.indexOf("\n}\n", start) + 2);
}

describe("chat server addresses", () => {
  test("never proxy web visitors to the client port, which doesn't speak HTTP", () => {
    const cfg = cleanConfig({ routes: [chat({ s2s_port: 5269, http_port: null, cert_sync: null })] }, base);
    const site = block(renderCaddyfile(cfg), "chat.example.test");
    expect(site).not.toMatch(/reverse_proxy[^\n]*:5222/);
    expect(site).toContain('respond "chat.example.test is a chat server. Sign in with any XMPP app as you@chat.example.test." 200');
    expect(site).not.toContain("host-meta");
  });

  test("with a web port, advertise BOSH and WebSocket and proxy the rest there", () => {
    const cfg = cleanConfig({ routes: [chat({ s2s_port: 5269, http_port: 5280, cert_sync: null })] }, base);
    const site = block(renderCaddyfile(cfg), "chat.example.test");
    expect(site).toContain("handle /.well-known/host-meta {");
    expect(site).toContain("href='https://chat.example.test/http-bind'");
    expect(site).toContain('"href":"wss://chat.example.test/xmpp-websocket"');
    expect(site).toContain("reverse_proxy host.docker.internal:5280");
    expect(site).not.toMatch(/reverse_proxy[^\n]*:5222/);
  });

  test("validation keeps what a chat server needs and drops path limits", () => {
    const cfg = cleanConfig({ routes: [chat({ s2s_port: "", http_port: "5280", cert_sync: { container: "prosody_1" } }, { only_paths: ["/x/*"], extra_paths: [{ paths: ["/a"], backend: { port: 1 } }] })] }, base);
    const r = cfg.routes[0]!;
    expect(r.type === "subdomain" && r).toMatchObject({ xmpp: { s2s_port: null, http_port: 5280, cert_sync: { container: "prosody_1", dir: "/etc/prosody/certs" } } });
    expect(r).not.toHaveProperty("only_paths");
    expect(r).not.toHaveProperty("extra_paths");
  });

  test.each([
    ["the web port is the client port", { s2s_port: 5269, http_port: 5222, cert_sync: null }, "http_port"],
    ["the federation port is the client port", { s2s_port: 5222, http_port: null, cert_sync: null }, "s2s_port"],
    ["a port is out of range", { s2s_port: 70000, http_port: null, cert_sync: null }, "s2s_port"],
    ["the container name could escape the argument", { s2s_port: null, http_port: null, cert_sync: { container: "-rf /" } }, "cert_container"],
    ["the certificate folder walks out of its tree", { s2s_port: null, http_port: null, cert_sync: { container: "prosody", dir: "/etc/prosody/../../root" } }, "cert_dir"],
  ])("rejects a chat address when %s", (_, xmpp, field) => {
    expect(() => cleanConfig({ routes: [chat(xmpp)] }, base)).toThrow(expect.objectContaining({ details: expect.objectContaining({ field }) }));
  });
});

describe("a domain that redirects", () => {
  const route = (extra: Record<string, unknown> = {}) => ({ id: "old", type: "subdomain", name: "Old Gluon", enabled: true, host: "gluon.example.test", backend: { host: "host.docker.internal", port: 8130, tls: false }, redirect_to: "https://example.test/", ...extra });

  test("sends every path to the new address and never proxies to its old app", () => {
    const cfg = cleanConfig({ routes: [route()] }, base);
    expect(cfg.routes[0]).toMatchObject({ redirect_to: "https://example.test" });
    const site = block(renderCaddyfile(cfg), "gluon.example.test");
    expect(site).toContain("redir https://example.test{uri} 302");
    expect(site).not.toContain("reverse_proxy");
    // Its old port isn't offered as an app tile link any more.
    expect(renderCaddyfile(cfg)).not.toContain('[8130, "https://gluon.example.test"]');
  });

  test.each([
    ["the target isn't an address", { redirect_to: "example.test" }],
    ["it points at itself", { redirect_to: "https://gluon.example.test/x" }],
  ])("is refused when %s", (_, extra) => {
    expect(() => cleanConfig({ routes: [route(extra)] }, base)).toThrow(expect.objectContaining({ details: expect.objectContaining({ field: "redirect_to" }) }));
  });
});


const local = (port: number) => ({ host: "host.docker.internal", port, tls: false });
const web = (extra: Record<string, unknown> = {}) => ({ id: "photos", type: "subdomain", name: "Photos", enabled: true, host: "photos.other.test", backend: local(2283), ...extra });

describe("who handles HTTPS for an address", () => {
  test("an address without a setting gets Caddy's own certificate, as before", () => {
    const site = block(renderCaddyfile(cleanConfig({ routes: [web()] }, base)), "photos.other.test");
    expect(site).not.toMatch(/\btls\b/);
    expect(cleanConfig({ routes: [web({ https: { mode: "auto" } })] }, base).routes[0]).not.toHaveProperty("https");
  });

  test("its own certificate is served from the folder Caddy sees, wherever that's mounted", () => {
    const cfg = cleanConfig({ routes: [web({ https: { mode: "own" } })] }, base);
    expect(block(renderCaddyfile(cfg), "photos.other.test")).toContain("\ttls /etc/caddy/certs/photos.other.test.crt /etc/caddy/certs/photos.other.test.key\n");
    expect(block(renderCaddyfile(cfg, "/config/caddy"), "photos.other.test")).toContain("\ttls /config/caddy/certs/photos.other.test.crt /config/caddy/certs/photos.other.test.key\n");
  });

  test("plain HTTP is an http:// site with no certificate, and its address says http://", () => {
    const cfg = cleanConfig({ routes: [web({ https: { mode: "http" } })] }, base);
    const text = renderCaddyfile(cfg);
    expect(text).toContain("\nhttp://photos.other.test {\n");
    expect(text).not.toContain("\nphotos.other.test {\n");
    expect(routeUrl(cfg, cfg.routes[0]!)).toBe("http://photos.other.test");
  });

  test("a chat server that handles its own certificate gets no site at all, so Caddy never asks for one", () => {
    const cfg = cleanConfig({ routes: [chat({ s2s_port: 5269, http_port: null, cert_sync: { container: "prosody" } }, { https: { mode: "none" } })] }, base);
    const text = renderCaddyfile(cfg);
    expect(text).not.toMatch(/^(http:\/\/)?chat\.example\.test\b.*\{$/m);
    expect(cfg.routes[0]).toMatchObject({ https: { mode: "none" }, xmpp: { cert_sync: null } });
  });

  test("a plain-HTTP chat server has nothing to copy, and tells web chat apps to use http and ws", () => {
    const cfg = cleanConfig({ routes: [chat({ s2s_port: null, http_port: 5280, cert_sync: { container: "prosody" } }, { https: { mode: "http" } })] }, base);
    const site = block(renderCaddyfile(cfg), "http://chat.example.test");
    expect(site).toContain("href='http://chat.example.test/http-bind'");
    expect(site).toContain('"href":"ws://chat.example.test/xmpp-websocket"');
    expect(cfg.routes[0]).toMatchObject({ xmpp: { cert_sync: null } });
  });

  test("certificate files are remembered as given", () => {
    const files = { cert: "/etc/letsencrypt/live/photos.other.test/fullchain.pem", key: "/etc/letsencrypt/live/photos.other.test/privkey.pem" };
    expect(cleanConfig({ routes: [web({ https: { mode: "own", files } })] }, base).routes[0]).toMatchObject({ https: { mode: "own", files } });
  });

  test.each([
    ["a web app has no web side", web({ https: { mode: "none" } }), "https"],
    ["a chat server with no web side keeps a web port", chat({ s2s_port: null, http_port: 5280, cert_sync: null }, { https: { mode: "none" } }), "http_port"],
    ["the mode is made up", web({ https: { mode: "cloudflare" } }), "https"],
    ["the certificate file isn't a full path", web({ https: { mode: "own", files: { cert: "fullchain.pem", key: "/k.pem" } } }), "cert_file"],
    ["the key file walks up the tree", web({ https: { mode: "own", files: { cert: "/c.pem", key: "/etc/../root/k.pem" } } }), "key_file"],
  ])("is refused when %s", (_, route, field) => {
    expect(() => cleanConfig({ routes: [route] }, base)).toThrow(expect.objectContaining({ details: expect.objectContaining({ field }) }));
  });
});

describe("a voice server address", () => {
  const voice = (extra: Record<string, unknown> = {}) => ({ id: "voice", type: "subdomain", name: "Mumble", enabled: true, host: "voice.example.test", backend: local(64739), voice: { port: 64738 }, only_paths: ["/x"], ...extra });

  test("shows browsers a mumble:// link instead of proxying them to a port that only speaks Mumble", () => {
    const cfg = cleanConfig({ routes: [voice()] }, base);
    expect(cfg.routes[0]).toMatchObject({ voice: { port: 64738 }, backend: { port: 64738 } });
    expect(cfg.routes[0]).not.toHaveProperty("only_paths");
    const site = block(renderCaddyfile(cfg), "voice.example.test");
    expect(site).not.toContain("reverse_proxy");
    expect(site).toContain('href="mumble://voice.example.test/"');
    // Caddy would treat {braces} in a response body as placeholders.
    expect(site.match(/respond .*$/m)?.[0]).not.toMatch(/[{}]/);
  });

  test("names a port other than Mumble's usual one in the link", () => {
    const site = block(renderCaddyfile(cleanConfig({ routes: [voice({ voice: { port: 7000 } })] }, base)), "voice.example.test");
    expect(site).toContain('href="mumble://voice.example.test:7000/"');
  });
});

describe("publicPorts", () => {
  test("names the address that reaches each port, through extra paths too, but not through redirects or routes that are off", () => {
    const cfg = cleanConfig(
      {
        routes: [
          { id: "umbrel", type: "subdomain", name: "Umbrel", enabled: true, host: "umbrel.example.test", backend: local(8300), extra_paths: [{ paths: ["/admin", "/admin/*"], backend: local(5275) }] },
          { id: "music", type: "subdomain", name: "Music", enabled: true, host: "music.example.test", backend: local(5274), only_paths: ["/rest/*"] },
          { id: "old", type: "subdomain", name: "Old", enabled: true, host: "old.example.test", backend: local(8130), redirect_to: "https://example.test" },
          { id: "off", type: "subdomain", name: "Off", enabled: false, host: "off.example.test", backend: local(9000) },
        ],
        fallback: { name: "Gluon", backend: local(8130) },
      },
      base,
    );
    expect(Object.fromEntries(publicPorts(cfg))).toEqual({ 8300: "umbrel.example.test", 5275: "umbrel.example.test/admin", 5274: "music.example.test/rest", 8130: "example.test" });
  });
});

describe("ports that chat and voice apps reach directly", () => {
  const cfg = cleanConfig(
    {
      routes: [
        chat({ s2s_port: 5269, http_port: 5280, cert_sync: null }),
        { id: "voice", type: "subdomain", name: "Mumble", enabled: true, host: "voice.example.test", backend: local(64738), voice: { port: 64738 } },
      ],
      fallback: { name: "Gluon", backend: local(8130) },
    },
    base,
  );

  test("aren't counted as reached through Caddy; only a chat server's web side is", () => {
    expect(Object.fromEntries(publicPorts(cfg))).toEqual({ 5280: "chat.example.test", 8130: "example.test" });
  });

  test("don't send dashboard tiles for the chat client port to the chat domain's web page", () => {
    const text = renderCaddyfile(cfg);
    expect(text).toContain('[5280, "https://chat.example.test"]');
    expect(text).not.toContain("[5222,");
    expect(text).not.toContain("[64738,");
  });
});
