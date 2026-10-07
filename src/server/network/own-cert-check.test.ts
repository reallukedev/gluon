import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { checkOwnCert } from "./own-cert-check";

const dir = path.join(__dirname, "../../../test/fixtures/certs");
const pem = (n: string) => fs.readFileSync(path.join(dir, n), "utf8");
const HOST = "chat.example.test";
// long.crt is valid 2026-10-07 to 2027-01-05, short.crt until 2026-10-17; both signed by ca.crt.
const NOV = Date.parse("2026-11-01T00:00:00Z");

describe("a certificate someone supplies", () => {
  test.each([
    ["it's for another name", pem("long.crt"), pem("long.key"), "other.example.test", NOV, "cert", /for chat\.example\.test, not other\.example\.test/],
    ["the key belongs to another certificate", pem("long.crt"), pem("short.key"), HOST, NOV, "key", /doesn't belong/],
    ["it has expired", pem("long.crt"), pem("long.key"), HOST, Date.parse("2027-02-01T00:00:00Z"), "cert", /expired on 2027-01-05/],
    ["it isn't valid yet", pem("long.crt"), pem("long.key"), HOST, Date.parse("2026-01-01T00:00:00Z"), "cert", /only becomes valid on 2026-10-07/],
    ["the key was pasted where the certificate goes", pem("long.key"), pem("long.key"), HOST, NOV, "cert", /This is a private key/],
    ["the certificate was pasted where the key goes", pem("long.crt"), pem("long.crt"), HOST, NOV, "key", /This is a certificate, not a private key/],
    ["the key is locked with a passphrase", pem("long.crt"), "-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIB\n-----END ENCRYPTED PRIVATE KEY-----\n", HOST, NOV, "key", /passphrase/],
    ["the certificate is cut short", pem("long.crt").replace(/\n[A-Za-z0-9+/=]+\n-----END/, "\n-----END"), pem("long.key"), HOST, NOV, "cert", /couldn't be read/],
    ["nothing was pasted", "", pem("long.key"), HOST, NOV, "cert", /Paste the certificate/],
  ])("is refused when %s", (_, cert, key, host, now, field, message) => {
    const r = checkOwnCert(cert, key, host, now);
    expect(r).toMatchObject({ ok: false, field });
    expect(!r.ok && r.message).toMatch(message);
  });

  test("puts the certificate for the key first, whatever order the chain came in", () => {
    const r = checkOwnCert(`${pem("ca.crt")}\n${pem("long.crt")}`, pem("long.key"), HOST, NOV);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.crt.indexOf(pem("long.crt").trim())).toBe(0);
    expect(r.crt).toContain(pem("ca.crt").trim());
    expect(r.info).toMatchObject({ names: [HOST], issuer: "Gluon Test CA", selfSigned: false, warnings: [] });
  });

  test("warns when it ends soon, since Gluon can't renew it, and when the chain is missing", () => {
    const r = checkOwnCert(pem("short.crt"), pem("short.key"), HOST, Date.parse("2026-10-10T04:00:00Z"));
    expect(r.ok && r.info.warnings).toEqual([expect.stringMatching(/ends in 7 days.*can't renew/), expect.stringMatching(/full chain/)]);
  });

  test("accepts a self-signed certificate but says browsers will warn", () => {
    const r = checkOwnCert(pem("selfsigned.crt"), pem("selfsigned.key"), HOST, NOV);
    expect(r.ok && r.info.warnings).toEqual([expect.stringMatching(/self-signed/)]);
  });
});
