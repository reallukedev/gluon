import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import crypto from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import { judgeSrv, probeXmpp } from "./xmpp-probe";

const certs = path.join(__dirname, "../../../test/fixtures/certs");
const key = fs.readFileSync(path.join(certs, "long.key"));
const cert = fs.readFileSync(path.join(certs, "long.crt"));
const DOMAIN = "chat.example.test";

const STREAM = "<?xml version='1.0'?><stream:stream xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' id='s1' from='chat.example.test' version='1.0'>";
const TLS_FEATURE = "<starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'><required/></starttls>";

interface Behaviour {
  /** Sent instead of features on the first stream. */
  first?: string;
  /** Features offered once encrypted. */
  secure?: string;
}

const servers: net.Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

/** A chat server that speaks just enough XMPP: features, STARTTLS, and a restarted stream. */
async function fakeServer(b: Behaviour): Promise<number> {
  const server = net.createServer((sock) => {
    let buf = "";
    const onPlain = (d: Buffer) => {
      buf += d.toString();
      if (buf.includes("<stream:stream") && !buf.includes("<starttls")) {
        if (!buf.includes("sent")) {
          buf += "sent";
          sock.write(STREAM + (b.first ?? `<stream:features>${TLS_FEATURE}</stream:features>`));
        }
        return;
      }
      if (buf.includes("<starttls")) {
        sock.removeListener("data", onPlain);
        sock.write("<proceed xmlns='urn:ietf:params:xml:ns:xmpp-tls'/>", () => {
          const secure = new tls.TLSSocket(sock, { isServer: true, key, cert });
          secure.on("data", (d) => {
            if (d.toString().includes("<stream:stream")) secure.write(STREAM + `<stream:features>${b.secure ?? "<mechanisms xmlns='urn:ietf:params:xml:ns:xmpp-sasl'><mechanism>PLAIN</mechanism></mechanisms>"}</stream:features>`);
          });
          secure.on("error", () => undefined);
        });
      }
    };
    sock.on("data", onPlain);
    sock.on("error", () => undefined);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as net.AddressInfo).port;
}

const probe = (port: number, kind: "client" | "server" = "client") => probeXmpp({ host: "127.0.0.1", port, domain: DOMAIN, kind, certDays: 14, timeoutMs: 3000 });

describe("probing a chat server", () => {
  test("reads the certificate presented after STARTTLS and sees open sign-up", async () => {
    const port = await fakeServer({ secure: `<register xmlns='http://jabber.org/features/iq-register'/><mechanisms xmlns='urn:ietf:params:xml:ns:xmpp-sasl'/>` });
    const r = await probe(port);
    expect(r).toMatchObject({ reachable: true, error: null, openRegistration: true });
    expect(r.tls).toMatchObject({ servername: DOMAIN, status: "invalid", names: [DOMAIN], fingerprint: new crypto.X509Certificate(cert).fingerprint256 });
    expect(r.tls!.message).toMatch(/self-signed/);
  });

  test("closed sign-up when the encrypted stream doesn't offer registration", async () => {
    expect((await probe(await fakeServer({}))).openRegistration).toBe(false);
  });

  test("federation probes stop once encrypted", async () => {
    const r = await probe(await fakeServer({}), "server");
    expect(r).toMatchObject({ reachable: true, error: null, openRegistration: null });
    expect(r.tls?.fingerprint).toBeTruthy();
  });

  test.each([
    ["the domain isn't hosted", "<stream:error><host-unknown xmlns='urn:ietf:params:xml:ns:xmpp-streams'/></stream:error>", /doesn't host chat\.example\.test/],
    ["encryption isn't offered", "<stream:features><mechanisms xmlns='urn:ietf:params:xml:ns:xmpp-sasl'/></stream:features>", /doesn't offer encryption/],
  ])("explains it when %s", async (_, first, msg) => {
    const r = await probe(await fakeServer({ first }));
    expect(r.reachable).toBe(true);
    expect(r.error).toMatch(msg);
    expect(r.tls).toBeNull();
  });

  test("a closed port is unreachable, not a protocol error", async () => {
    const port = await fakeServer({});
    servers.splice(0).forEach((s) => s.close());
    const r = await probe(port);
    expect(r).toMatchObject({ reachable: false, error: "nothing is listening there" });
  });
});

describe("judging SRV records", () => {
  const rec = (port: number, target = DOMAIN, priority = 0) => ({ target, port, priority, weight: 0 });
  test.each([
    ["no record on the standard port is fine", [], 5222, "missing"],
    ["no record on another port strands apps", [], 5223, "mismatch"],
    ["a record for the right port", [rec(5222)], 5222, "ok"],
    ["a record for the wrong port", [rec(5223)], 5222, "mismatch"],
    ["a record that turns the service off", [rec(0, ".")], 5222, "mismatch"],
    ["federation off with nothing advertised", [], null, "ok"],
  ] as const)("%s", (_, records, port, status) => {
    expect(judgeSrv(`_xmpp-client._tcp.${DOMAIN}`, [...records], DOMAIN, port, 5222, "Signing in from chat apps").status).toBe(status);
  });
});
