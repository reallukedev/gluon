import { describe, expect, test } from "vitest";
import { reachVerdict, type ReachProbe } from "./reach-verdict";
import type { ReachOutcome } from "@/lib/network-types";

const c2s = (outside: ReachOutcome | null, lan = true): ReachProbe => ({ port: 5222, proto: "tcp", label: "Chat apps sign in", primary: true, lan, outside });
const s2s = (outside: ReachOutcome | null, lan = true): ReachProbe => ({ port: 5269, proto: "tcp", label: "Other chat servers", primary: false, lan, outside });
const base = { publicIp: "203.0.113.7", lanIp: "192.168.1.230", gateway: "192.168.1.1", checkedAt: 1, probed: true };

describe("can people outside reach the chat and voice ports", () => {
  test("names the port the router doesn't forward when another port on the same address gets through", () => {
    const r = reachVerdict({ ...base, ports: [c2s("none"), s2s("same")], controls: [] });
    expect(r.state).toBe("blocked");
    expect(r.hairpin).toBe(true);
    expect(r.ports.map((p) => p.verdict)).toEqual(["not-forwarded", "reachable"]);
    expect(r.ports[0]!.message).toBe("Your router isn't forwarding TCP port 5222 to this server. In its settings (usually at http://192.168.1.1), forward TCP 5222 to 192.168.1.230.");
    expect(r.summary).toMatch(/isn't forwarding port 5222 \(chat apps sign in\)/);
  });

  test("a forwarded web port is enough to show the router lets devices inside use the public address", () => {
    const r = reachVerdict({ ...base, ports: [c2s("none"), s2s("none")], controls: ["same"] });
    expect(r.ports.map((p) => p.verdict)).toEqual(["not-forwarded", "not-forwarded"]);
    expect(r.summary).toMatch(/ports 5222 \(chat apps sign in\) and 5269 \(other chat servers\)/);
  });

  test("says it can't tell, rather than blaming the router, when nothing answers on the public address at all", () => {
    const r = reachVerdict({ ...base, ports: [c2s("none"), s2s("none")], controls: ["none"] });
    expect(r.state).toBe("unknown");
    expect(r.hairpin).toBe(false);
    expect(r.ports.every((p) => p.verdict === "unknown")).toBe(true);
    expect(r.summary).toMatch(/can't tell from inside.*mobile data/);
  });

  test("something other than this server answering means the router sends the port elsewhere", () => {
    const r = reachVerdict({ ...base, ports: [c2s("other"), s2s("same")], controls: [] });
    expect(r.state).toBe("blocked");
    expect(r.ports[0]).toMatchObject({ verdict: "elsewhere", message: expect.stringMatching(/another device; point it at 192\.168\.1\.230/) });
  });

  test("a port that doesn't answer inside either isn't blamed on the router", () => {
    const r = reachVerdict({ ...base, ports: [c2s("none", false), s2s("same")], controls: [] });
    expect(r.ports[0]!.verdict).toBe("down");
    expect(r.state).toBe("ok");
  });

  test("UDP that doesn't get through is reported as UDP, even when the same TCP port does", () => {
    const r = reachVerdict({
      ...base,
      ports: [
        { port: 64738, proto: "tcp", label: "Mumble", primary: true, lan: true, outside: "same" },
        { port: 64738, proto: "udp", label: "Mumble voice (UDP)", primary: false, lan: true, outside: "none" },
      ],
      controls: [],
    });
    expect(r.state).toBe("blocked");
    expect(r.ports[1]!.message).toMatch(/forward UDP 64738/);
  });

  test("without the public address it can't check, and says why", () => {
    const r = reachVerdict({ ...base, publicIp: null, ports: [c2s(null)], controls: [] });
    expect(r).toMatchObject({ state: "unknown", hairpin: null, summary: expect.stringMatching(/doesn't know this network's public address/) });
  });

  test("everything getting through is fine", () => {
    const r = reachVerdict({ ...base, ports: [c2s("same"), s2s("same")], controls: ["same"] });
    expect(r).toMatchObject({ state: "ok", summary: "People outside reach ports 5222 and 5269 through your router." });
  });
});
