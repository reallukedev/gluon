import crypto from "node:crypto";
import dgram from "node:dgram";
import type { AppSpec } from "@/lib/builder-types";

/**
 * Calls across networks: a TURN relay (coturn) next to Prosody. Two phones on different networks
 * often can't reach each other directly, so the relay carries the call. Prosody tells chat apps
 * where it is and hands each one short-lived credentials signed with a secret shared with coturn
 * (XEP-0215, mod_turn_external). Pure parts here: the app recipe and the STUN check's messages.
 */

export const COTURN_IMAGE = "coturn/coturn:4.6";
export const TURN_PORT = 3478;
/** Relay ports. Each call uses a couple; forty is plenty for a household. */
export const RELAY_PORTS = { min: 49160, max: 49200 } as const;
/** Where Prosody finds the shared secret: its own data folder, readable only by Prosody. */
export const PROSODY_TURN_SECRET = "/var/lib/prosody/gluon-turn-secret";

/** Hex only: coturn's entrypoint runs its arguments through the shell. */
export const newTurnSecret = () => crypto.randomBytes(32).toString("hex");

// The relay must never become a way into the home network or the server itself.
const DENIED = [
  "0.0.0.0-0.255.255.255",
  "10.0.0.0-10.255.255.255",
  "100.64.0.0-100.127.255.255",
  "127.0.0.0-127.255.255.255",
  "169.254.0.0-169.254.255.255",
  "172.16.0.0-172.31.255.255",
  "192.0.0.0-192.0.0.255",
  "192.168.0.0-192.168.255.255",
  "198.18.0.0-198.19.255.255",
  "224.0.0.0-255.255.255.255",
  "::1",
  "fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  "fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
];

export function coturnRecipe(a: { domain: string; lanIp: string }): AppSpec {
  const args = [
    "--log-file=stdout",
    `--listening-port=${TURN_PORT}`,
    `--listening-ip=${a.lanIp}`,
    `--relay-ip=${a.lanIp}`,
    // The public address (looked up when it starts) mapped to this server's, since the router NATs.
    // $$ so Compose leaves these for coturn's entrypoint to expand when it starts.
    `--external-ip=$$(detect-external-ip)/${a.lanIp}`,
    `--min-port=${RELAY_PORTS.min}`,
    `--max-port=${RELAY_PORTS.max}`,
    "--use-auth-secret",
    "--static-auth-secret=$$TURN_SECRET",
    `--realm=${a.domain}`,
    "--fingerprint",
    "--no-tls",
    "--no-dtls",
    "--no-cli",
    "--no-multicast-peers",
    "--no-software-attribute",
    "--user-quota=12",
    "--total-quota=120",
    ...DENIED.map((r) => `--denied-peer-ip=${r}`),
  ];
  const compose = `# Relay for voice and video calls in chat apps, set up by Gluon for ${a.domain}.
# Prosody hands chat apps short-lived logins for it. Your router has to forward UDP and TCP
# ${TURN_PORT}, and UDP ${RELAY_PORTS.min}-${RELAY_PORTS.max}, to this server.
services:
  turn:
    image: ${COTURN_IMAGE}
    restart: unless-stopped
    # Relaying needs many ports and the real addresses, so it uses the server's own network.
    network_mode: host
    command:
${args.map((x) => `      - "${x}"`).join("\n")}
`;
  return {
    details: {
      name: "Call relay",
      slug: "call-relay",
      tagline: `Voice and video calls for ${a.domain}`,
      description: "coturn, a TURN server. Chat apps use it when two people can't connect to each other directly, like between two homes or on mobile data.",
      category: "social",
      icon: null,
      website: "https://github.com/coturn/coturn",
      support: "https://github.com/coturn/coturn/wiki",
      developer: "coturn",
      version: "4.6",
      releaseNotes: "",
    },
    web: { service: null, containerPort: null, port: null, path: "", umbrelAuth: false },
    compose,
  };
}

// ---------------------------------------------------------------- STUN check

const MAGIC = 0x2112a442;

/** A STUN Binding Request (RFC 5389): 20 bytes, no attributes. */
export function stunRequest(id: Buffer): Buffer {
  const b = Buffer.alloc(20);
  b.writeUInt16BE(0x0001, 0);
  b.writeUInt16BE(0, 2);
  b.writeUInt32BE(MAGIC, 4);
  id.copy(b, 8, 0, 12);
  return b;
}

/** A Binding Success Response to our request, by type, cookie and transaction id. */
export function isStunAnswer(msg: Buffer, id: Buffer): boolean {
  return msg.length >= 20 && msg.readUInt16BE(0) === 0x0101 && msg.readUInt32BE(4) === MAGIC && msg.subarray(8, 20).equals(id.subarray(0, 12));
}

/** Does a STUN server answer at host:port over UDP? Two tries, a second apart. */
export function stunAnswers(host: string, port = TURN_PORT, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket(host.includes(":") ? "udp6" : "udp4");
    const id = crypto.randomBytes(12);
    const req = stunRequest(id);
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(t1);
      clearTimeout(t2);
      sock.close();
      resolve(ok);
    };
    sock.on("message", (m) => isStunAnswer(m, id) && finish(true));
    sock.on("error", () => finish(false));
    const send = () => sock.send(req, port, host, () => undefined);
    send();
    const t1 = setTimeout(send, 1000);
    const t2 = setTimeout(() => finish(false), timeoutMs);
  });
}
