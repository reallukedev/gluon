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
