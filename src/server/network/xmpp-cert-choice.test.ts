import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { certInfo, decideCopy, pickCaddyPair } from "./xmpp-cert-choice";
import { readTar, writeTar } from "./tarball";

const dir = path.join(__dirname, "../../../test/fixtures/certs");
const pem = (n: string) => fs.readFileSync(path.join(dir, n));
const HOST = "chat.example.test";
const long = certInfo(pem("long.crt"), HOST)!;
const short = certInfo(pem("short.crt"), HOST)!;

/** A tarball laid out like Caddy's /data/caddy/certificates. */
function caddyArchive(files: [issuer: string, host: string, crt: string, key: string][]) {
  return readTar(
    writeTar(
      files.flatMap(([issuer, host, crt, key]) => [
        { name: `certificates/${issuer}/${host}/${host}.crt`, data: pem(crt), mode: 0o600, uid: 0, gid: 0 },
        { name: `certificates/${issuer}/${host}/${host}.key`, data: pem(key), mode: 0o600, uid: 0, gid: 0 },
      ]),
    ),
  );
}

describe("picking Caddy's certificate", () => {
  test("takes the longest-lasting pair for the host across issuers", () => {
    const entries = caddyArchive([
      ["acme-v02.api.letsencrypt.org-directory", HOST, "short.crt", "short.key"],
      ["acme.zerossl.com-v2-dv90", HOST, "long.crt", "long.key"],
      ["acme-v02.api.letsencrypt.org-directory", "other.example.test", "other.crt", "other.key"],
    ]);
    expect(pickCaddyPair(entries, HOST)?.info.fingerprint).toBe(long.fingerprint);
  });

  test("skips a certificate whose key doesn't match, even when it lasts longer", () => {
    const entries = caddyArchive([
      ["acme.zerossl.com-v2-dv90", HOST, "long.crt", "short.key"],
      ["acme-v02.api.letsencrypt.org-directory", HOST, "short.crt", "short.key"],
    ]);
    expect(pickCaddyPair(entries, HOST)?.info.fingerprint).toBe(short.fingerprint);
  });

  test("never takes Caddy's internal CA certificates or a self-signed one", () => {
    const entries = caddyArchive([
      ["local", HOST, "long.crt", "long.key"],
      ["acme-v02.api.letsencrypt.org-directory", HOST, "selfsigned.crt", "selfsigned.key"],
    ]);
    expect(pickCaddyPair(entries, HOST)).toBeNull();
  });

  test("finds nothing when Caddy only has other names", () => {
    expect(pickCaddyPair(caddyArchive([["le", "other.example.test", "other.crt", "other.key"]]), HOST)).toBeNull();
  });
});

describe("deciding whether to copy", () => {
  const other = certInfo(pem("other.crt"), HOST)!;
  const DAY = 86_400_000;
  const renewedElsewhere = { ...long, fingerprint: "certbot", notAfter: long.notAfter - 5 * DAY };
  test.each([
    ["Caddy has none and the chat server's is about to expire", null, short, false, false],
    ["the chat server already has Caddy's", long, long, false, true],
    ["another tool keeps the chat server's valid, even if Caddy's lasts longer", long, renewedElsewhere, false, true],
    ["the chat server's is about to expire and Caddy's is fresh", long, short, true, true],
    ["the chat server's is about to expire and Caddy has nothing newer", { ...short, fingerprint: "other" }, short, false, false],
    ["the chat server has none", short, null, true, true],
    ["the chat server's names another host", short, other, true, true],
  ])("when %s", (_, src, dst, copy, ok) => {
    const d = decideCopy(src, dst, HOST);
    expect(d.copy).toBe(copy);
    if (!d.copy) expect(d.ok).toBe(ok);
  });

  test("replaces a certificate chat apps refuse, even one that lasts a year", () => {
    expect(decideCopy(short, certInfo(pem("selfsigned.crt"), HOST), HOST)).toMatchObject({ copy: true, reason: expect.stringMatching(/isn't trusted/) });
    expect(decideCopy(short, long, HOST, Date.now(), false)).toMatchObject({ copy: true, reason: expect.stringMatching(/isn't trusted/) });
  });

  test("never copies a certificate that has expired or doesn't cover the host", () => {
    expect(decideCopy(long, null, HOST, long.notAfter + 1)).toMatchObject({ copy: false, ok: false });
    expect(decideCopy(certInfo(pem("other.crt"), HOST), null, HOST)).toMatchObject({ copy: false, ok: false });
  });
});

describe("tar for Docker's archive API", () => {
  test("files keep the owner and mode the chat server needs to read its key", () => {
    const [crt, key] = readTar(writeTar([
      { name: `${HOST}.crt`, data: pem("long.crt"), mode: 0o644, uid: 1000, gid: 102 },
      { name: `${HOST}.key`, data: pem("long.key"), mode: 0o600, uid: 1000, gid: 102 },
    ]));
    expect(crt).toMatchObject({ name: `${HOST}.crt`, type: "file", mode: 0o644, uid: 1000, gid: 102 });
    expect(key).toMatchObject({ mode: 0o600, uid: 1000, gid: 102 });
    expect(key!.data.equals(pem("long.key"))).toBe(true);
  });

  test("writes names longer than ustar allows, as a 253-character chat domain needs", () => {
    const host = `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.example.test`;
    const [key] = readTar(writeTar([{ name: `${host}.key`, data: pem("long.key"), mode: 0o600, uid: 1000, gid: 102 }]));
    expect(key).toMatchObject({ name: `${host}.key`, type: "file", mode: 0o600, uid: 1000, gid: 102 });
    expect(key!.data.equals(pem("long.key"))).toBe(true);
  });

  test("reads long paths from PAX headers", () => {
    const entries = readTar(fs.readFileSync(path.join(__dirname, "../../../test/fixtures/long-names.pax.tar")));
    const f = entries.find((e) => e.type === "file");
    expect(f?.name).toBe(`a/${"x".repeat(120)}/f.txt`);
    expect(f?.data.toString()).toBe("hi\n");
  });
});
