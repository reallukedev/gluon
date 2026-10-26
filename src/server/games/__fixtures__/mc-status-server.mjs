// A stand-in Minecraft server that only answers the server list: the modern status exchange
// (handshake, status request, ping) and the pre-1.7 legacy ping. Written straight from the
// protocol description, separately from Gluon's client, so tests check one against the other.
// Used by the tests and, as `node mc-status-server.mjs`, as the game servers in the sandbox
// (SERVERS='[{"port":25566,"motd":"Survival"}]').
import net from "node:net";

function readVarInt(buf, at) {
  let v = 0;
  for (let i = 0; i < 5; i++) {
    if (at + i >= buf.length) return null;
    const b = buf[at + i];
    v |= (b & 0x7f) << (7 * i);
    if (!(b & 0x80)) return [v | 0, i + 1];
  }
  throw new Error("bad varint");
}

function varInt(n) {
  const out = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

function frame(id, body) {
  const inner = Buffer.concat([varInt(id), body]);
  return Buffer.concat([varInt(inner.length), inner]);
}

function utf16be(s) {
  return Buffer.from(s, "utf16le").swap16();
}

/**
 * Start one server. `opts`: port, motd, version ("1.21.10"), protocol, online, max, players
 * (names), legacy (answer only the old ping, like a 1.6 server), favicon, padding (extra bytes of
 * JSON, for long replies), split (send the reply a few bytes at a time). Resolves with
 * { port, close, seen } where `seen` lists the addresses players' handshakes named.
 */
export function startStatusServer(opts = {}) {
  const seen = [];
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let state = "handshake";
    const send = (b) => {
      if (!opts.split) return sock.write(b);
      // A byte at a time through the length, then in larger pieces.
      let i = 0;
      const step = () => {
        if (i >= b.length) return;
        const n = i < 4 ? 1 : 4096;
        sock.write(b.subarray(i, i + n));
        i += n;
        setTimeout(step, 2);
      };
      step();
    };
    sock.on("error", () => {});
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (state === "handshake" && buf[0] === 0xfe) {
        // Legacy ping: FE 01 FA "MC|PingHost" … host; reply with a 0xFF kick carrying the status.
        if (buf.length < 3) return;
        let host = "";
        if (buf.length > 5 && buf[2] === 0xfa) {
          const tag = buf.readUInt16BE(3);
          const restAt = 5 + tag * 2 + 2 + 1;
          if (buf.length >= restAt + 2) {
            const hl = buf.readUInt16BE(restAt);
            if (buf.length >= restAt + 2 + hl * 2) host = Buffer.from(buf.subarray(restAt + 2, restAt + 2 + hl * 2)).swap16().toString("utf16le");
          }
        }
        seen.push(host);
        const text = ["§1", String(opts.protocol ?? 78), opts.version ?? "1.6.4", opts.motd ?? "A Minecraft Server", String(opts.online ?? 0), String(opts.max ?? 20)].join("\0");
        const len = Buffer.alloc(2);
        len.writeUInt16BE(text.length);
        send(Buffer.concat([Buffer.from([0xff]), len, utf16be(text)]));
        setTimeout(() => sock.end(), 20);
        return;
      }
      for (;;) {
        const len = readVarInt(buf, 0);
        if (!len || buf.length < len[1] + len[0]) return;
        const body = buf.subarray(len[1], len[1] + len[0]);
        buf = buf.subarray(len[1] + len[0]);
        const [id, idSize] = readVarInt(body, 0);
        if (state === "handshake") {
          if (opts.legacy) {
            // What a 1.6 server does with a packet it doesn't know: kick with a message.
            const text = "Outdated client!";
            const l = Buffer.alloc(2);
            l.writeUInt16BE(text.length);
            sock.end(Buffer.concat([Buffer.from([0xff]), l, utf16be(text)]));
            return;
          }
          let at = idSize;
          const [, pv] = readVarInt(body, at);
          at += pv;
          const [hl, hs] = readVarInt(body, at);
          at += hs;
          seen.push(body.subarray(at, at + hl).toString("utf8"));
          at += hl + 2;
          const [next] = readVarInt(body, at);
          state = next === 1 ? "status" : "login";
          if (state === "login") return sock.end();
        } else if (id === 0x00) {
          const json = {
            version: { name: opts.version ?? "1.21.10", protocol: opts.protocol ?? 773 },
            players: { online: opts.online ?? 0, max: opts.max ?? 20, sample: (opts.players ?? []).map((name, i) => ({ name, id: `00000000-0000-0000-0000-00000000000${i}` })) },
            description: opts.description ?? { text: "", extra: [{ text: opts.motd ?? "A Minecraft Server", color: "gold" }] },
            ...(opts.favicon ? { favicon: opts.favicon } : {}),
            ...(opts.padding ? { modinfo: { type: "FML", modList: [{ modid: "x".repeat(opts.padding), version: "1" }] } } : {}),
          };
          const s = Buffer.from(JSON.stringify(json), "utf8");
          send(frame(0x00, Buffer.concat([varInt(s.length), s])));
        } else if (id === 0x01) {
          send(frame(0x01, body.subarray(idSize, idSize + 8)));
          setTimeout(() => sock.end(), 20);
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, "0.0.0.0", () => resolve({ port: server.address().port, seen, close: () => new Promise((r) => server.close(() => r())) }));
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const servers = JSON.parse(process.env.SERVERS ?? "[]");
  for (const s of servers) {
    const { port } = await startStatusServer(s);
    console.log(`status server "${s.motd}" on ${port}${s.legacy ? " (legacy)" : ""}`);
  }
}
