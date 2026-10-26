// End to end against a fake BGW320 that behaves like the real one: a cookie on the first visit
// and the sign-in form only after it, a small pool of web sessions, a fresh 64-hex nonce per page
// view, md5 sign-in, positional Remove buttons, and a restart that drops the connection.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gluon-router-"));
process.env.GLUON_DATA = dir;
const CODE = "7#9&k2!x?Q";
const MAC = "14:b3:1f:76:a7:5f";
const NAME = os.hostname().split(".")[0]!;
let port = 0;
let routes: { type: string; host: string; backend: { port: number }; xmpp?: { s2s_port: number } }[] = [{ type: "subdomain", host: "chat.example.com", backend: { port: 5222 }, xmpp: { s2s_port: 5269 } }];

vi.mock("../diagnostics/checkup/probes", () => ({ defaultGateways: async () => [{ family: 4, gateway: `127.0.0.1:${port}`, dev: "eth0" }] }));
vi.mock("../diagnostics/interfaces", () => ({ ipAddr: async () => [{ ifname: "eth0", address: MAC.toUpperCase(), addr_info: [{ family: "inet", local: "192.168.1.230" }] }] }));
let apps: unknown[] = [{ containers: [{ image: "coturn/coturn:4.6", ports: [] }] }];
vi.mock("../docker/apps", () => ({ listApps: async () => apps }));
vi.mock("../games/needs", () => ({ gamePortNeeds: async () => [] }));
vi.mock("../audit", () => ({ audit: () => {}, systemEvent: () => {} }));
vi.mock("../caddy/routes", async (orig) => ({ ...(await orig<typeof import("../caddy/routes")>()), tryReadConfig: () => ({ routes }) }));

const fixture = (n: string) => fs.readFileSync(path.join(__dirname, "__fixtures__", n), "latin1");
const nonce = () => crypto.randomBytes(32).toString("hex");
const withNonces = (html: string) => html.replace(/(name="nonce" value=")[0-9a-f]+(")/g, (_, a, b) => a + nonce() + b);

// ---------------------------------------------------------------- the gateway

const POOL = 4;
const sessions = new Map<string, { authed: boolean; nonce: string }>();
let opened = 0;
const services = [
  { name: "XMPP Client", min: 5222, max: 5222, base: 5222, proto: "tcp" },
  { name: "XMPP Server", min: 5269, max: 5269, base: 5269, proto: "tcp" },
];
const forwards = [{ service: "XMPP Server", device: NAME }];
const posts: string[] = [];
let boot = Date.now() - 6 * 86_400_000;
let rx = 9e11;
let down = false;
/** Every session in use: what the real router says when too many browsers are signed in. */
let full = false;
const label = (p: string) => ({ both: "TCP/UDP", tcp: "TCP", udp: "UDP" })[p];
const isCustom = (n: string) => services.some((s) => s.name === n);

