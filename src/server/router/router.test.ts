import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deviceOption, forwardForm, formPayload, ownForm, parsePage, protocolOption, readForwards, readServices, restartButton, serviceForm, serviceOption } from "./bgw-pages";
import { assess, conflicts, covers, isServer, leftovers, planFixes, serviceName, serviceNames, type PortNeed } from "./plan";

// services, apphosting, restart and reset need the access code, so they're rebuilt from public
// captures of BGW320 firmware 6.35 inside the real page chrome; login pages are the real ones.
const raw = (f: string) => fs.readFileSync(path.join(__dirname, "__fixtures__", f), "latin1");
const page = (f: string) => parsePage(raw(f));
const services = page("services.html");
const hosting = page("apphosting.html");

describe("the access-code pages", () => {
  it("lists custom services with their ports, protocol and each row's own Remove button", () => {
    const list = readServices(services);
    expect(list.map((s) => [s.name, s.min, s.max, s.hostPort, s.protocol])).toEqual([
      ["XMPP Client", 5222, 5222, 5222, "tcp"],
      ["XMPP Server", 5269, 5269, 5269, "tcp"],
      ["Mumble", 64738, 64738, 64738, "both"],
    ]);
    expect(list[2]!.remove).toEqual({ name: "Remove_3", value: "Remove" });
  });

  it("reads an empty Custom Services page as no services, and still knows it's that page", () => {
    const empty = page("services-empty.html");
    expect(readServices(empty)).toEqual([]);
    expect(ownForm(empty, "services")).not.toBeNull();
    expect(ownForm(page("login.html"), "services")).toBeNull();
  });

  it("lists forwards without the * the gateway puts before custom services", () => {
    expect(readForwards(hosting).map((f) => [f.service, f.device])).toEqual([
      ["HTTPS Server", "homeserver"],
      ["XMPP Server", "homeserver"],
      ["XMPP Client", "192.168.1.40"],
    ]);
  });

  it("finds the add-service form by what its fields are", () => {
    const f = serviceForm(services)!;
    expect([f.name, f.min, f.max, f.hostPort, f.add.name]).toEqual(["Service", "extMinPort", "extMaxPort", "intStartPort", "Add"]);
    // The label "TCP/UDP" posts as accepted but is dropped; the option's value is what counts.
    expect(protocolOption(f.protocol, "both")).toBe("both");
    expect(protocolOption(f.protocol, "udp")).toBe("udp");
  });

  it("posts what a browser would: the form's fields, the one button pressed and the form's nonce", () => {
    const f = serviceForm(services)!;
    const body = formPayload(f.form, { Service: "Call relay", extMinPort: "3478", extMaxPort: "3478", intStartPort: "3478", protocol: "both" }, f.add);
    expect(body).toContainEqual(["Service", "Call relay"]);
    expect(body).toContainEqual(["protocol", "both"]);
    expect(body).toContainEqual(["Add", "Add"]);
    expect(body.filter(([k]) => k === "nonce")).toHaveLength(1);
    expect(body.some(([k]) => /^Remove_/.test(k))).toBe(false);
  });

  it("picks forward options by service name and by MAC, telling twins with the same name apart", () => {
    const f = forwardForm(hosting)!;
    expect(serviceOption(f.service, "Mumble")).toBe("*Mumble");
    expect(serviceOption(f.service, "HTTP Server")).toBe("HTTP Server");
    expect(serviceOption(f.service, "Nope")).toBeNull();
    expect(deviceOption(f.device, "14:B3:1F:76:A7:5F")).toEqual({ value: "14:b3:1f:76:a7:5f", label: "homeserver" });
    expect(deviceOption(f.device, "52:1f:aa:e0:39:12")?.value).toBe("52:1f:aa:e0:39:12");
  });

  it("finds the plain Restart button on either page and never one of the reset buttons beside it", () => {
    expect(restartButton(page("restart.html"))?.button).toEqual({ name: "Restart", value: "Restart" });
    const reset = restartButton(page("reset.html"))!;
    expect(reset.button).toEqual({ name: "Restart", value: "Restart" });
    expect(formPayload(reset.form, {}, reset.button).filter(([k]) => k !== "nonce")).toEqual([["Restart", "Restart"]]);
    // Some captures label it "Restart Device"; anything else named Restart is left alone.
    const variant = (value: string) => parsePage(`<form method="post" action="/cgi-bin/restart.ha"><input type="hidden" name="nonce" value="a"/><input type="submit" name="Restart" value="${value}"/></form>`);
    expect(restartButton(variant("Restart Device"))).not.toBeNull();
    expect(restartButton(variant("Restart and reset"))).toBeNull();
    expect(restartButton(page("services.html"))).toBeNull();
  });

  it("recognises both forms of the real sign-in page and a full session pool", () => {
    expect(page("login.html").login).toBe(true);
    expect(page("login-cookie-gate.html").login).toBe(true);
    // The first visit's page has no form at all: the nonce only comes once the cookie is set.
    expect(page("login-cookie-gate.html").forms).toHaveLength(0);
    expect(page("login.html").forms[0]!.nonces[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(hosting.login).toBe(false);
    expect(parsePage("<p>Router reports all web server sessions are in use. Wait for a router web session to timeout, then retry.</p>").sessionsFull).toBe(true);
  });
});

const need = (key: string, min: number, max: number, protocol: PortNeed["protocol"], hostPort = min, label = key): PortNeed => ({ key, label, why: "", min, max, hostPort, protocol });
const server = { names: ["homeserver", "192.168.1.230", "14:b3:1f:76:a7:5f"] };

describe("what's forwarded and what's missing", () => {
  it("counts a TCP/UDP service for a TCP-only or UDP-only need, but not the other way round", () => {
    expect(covers({ min: 3478, max: 3478, hostPort: 3478, protocol: "both" }, need("x", 3478, 3478, "udp"))).toBe(true);
    expect(covers({ min: 3478, max: 3478, hostPort: 3478, protocol: "tcp" }, need("x", 3478, 3478, "both"))).toBe(false);
    expect(covers({ min: 49160, max: 49200, hostPort: 49160, protocol: "udp" }, need("x", 49160, 49199, "udp"))).toBe(false);
  });

  it("knows this server by hostname, address, MAC or the router's unknown<mac> name, and not by a lookalike", () => {
    expect(isServer("homeserver", server)).toBe(true);
    expect(isServer("192.168.1.230", server)).toBe(true);
    expect(isServer("homeserver / 192.168.1.230", server)).toBe(true);
    expect(isServer("unknown14b31f76a75f", server)).toBe(true);
    expect(isServer("homeserver-laptop", server)).toBe(false);
    expect(isServer("192.168.1.23", server)).toBe(false);
  });

  it("tells forwarded, going elsewhere and missing apart, including the gateway's built-in services", () => {
    const states = assess(
      [need("https", 443, 443, "tcp"), need("s2s", 5269, 5269, "tcp"), need("c2s", 5222, 5222, "tcp"), need("mumble", 64738, 64738, "both"), need("relay", 3478, 3478, "both")],
      readServices(services),
      readForwards(hosting),
      server,
    );
    expect(states.map((s) => [s.need.key, s.status, s.service, s.device])).toEqual([
      ["https", "forwarded", "HTTPS Server", "homeserver"],
      ["s2s", "forwarded", "XMPP Server", "homeserver"],
      ["c2s", "elsewhere", "XMPP Client", "192.168.1.40"],
      ["mumble", "missing", "Mumble", null],
      ["relay", "missing", null, null],
    ]);
  });

  it("knows a built-in forward by the ports the table shows, whatever the firmware calls it", () => {
    // NAT/Gaming as firmware 6.35 really renders it: built-ins named "HTTP" and "HTTPS", a Ports column.
    const row = (svc: string, ports: string, dev: string, i: number) =>
      `<tr><td scope="row" class="heading">\n${svc}\n</td><td>\n${ports}<br />\n</td><td> ${dev}\n</td><td>\n<input type="submit" name="Remove_${i}" value="Delete" class="cssbtn smallbtn" />\n</td>\n</tr>`;
    const real = parsePage(
      `<form method="post" action="/cgi-bin/apphosting.ha"><table class="grid table100"><tr><th>Service</th><th>Ports</th><th>Device</th><th>Delete</th></tr>` +
        row("HTTP", "TCP/UDP: 80", "homeserver", 1) + row("HTTPS", "TCP/UDP: 443", "192.168.1.40", 2) + row("Call media", "UDP: 49160-49200", "homeserver", 3) + row("SSH server", "TCP: 22", "homeserver", 4) +
        `</table></form>`,
    );
    const fwds = readForwards(real);
    expect(fwds.map((f) => [f.service, f.device, f.ports])).toEqual([
      ["HTTP", "homeserver", [{ min: 80, max: 80, protocol: "both" }]],
      ["HTTPS", "192.168.1.40", [{ min: 443, max: 443, protocol: "both" }]],
      ["Call media", "homeserver", [{ min: 49160, max: 49200, protocol: "udp" }]],
      ["SSH server", "homeserver", [{ min: 22, max: 22, protocol: "tcp" }]],
    ]);
    const svcs = [{ name: "Call media", min: 49160, max: 49200, hostPort: 49160, protocol: "udp" as const, remove: null }];
    const states = assess([need("http", 80, 80, "tcp"), need("https", 443, 443, "tcp"), need("ssh", 22, 22, "tcp"), need("media", 49160, 49200, "udp"), need("alt", 2222, 2222, "tcp", 22)], svcs, fwds, server);
    expect(states.map((s) => [s.need.key, s.status, s.service, s.device])).toEqual([
      ["http", "forwarded", "HTTP", "homeserver"],
      ["https", "elsewhere", "HTTPS", "192.168.1.40"],
      ["ssh", "forwarded", "SSH server", "homeserver"],
      ["media", "forwarded", "Call media", "homeserver"],
      ["alt", "missing", null, null],
    ]);
    expect(planFixes(states, ["Call media"]).map((s) => [s.kind, s.service])).toEqual([
      ["add-service", "alt"],
      ["add-forward", "alt"],
    ]);
    // A built-in that isn't forwarded yet may be offered under either name.
    expect(serviceNames("HTTP Server")).toEqual(["HTTP Server", "HTTP"]);
    expect(serviceNames("Call media")).toEqual(["Call media"]);
  });

  it("reuses an existing service, adds one only when none fits, and never moves a forward from another device", () => {
    const states = assess([need("http", 80, 80, "tcp"), need("c2s", 5222, 5222, "tcp"), need("mumble", 64738, 64738, "both"), need("relay", 3478, 3478, "both", 3478, "Call relay")], readServices(services), readForwards(hosting), server);
    expect(planFixes(states, ["XMPP Client", "XMPP Server", "Mumble", "Call relay"]).map((s) => [s.kind, s.service])).toEqual([
      ["add-forward", "HTTP Server"],
      ["add-forward", "Mumble"],
      ["add-service", "Call relay 2"],
      ["add-forward", "Call relay 2"],
    ]);
  });

  it("keeps new service names within the router's limit, numbering inside it when one is taken", () => {
    expect(serviceName("Bedrock Island Survival", new Set())).toBe("Bedrock Island");
    expect(serviceName("Bedrock Island Survival", new Set(["bedrock island"]))).toBe("Bedrock Islan 2");
    expect(serviceName("Valheim", new Set(), 5)).toBe("Valhe");
  });

  it("finds services Gluon made that no need uses any more, and where they still point", () => {
    const states = assess([need("s2s", 5269, 5269, "tcp")], readServices(services), readForwards(hosting), server);
    expect(leftovers(["XMPP Server", "Mumble", "Gone"], states, readServices(services), readForwards(hosting))).toEqual([{ service: "Mumble", min: 64738, max: 64738, hostPort: 64738, protocol: "both", device: null }]);
  });

  describe("never forwards a public port that's already spoken for", () => {
    const svcs = readServices(services);
    const fwds = readForwards(hosting);
    const check = (fixing: PortNeed[], all: PortNeed[] = fixing) => conflicts(assess(fixing, svcs, fwds, server), all, svcs, fwds, server);

    it("stops when two of Gluon's own needs want the same public port", () => {
      const game = need("game", 443, 443, "tcp", 2456, "Valheim");
      expect(check([game], [need("https", 443, 443, "tcp", 443, "Web (HTTPS)"), game])[0]).toMatch(/^Valheim \(TCP 443\) and Web \(HTTPS\) \(TCP 443\) want the same public port/);
    });

    it("stops when a router service overlapping the range goes to another device", () => {
      const wide = need("wide", 5200, 5230, "tcp", 5200, "Wide");
      expect(check([wide]).some((m) => /already goes to 192\.168\.1\.40 through "XMPP Client"/.test(m))).toBe(true);
    });

    it("stops on a partial overlap even when it points here, but reuses an exact match and ignores other protocols", () => {
      expect(check([need("near", 5269, 5270, "tcp")])[0]).toMatch(/"XMPP Server" service \(TCP 5269\) overlaps/);
      expect(check([need("mumble", 64738, 64738, "both")])).toEqual([]);
      expect(check([need("udp", 5222, 5222, "udp")])).toEqual([]);
    });
  });
});

