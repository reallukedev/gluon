import { describe, expect, it } from "vitest";
import { parseCompose, parsePortString, readServices } from "@/lib/builder/compose";
import { alternatePortNotes, pickPortSet, QUARK_ALT_PORTS, QUARK_PORT_SETS, QUARK_PORTS, quarkPortsFrom, srvRecords, type QuarkPorts } from "@/lib/chat-ports";
import { checkableCompose, installSettings, quarkRecipe } from "./recipe";

const install = { server: "quark" as const, domain: "rustxmpp.example.com", username: "luke", settings: installSettings("rustxmpp.example.com") };

/** What serverChecks does with a compose, against a fixed set of ports in use ("5222/tcp"). */
function clashes(used: Set<string>) {
  return async (ports: QuarkPorts) => {
    const parsed = parseCompose(checkableCompose(quarkRecipe({ ...install, ports }).compose));
    if (!parsed.ok) throw new Error("bad compose");
    return readServices(parsed.doc)
      .flatMap((s) => s.ports)
      .filter((p) => p.raw === null && p.host && used.has(`${p.host}/${p.proto}`))
      .map((p) => `Port ${p.host} is already used by prosody.`);
  };
}

describe("picking Quark's ports", () => {
  it("uses the standard ports when nothing holds them", async () => {
    expect(await pickPortSet(QUARK_PORT_SETS, clashes(new Set()))).toEqual({ ports: QUARK_PORTS, conflicts: [] });
  });

  it("moves to the first alternate set beside Prosody and coturn", async () => {
    const used = new Set(["5222/tcp", "5269/tcp", "5280/tcp", "5281/tcp", "3478/tcp", "3478/udp"]);
    expect((await pickPortSet(QUARK_PORT_SETS, clashes(used))).ports).toEqual(QUARK_ALT_PORTS[0]);
  });

  it("notices a clash anywhere in the relay range", async () => {
    const r = await pickPortSet(QUARK_PORT_SETS, clashes(new Set(["49180/udp", "49230/udp"])));
    expect(r.ports).toEqual(QUARK_ALT_PORTS[1]);
  });

  it("gives up with the standard set's clashes when every set is taken", async () => {
    const r = await pickPortSet(QUARK_PORT_SETS, clashes(new Set(["5222/tcp", "5322/tcp", "5422/tcp"])));
    expect(r).toEqual({ ports: null, conflicts: ["Port 5222 is already used by prosody."] });
  });

  it("stops checking once a set is free", async () => {
    const seen: number[] = [];
    await pickPortSet(QUARK_PORT_SETS, async (p) => (seen.push(p.c2s), p.c2s === 5222 ? ["taken"] : []));
    expect(seen).toEqual([5222, 5322]);
  });
});

describe("writing port ranges out for the check", () => {
  it("lists every relay port and leaves the rest alone", () => {
    const out = checkableCompose('    ports:\n      - "5322:5222"\n      - "49210-49212:49210-49212/udp"\n');
    expect(out).toBe('    ports:\n      - "5322:5222"\n      - "49210:49210/udp"\n      - "49211:49211/udp"\n      - "49212:49212/udp"\n');
    expect(parsePortString("49211:49211/udp")).toMatchObject({ host: 49211, proto: "udp", raw: null });
  });

  it("keeps a range it can't split one to one", () => {
    const line = '      - "1000-1010:2000-2005/udp"';
    expect(checkableCompose(line)).toBe(line);
  });
});

describe("reading the ports back from the running container", () => {
  const alt = QUARK_ALT_PORTS[0]!;
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => ({ host: a + i, container: a + i, proto: "udp" as const }));

  it("finds the moved ports and the relay", () => {
    const mappings = [
      { host: 5322, container: 5222, proto: "tcp" as const },
      { host: 5323, container: 5223, proto: "tcp" as const },
      { host: 5369, container: 5269, proto: "tcp" as const },
      { host: 5380, container: 5280, proto: "tcp" as const },
      { host: 3479, container: 3479, proto: "tcp" as const },
      { host: 3479, container: 3479, proto: "udp" as const },
      ...range(49210, 49250),
    ];
    expect(quarkPortsFrom(mappings)).toEqual(alt);
  });

  it("falls back to the standard ports when it can't see any", () => {
    expect(quarkPortsFrom([])).toEqual(QUARK_PORTS);
  });
});

describe("what the person has to set up", () => {
  const alt = QUARK_ALT_PORTS[0]!;

  it("names the SRV records with the moved ports", () => {
    expect(srvRecords("rustxmpp.example.com", alt)).toEqual([
      { name: "_xmpp-client._tcp.rustxmpp.example.com", port: 5322 },
      { name: "_xmpps-client._tcp.rustxmpp.example.com", port: 5323 },
      { name: "_xmpp-server._tcp.rustxmpp.example.com", port: 5369 },
    ]);
  });

  it("says why, which records, and what to forward", () => {
    const [why, dns, router] = alternatePortNotes("rustxmpp.example.com", alt);
    expect(why).toMatch(/^Another chat server already uses the standard chat ports, so Quark uses 5322/);
    expect(dns).toContain("_xmpp-client._tcp.rustxmpp.example.com pointing at rustxmpp.example.com port 5322");
    expect(dns).toContain("_xmpps-client._tcp.rustxmpp.example.com pointing at rustxmpp.example.com port 5323");
    expect(dns).toContain("_xmpp-server._tcp.rustxmpp.example.com pointing at rustxmpp.example.com port 5369");
    expect(router).toBe("On your router, forward TCP 5322, 5323 and 5369, TCP and UDP 3479, and UDP 49210-49250 to this server.");
  });
});
