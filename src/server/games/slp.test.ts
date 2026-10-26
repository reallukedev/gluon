import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { decodeResponse, decodeVarInt, encodeVarInt, parseLegacyText } from "./slp";
import { slpPing } from "./ping";
import { startStatusServer } from "./__fixtures__/mc-status-server.mjs";

const open: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});
async function server(opts: Parameters<typeof startStatusServer>[0]) {
  const s = await startStatusServer(opts);
  open.push(s);
  return s;
}

describe("VarInt", () => {
  // Values and bytes from the protocol's own table of examples.
  const cases: [number, number[]][] = [
    [0, [0x00]],
    [127, [0x7f]],
    [128, [0x80, 0x01]],
    [255, [0xff, 0x01]],
    [25565, [0xdd, 0xc7, 0x01]],
    [2097151, [0xff, 0xff, 0x7f]],
    [2147483647, [0xff, 0xff, 0xff, 0xff, 0x07]],
    [-1, [0xff, 0xff, 0xff, 0xff, 0x0f]],
    [-2147483648, [0x80, 0x80, 0x80, 0x80, 0x08]],
  ];
  it.each(cases)("%i is %j", (n, bytes) => {
    expect([...encodeVarInt(n)]).toEqual(bytes);
    expect(decodeVarInt(Buffer.from(bytes))).toEqual({ value: n, size: bytes.length });
  });

  it("waits for more bytes, and refuses a sixth", () => {
    expect(decodeVarInt(Buffer.from([0xdd, 0xc7]))).toBeNull();
    expect(() => decodeVarInt(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0x01]))).toThrow();
  });
});

describe("Server List Ping against a stand-in server", () => {
  it("sends the typed address in the handshake and reads version, players and a formatted MOTD", async () => {
    const s = await server({ version: "Paper 1.21.10", online: 3, max: 20, players: ["alex", "§csteve"], description: { text: "§6Survival ", extra: [{ text: "Island\n" }, { text: "  §7come   play " }] } });
    const p = await slpPing("127.0.0.1", s.port, "survival.mc.example.com");
    expect(s.seen).toEqual(["survival.mc.example.com"]);
    expect(p).toMatchObject({ ok: true, version: "Paper 1.21.10", protocol: 773, online: 3, max: 20, players: ["alex", "steve"], motd: "Survival Island\ncome play", error: null });
  });

  it("reads a long reply that arrives a few bytes at a time", async () => {
    // A modpack's mod list pushes the JSON past 16 KiB, so its length takes three VarInt bytes.
    const s = await server({ motd: "Modded", padding: 40_000, split: true });
    const p = await slpPing("127.0.0.1", s.port, "modded.mc.example.com", 10_000);
    expect(p.ok).toBe(true);
    expect(p.motd).toBe("Modded");
  });

  it("falls back to the 1.6 ping for servers that kick the modern one", async () => {
    const s = await server({ legacy: true, version: "1.6.4", motd: "Old §aworld", online: 1, max: 8 });
    const p = await slpPing("127.0.0.1", s.port, "beta.mc.example.com");
    expect(p).toMatchObject({ ok: true, version: "1.6.4", protocol: 78, motd: "Old world", online: 1, max: 8 });
    // The legacy ping carries the address too, so mc-router can still route it.
    expect(s.seen).toEqual(["beta.mc.example.com"]);
  });

  it("says plainly when nothing answers or the reply isn't a status", async () => {
    const closed = await new Promise<number>((r) => {
      const srv = net.createServer().listen(0, "127.0.0.1", () => {
        const port = (srv.address() as net.AddressInfo).port;
        srv.close(() => r(port));
      });
    });
    expect((await slpPing("127.0.0.1", closed, "x.example.com")).error).toBe("nothing is listening on that port");

    // What mc-router does when the server behind an address is down: accept, then hang up.
    const hangup = net.createServer((sock) => sock.on("data", () => sock.destroy())).listen(0, "127.0.0.1");
    await new Promise((r) => hangup.once("listening", r));
    open.push({ close: () => new Promise((r) => hangup.close(() => r())) });
    const p = await slpPing("127.0.0.1", (hangup.address() as net.AddressInfo).port, "x.example.com");
    expect(p).toMatchObject({ ok: false, error: "the connection closed without an answer" });
  });
});

describe("replies decoded directly", () => {
  it("rejects JSON that isn't a status, and packets that aren't one", () => {
    const body = Buffer.from("{not json", "utf8");
    const inner = Buffer.concat([Buffer.from([0x00]), encodeVarInt(body.length), body]);
    expect(decodeResponse(Buffer.concat([encodeVarInt(inner.length), inner]))).toEqual({ kind: "error", message: "the status reply isn't valid JSON" });
    expect(decodeResponse(Buffer.from([0x02, 0x05, 0x00]))).toMatchObject({ kind: "error" });
  });

  it("reads the Beta 1.8 to 1.3 reply, which has no version", () => {
    expect(parseLegacyText("A §lclassic§r server§2§10")).toMatchObject({ version: null, motd: "A classic server", online: 2, max: 10 });
    expect(parseLegacyText("Outdated client!")).toBeNull();
  });
});
