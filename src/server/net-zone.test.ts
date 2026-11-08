import { describe, expect, it, vi } from "vitest";

vi.mock("./settings", () => ({ getSetting: (k: string) => (k === "homeNetworks" ? [] : "") }));
vi.mock("./docker/client", () => ({ docker: () => ({ listNetworks: async () => [] }) }));
const { clientInfo, noteDockerNetworks, PEER_HEADER } = await import("./net-zone");

const h = (o: Record<string, string>) => new Headers(o);

describe("clientInfo through Cloudflare", () => {
  it("a tunnel visit whose chain ends at loopback is away, never home", () => {
    const info = clientInfo(h({ [PEER_HEADER]: "127.0.0.1", "x-forwarded-for": "127.0.0.1", "cf-ray": "8a1b-LHR", "cf-connecting-ip": "198.51.100.20" }));
    expect(info).toEqual({ ip: "198.51.100.20", zone: "away" });
  });

  it("reads the visitor from the chain when cloudflared passed it on", () => {
    expect(clientInfo(h({ [PEER_HEADER]: "172.17.0.2", "x-forwarded-for": "198.51.100.20, 127.0.0.1", "cf-ray": "x" }))).toEqual({ ip: "198.51.100.20", zone: "away" });
  });

  it("someone at home without Cloudflare in the way stays home", () => {
    expect(clientInfo(h({ [PEER_HEADER]: "192.168.1.30" }))).toEqual({ ip: "192.168.1.30", zone: "home" });
  });
});

describe("clientInfo and forged forwarding headers", () => {
  it("a peer on the internet is the client, whatever it says it forwards for", () => {
    expect(clientInfo(h({ [PEER_HEADER]: "203.0.113.7", "x-forwarded-for": "192.168.1.30" }))).toEqual({ ip: "203.0.113.7", zone: "away" });
  });

  it("behind our proxy, only the right end of the chain counts", () => {
    // The visitor typed a home address themselves; Caddy appended who really connected.
    expect(clientInfo(h({ [PEER_HEADER]: "172.18.0.5", "x-forwarded-for": "192.168.1.30, 203.0.113.7" }))).toEqual({ ip: "203.0.113.7", zone: "away" });
  });

  it("steps past one Cloudflare edge hop to the visitor, and no further", () => {
    expect(clientInfo(h({ [PEER_HEADER]: "127.0.0.1", "x-forwarded-for": "10.0.0.9, 198.51.100.20, 162.158.1.1" }))).toEqual({ ip: "198.51.100.20", zone: "away" });
  });

  it("a garbled entry where the visitor should be reads as unknown and away", () => {
    expect(clientInfo(h({ [PEER_HEADER]: "127.0.0.1", "x-forwarded-for": "198.51.100.20, not-an-address" }))).toEqual({ ip: "unknown", zone: "away" });
  });

  it("without the peer stamp in production, nobody is home", () => {
    process.env.GLUON_PEER_HEADER = "1";
    try {
      expect(clientInfo(h({ "x-forwarded-for": "192.168.1.30" }))).toEqual({ ip: "unknown", zone: "away" });
    } finally {
      delete process.env.GLUON_PEER_HEADER;
    }
  });
});

describe("clientInfo and containers on this machine", () => {
  noteDockerNetworks([
    { Driver: "bridge", IPAM: { Config: [{ Subnet: "172.18.0.0/16", Gateway: "172.18.0.1" }] } },
    { Driver: "bridge", IPAM: { Config: [{ Subnet: "172.17.0.0/16" }] } },
    // A macvlan network hands out addresses on the real LAN, so it says nothing about who's a container.
    { Driver: "macvlan", IPAM: { Config: [{ Subnet: "192.168.1.0/24", Gateway: "192.168.1.1" }] } },
  ]);

  it("a container calling Gluon directly is away", () => {
    expect(clientInfo(h({ [PEER_HEADER]: "172.18.0.9", "x-forwarded-for": "172.18.0.9" }))).toEqual({ ip: "172.18.0.9", zone: "away" });
  });

  it("a container going through Caddy is away too", () => {
    expect(clientInfo(h({ [PEER_HEADER]: "172.18.0.5", "x-forwarded-for": "172.17.0.4" }))).toEqual({ ip: "172.17.0.4", zone: "away" });
  });

  it("Caddy passing on someone at home keeps them home, as does this machine via a network's gateway", () => {
    expect(clientInfo(h({ [PEER_HEADER]: "172.18.0.5", "x-forwarded-for": "192.168.1.30" }))).toEqual({ ip: "192.168.1.30", zone: "home" });
    expect(clientInfo(h({ [PEER_HEADER]: "172.18.0.5", "x-forwarded-for": "172.18.0.1" }))).toEqual({ ip: "172.18.0.1", zone: "home" });
    expect(clientInfo(h({ [PEER_HEADER]: "172.18.0.5", "x-forwarded-for": "172.17.0.1" }))).toEqual({ ip: "172.17.0.1", zone: "home" });
  });
});