function servicesPage(n: string) {
  const rows = services.map((s, i) => `<tr><td>${s.name}</td><td>${s.min}-${s.max}</td><td>${s.base}</td><td>${label(s.proto)}</td><td><input type="submit" name="Remove_${i + 1}" class="cssbtn smallbtn" value="Remove" /></td></tr>`).join("\n");
  const table = services.length ? `<tr><th scope="col">Service Name</th><th scope="col">Global Port Range</th><th scope="col">Base Host Port</th><th scope="col">Protocol</th><th scope="col">&nbsp;</th></tr>${rows}` : `<tr><th colspan="2">No Custom Service entries have been defined</th></tr>`;
  return `<html><head><title>Custom Services</title></head><body><div id="content-sub"><form method="post" action="/cgi-bin/services.ha"><input type="hidden" name="nonce" value="${n}" />
<table class="grid table100" summary="Table of existing custom services">${table}</table>
<table><tr><th scope="row">Service Name</th><td><input id="name" type="text" name="Service" value="" /></td></tr>
<tr><th scope="row">Global Port Range</th><td><input type="text" name="extMinPort" value="" /> - <input type="text" name="extMaxPort" value="" /></td></tr>
<tr><th scope="row">Base Host Port</th><td><input type="text" name="intStartPort" value="" /></td></tr>
<tr><th scope="row">Protocol</th><td><select name="protocol"><option value="both" selected="selected">TCP/UDP</option><option value="tcp">TCP</option><option value="udp">UDP</option></select></td></tr></table>
<input type="submit" name="Add" class="cssbtn" value="Add" /></form></div></body></html>`;
}
function hostingPage(n: string) {
  const free = ["HTTP Server", "HTTPS Server", ...services.map((s) => s.name)].filter((x) => !forwards.some((f) => f.service === x));
  const opts = free.map((x) => `<option value="${isCustom(x) ? "*" : ""}${x}">${isCustom(x) ? "*" : ""}${x}</option>`).join("");
  const rows = forwards.map((f, i) => `<tr><td>${isCustom(f.service) ? "*" : ""}${f.service}</td><td>${f.device}</td><td><input type="submit" name="Remove_${i + 1}" class="cssbtn smallbtn" value="Remove" /></td></tr>`).join("");
  return `<html><head><title>NAT/Gaming</title></head><body><div id="content-sub"><form method="post" action="/cgi-bin/apphosting.ha"><input type="hidden" name="nonce" value="${n}" />
<table><tr><th scope="row">Service</th><td><select name="service"><option value="">-- Select --</option>${opts}</select></td></tr>
<tr><th scope="row">Needed by Device</th><td><select name="device"><option value="">-- Select --</option><option value="${MAC}">${NAME}</option><option value="7e:61:0d:a4:d4:4c">Watch</option></select></td></tr></table>
<input type="submit" name="Add" class="cssbtn" value="Add" />
<table class="grid table100" summary="Table of current hosted applications"><tr><th scope="col">Service</th><th scope="col">Needed by Device</th><th scope="col">&nbsp;</th></tr>${rows}</table></form></div></body></html>`;
}
const loginPage = (n: string) => fixture("login.html").replace(/(name="nonce" value=")[0-9a-f]+(")/, `$1${n}$2`);
const sysinfo = () => fixture("sysinfo.html").replace(/(Time Since Last Reboot<\/th>\s*<td class="col2">)\d+/, `$1${Math.round((Date.now() - boot) / 1000)}`);
const broadband = () => fixture("broadbandstatistics.html").replace(/(Receive Bytes<\/th>\s*<td>)\d+/, `$1${Math.round((rx += 3e6))}`);
const PUBLIC: Record<string, () => string> = { sysinfo, broadbandstatistics: broadband, home: () => withNonces(fixture("home.html")), devices: () => withNonces(fixture("devices.html")), fiberstat: () => fixture("fiberstat.html"), firewall: () => fixture("firewall.html") };
const requests: string[] = [];

