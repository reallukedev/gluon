import { describe, expect, it, vi } from "vitest";

vi.mock("./settings", () => ({ getSetting: (k: string) => (k === "homeNetworks" ? [] : "") }));
const { clientInfo, PEER_HEADER } = await import("./net-zone");

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
