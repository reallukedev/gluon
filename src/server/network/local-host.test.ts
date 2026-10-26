import type os from "node:os";
import net from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";

const ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {};
const realIfaces = vi.hoisted(() => ({ list: {} as NodeJS.Dict<os.NetworkInterfaceInfo[]> }));
vi.mock("node:os", async (orig) => {
  const real = await orig<typeof import("node:os")>();
  realIfaces.list = real.networkInterfaces();
  return { ...real, default: { ...real, networkInterfaces: () => ifaces } };
});

const v4 = (address: string) => ({ address, family: "IPv4", internal: false, netmask: "255.255.0.0", mac: "02:42:00:00:00:00", cidr: null }) as os.NetworkInterfaceInfo;

afterEach(() => {
  for (const k of Object.keys(ifaces)) delete ifaces[k];
  delete (globalThis as { __gluonBridgeGw?: unknown }).__gluonBridgeGw;
  (globalThis as { __gluonBridgeAsk?: boolean }).__gluonBridgeAsk = true; // never reach for a real Docker
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("reaching this machine's ports", () => {
  test("a route to host.docker.internal is probed at the bridge gateway, like Caddy reaches it", async () => {
    ifaces.docker0 = [v4("172.17.0.1")];
    const { localBackendHost } = await import("./probes");
    expect(localBackendHost("host.docker.internal")).toBe("172.17.0.1");
    expect(localBackendHost("192.168.1.20")).toBe("192.168.1.20");
  });

  test("without a Docker bridge it falls back to loopback", async () => {
    (globalThis as { __gluonBridgeAsk?: boolean }).__gluonBridgeAsk = true;
    const { localBackendHost } = await import("./probes");
    expect(localBackendHost("host.docker.internal")).toBe("127.0.0.1");
  });

  test("GLUON_LOCAL_HOST still wins", async () => {
    ifaces.docker0 = [v4("172.17.0.1")];
    vi.stubEnv("GLUON_LOCAL_HOST", "10.0.0.5");
    const { localBackendHost, LOCAL_HOST } = await import("./probes");
    expect(localBackendHost("host.docker.internal")).toBe("10.0.0.5");
    expect(LOCAL_HOST).toBe("10.0.0.5");
  });

  test("a port published only on the bridge is probed there; others on loopback", async () => {
    const { listenProbeHost } = await import("./probes");
    expect(listenProbeHost(["172.17.0.1"])).toBe("172.17.0.1");
    expect(listenProbeHost(["0.0.0.0", "[::]"])).toBe("127.0.0.1");
    expect(listenProbeHost(["127.0.0.1"])).toBe("127.0.0.1");
    expect(listenProbeHost(["[::]"])).toBe("127.0.0.1");
  });

  test("an app published only on the bridge address counts as up, though loopback refuses it", async () => {
    await import("node:os"); // load the mock, which records the machine's real addresses
    const addr = Object.values(realIfaces.list).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
    if (!addr) return; // no non-loopback address to stand in for the bridge
    ifaces.docker0 = [v4(addr)];
    const server = net.createServer((s) => s.end());
    await new Promise<void>((r) => server.listen(0, addr, r));
    try {
      const port = (server.address() as net.AddressInfo).port;
      const { probeBackend, tcpConnect } = await import("./probes");
      expect((await tcpConnect("127.0.0.1", port, 1000)).ok).toBe(false);
      const r = await probeBackend("host.docker.internal", port);
      expect(r).toMatchObject({ reachable: true, error: null });
    } finally {
      server.close();
    }
  });
});