const server = http.createServer((req, res) => {
  if (down) return req.socket.destroy();
  if (full) return req.on("data", () => {}).on("end", () => requests.push(`full ${req.url}`) && res.end("<html><body><h1>Access Code Required</h1><p>Router reports all web server sessions are in use. Wait for a router web session to timeout, then retry.</p></body></html>"));
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = req.url!;
    const page = url.match(/^\/cgi-bin\/(\w+)\.ha/)?.[1] ?? "";
    requests.push(`${req.method} ${page}`);
    const sid = /SessionID=(\w+)/.exec(req.headers.cookie ?? "")?.[1];
    let s = sid ? sessions.get(sid) : undefined;
    let first = false;
    if (!s) {
      if (sessions.size >= POOL) return res.end("<html><body><h1>Access Code Required</h1><p>Router reports all web server sessions are in use. Wait for a router web session to timeout, then retry.</p></body></html>");
      const id = crypto.randomBytes(16).toString("hex");
      s = { authed: false, nonce: "" };
      sessions.set(id, s);
      opened++;
      first = true;
    }
    res.setHeader("Set-Cookie", `SessionID=${[...sessions].find(([, v]) => v === s)![0]}; Version=1; Discard; HttpOnly; Path=/`);
    if (PUBLIC[page] && req.method === "GET") return res.end(PUBLIC[page]!());
    const f = new URLSearchParams(body);
    if (page === "login") {
      if (req.method === "GET" && first) return res.end(fixture("login-cookie-gate.html"));
      if (req.method === "POST") {
        const ok = f.get("nonce") === s.nonce && f.get("password") === "*".repeat(CODE.length) && f.get("hashpassword") === crypto.createHash("md5").update(CODE + s.nonce).digest("hex");
        posts.push(`login ${ok}`);
        // A failed sign-in leaves the session signed out, whatever it was before.
        s.authed = ok;
        if (ok) {
          s.authed = true;
          res.writeHead(302, { Location: "/cgi-bin/home.ha" });
          return res.end();
        }
      }
      s.nonce = nonce();
      return res.end(loginPage(s.nonce));
    }
    if (!s.authed) return res.end(first ? fixture("login-cookie-gate.html") : loginPage((s.nonce = nonce())));
    if (req.method === "POST") {
      if (f.get("nonce") !== s.nonce) return res.end("<p>Bad request</p>");
      const pressed = [...f.keys()].filter((k) => /^(Add|Remove_\d+|Restart|Reset|WReset|FReset|ResetIP|ResetConn)$/.test(k));
      posts.push(`${page} ${pressed.join(",")} ${f.get("Service") ?? f.get("service") ?? ""}`.trim());
      if (pressed.length !== 1) return res.end("<p>Bad request</p>");
      const b = pressed[0]!;
      if (page === "services" && b === "Add") services.push({ name: f.get("Service")!.slice(0, 15), min: +f.get("extMinPort")!, max: +f.get("extMaxPort")!, base: +f.get("intStartPort")!, proto: f.get("protocol")! });
      if (page === "services" && b.startsWith("Remove_")) {
        const sv = services[+b.slice(7) - 1]!;
        if (!forwards.some((x) => x.service === sv.name)) services.splice(+b.slice(7) - 1, 1);
      }
      if (page === "apphosting" && b === "Add") forwards.push({ service: f.get("service")!.replace(/^\*/, ""), device: f.get("device") === MAC ? NAME : "Watch" });
      if (page === "apphosting" && b.startsWith("Remove_")) forwards.splice(+b.slice(7) - 1, 1);
      if (page === "restart" && b === "Restart") {
        // Down mid-answer, back two seconds later with a fresh boot and no sessions.
        down = true;
        req.socket.destroy();
        setTimeout(() => {
          sessions.clear();
          boot = Date.now();
          rx = 4e6;
          down = false;
        }, 2000);
        return;
      }
    }
    s.nonce = nonce();
    if (page === "services") return res.end(servicesPage(s.nonce));
    if (page === "apphosting") return res.end(hostingPage(s.nonce));
    if (page === "restart") return res.end(withNonces(fixture("restart.html")).replace(/(name="nonce" value=")[0-9a-f]+(")/, `$1${s.nonce}$2`));
    res.end("<html><body>Status</body></html>");
  });
});

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});
afterAll(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const user = { id: "u", username: "luke", role: "admin" } as never;
const where = { ip: "127.0.0.1", zone: "lan" };

describe("against a BGW that behaves like the real one", () => {
  it("serves the router page from memory after the first read, and reads only the pages anyone can open", async () => {
    const mon = await import("./monitor");
    const first = await mon.overview({ waitMs: 8000 });
    expect([first.kind, first.facts?.model, first.broadband?.up, first.access.connected]).toEqual(["bgw", "BGW320-500", true, false]);
    const before = requests.length;
    const t0 = Date.now();
    const again = await mon.overview();
    expect(Date.now() - t0).toBeLessThan(100);
    expect(again.facts?.serial).toBe("D90LG0TF123456");
    // Nothing was due: the second look didn't touch the router.
    expect(requests.length).toBe(before);
    expect(requests.every((r) => !/login|services|apphosting/.test(r))).toBe(true);
  }, 20_000);

  it("signs in with the code (after the cookie-only first visit), refuses a wrong one, and forwards what's missing", async () => {
    const svc = await import("./service");
    await expect(svc.connectRouter(user, where, "wrong-code")).rejects.toThrow(/didn't accept/);
    const st = await svc.connectRouter(user, where, CODE);
    expect(st.connected).toBe(true);
    expect(st.needs.find((n) => n.need.key === "chat-s2s")!.status).toBe("forwarded");

    const r = await svc.fixForwarding(user, where, null);
    expect(r.status.needs.every((n) => n.status === "forwarded")).toBe(true);
    expect(services.map((s) => s.name)).toEqual(expect.arrayContaining(["Call relay", "Call media"]));
    expect((await svc.fixForwarding(user, where, null)).done).toEqual([]);
    await expect(svc.removeForwarding(user, where, { key: "chat-s2s" })).rejects.toThrow(/only removes/);
  }, 30_000);

  it("lists a service Gluon made that nothing needs any more, and removes it with its forward", async () => {
    const svc = await import("./service");
    const relay = await svc.routerStatus();
    expect(relay.leftovers).toEqual([]);
    // The chat route and the call relay go, and their needs with them. Gluon made only the relay's services.
    routes = [];
    apps = [];
    const st = await svc.routerStatus();
    expect(st.leftovers.map((l) => [l.service, l.device])).toEqual([
      ["Call relay", NAME],
      ["Call media", NAME],
    ]);
    const after = await svc.removeForwarding(user, where, { service: "Call relay" });
    expect(after.leftovers.map((l) => l.service)).toEqual(["Call media"]);
    expect(services.some((s) => s.name === "Call relay") || forwards.some((f) => f.service === "Call relay")).toBe(false);
    await expect(svc.removeForwarding(user, where, { service: "XMPP Client" })).rejects.toThrow(/only removes/);
  }, 30_000);

  it("answers port forwarding from its last read for a while instead of signing in on every poll", async () => {
    const svc = await import("./service");
    const before = requests.length;
    await svc.routerStatus();
    await svc.routerStatus();
    expect(requests.slice(before).filter((r) => /login|services|apphosting/.test(r))).toEqual([]);
  });

  it("refuses to stop a forward the router now sends somewhere else, and changes nothing", async () => {
    const svc = await import("./service");
    const media = forwards.find((f) => f.service === "Call media")!;
    media.device = "Watch";
    const changes = () => posts.filter((p) => !p.startsWith("login")).length;
    const sent = changes();
    await expect(svc.removeForwarding(user, where, { service: "Call media" })).rejects.toThrow(/sends "Call media" to Watch, not this server/);
    expect(changes()).toBe(sent);
    expect(services.some((x) => x.name === "Call media")).toBe(true);
    media.device = NAME;
  }, 30_000);

  it("signs in with a code entered while a job waited in the queue, and never writes the old code back", async () => {
    const svc = await import("./service");
    const acc = await import("./access");
    const client = await import("./bgw-client");
    const gw = `127.0.0.1:${port}`;
    acc.remember(gw, "HUMAX BGW320-500", "old-code-1", "luke");
    client.signOut(gw);
    let release!: () => void;
    const blocker = client.withRouter(gw, null, () => new Promise<void>((r) => (release = r)));
    routes = [{ type: "subdomain", host: "chat.example.com", backend: { port: 5222 }, xmpp: { s2s_port: 5269 } }];
    const job = svc.fixForwarding(user, where, ["chat-s2s"]);
    await new Promise((r) => setTimeout(r, 50));
    acc.remember(gw, "HUMAX BGW320-500", CODE, "luke");
    release();
    await blocker;
    await expect(job).resolves.toMatchObject({ done: [] });
    expect(acc.access(gw)!.code).toBe(CODE);
  }, 30_000);

  it("stops signing in with a code the router refuses, says so, and starts again once it's re-entered", async () => {
    const svc = await import("./service");
    const acc = await import("./access");
    const client = await import("./bgw-client");
    const gw = `127.0.0.1:${port}`;
    const created = acc.access(gw)!.created;
    acc.remember(gw, "HUMAX BGW320-500", "changed-on-router", "luke");
    acc.updateCreated(gw, () => created);
    client.signOut(gw);
    (globalThis as { __gluonForwarding?: { snap: unknown } }).__gluonForwarding!.snap = null;
    const tries = () => posts.filter((p) => p.startsWith("login")).length;
    const t0 = tries();
    const st = await svc.routerStatus();
    expect([st.codeRejected, st.error]).toEqual([true, "The router no longer accepts the access code Gluon has. Enter it again."]);
    expect(tries()).toBe(t0 + 1);
    await svc.routerStatus();
    await expect(svc.restartRouter(user, where)).rejects.toThrow(/no longer accepts/);
    expect(tries()).toBe(t0 + 1);
    const back = await svc.connectRouter(user, where, CODE);
    expect([back.codeRejected, back.connected, back.connectedBy?.name]).toEqual([false, true, "luke"]);
    expect(acc.access(gw)!.created).toEqual(created);
  }, 30_000);

  it("restarts with only the Restart button, then confirms it from the fresh uptime", async () => {
    const svc = await import("./service");
    const mon = await import("./monitor");
    const { requestedAt } = await svc.restartRouter(user, where);
    expect(posts.at(-1)).toBe("restart Restart");
    let o = await mon.overview();
    expect(o.restart?.state).toBe("waiting");
    for (let i = 0; i < 40 && o.restart?.state === "waiting"; i++) {
      await new Promise((r) => setTimeout(r, 500));
      o = await mon.overview();
    }
    expect(o.restart?.state).toBe("done");
    expect(o.facts!.bootAt!).toBeGreaterThan(requestedAt - 60_000);
  }, 40_000);

  it("keeps the last good reading when the router's sessions are all in use, says why, and backs off", async () => {
    const mon = await import("./monitor");
    const before = await mon.overview();
    const real = Date.now;
    full = true;
    try {
      // Twenty seconds on: the status pages are due again for someone watching.
      vi.spyOn(Date, "now").mockImplementation(() => real() + 20_000);
      await mon.tick();
      const o = await mon.overview();
      expect(o.error).toMatch(/too many web sessions/);
      expect(o.facts?.serial).toBe(before.facts?.serial);
      expect(o.readAt.broadband).toBe(before.readAt.broadband);
      const asked = requests.length;
      await mon.tick();
      expect(requests.length).toBe(asked);
    } finally {
      full = false;
      vi.restoreAllMocks();
    }
  });

  it("keeps its cookies: one router session to read and one to sign in, and one more to read after the restart", () => {
    expect(opened).toBe(3);
  });

  it("forgets the access code without asking the router", async () => {
    const svc = await import("./service");
    const acc = await import("./access");
    const before = requests.length;
    expect(svc.forgetRouter(user, where)).toEqual({ forgotten: [`127.0.0.1:${port}`] });
    expect(acc.access(`127.0.0.1:${port}`)).toBeNull();
    expect(requests.length).toBe(before);
  });
});
