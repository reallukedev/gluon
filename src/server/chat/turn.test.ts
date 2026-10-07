import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { coturnRecipe, isStunAnswer, newTurnSecret, stunRequest } from "./turn";

const compose = coturnRecipe({ domain: "chat.example.com", lanIp: "192.168.1.230" }).compose;
const args = [...compose.matchAll(/^\s+- "(.+)"$/gm)].map((m) => m[1]!);

describe("the call relay's recipe", () => {
  it("never relays into the home network, the server itself or other private ranges", () => {
    const denied = args.filter((a) => a.startsWith("--denied-peer-ip=")).map((a) => a.split("=")[1]);
    for (const range of ["10.0.0.0-10.255.255.255", "172.16.0.0-172.31.255.255", "192.168.0.0-192.168.255.255", "127.0.0.0-127.255.255.255", "100.64.0.0-100.127.255.255", "169.254.0.0-169.254.255.255", "::1"]) {
      expect(denied).toContain(range);
    }
  });

  it("leaves the secret and the public address for coturn to expand, not Docker Compose", () => {
    // A single $ would be substituted (with nothing) by Compose before coturn starts.
    expect(args).toContain("--static-auth-secret=$$TURN_SECRET");
    expect(args).toContain("--external-ip=$$(detect-external-ip)/192.168.1.230");
    expect(compose).not.toMatch(/[^$]\$TURN_SECRET/);
  });

  it("only hands out expiring logins signed with the shared secret, with no TLS it can't renew", () => {
    expect(args).toEqual(expect.arrayContaining(["--use-auth-secret", "--no-cli", "--no-tls", "--no-dtls", "--realm=chat.example.com"]));
    expect(args.some((a) => a.startsWith("--user=") || a === "--lt-cred-mech")).toBe(false);
  });

  it("makes secrets the entrypoint's shell can't misread", () => {
    expect(newTurnSecret()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the STUN check", () => {
  it("asks with a 20-byte binding request and only believes the answer to it", () => {
    const id = crypto.randomBytes(12);
    const req = stunRequest(id);
    expect(req.length).toBe(20);
    expect(req.readUInt16BE(0)).toBe(0x0001);
    const answer = Buffer.from(req);
    answer.writeUInt16BE(0x0101, 0);
    expect(isStunAnswer(answer, id)).toBe(true);
    expect(isStunAnswer(answer, crypto.randomBytes(12))).toBe(false);
    expect(isStunAnswer(req, id)).toBe(false);
  });
});
