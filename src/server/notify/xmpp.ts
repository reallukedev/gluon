import "server-only";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import type { TLSSocket } from "node:tls";
import { Client, xml } from "@xmpp/client-core";
import type { Element } from "@xmpp/xml";
import _middleware from "@xmpp/middleware";
import _streamFeatures from "@xmpp/stream-features";
import _iqCaller from "@xmpp/iq/caller.js";
import _sasl from "@xmpp/sasl";
import _resourceBinding from "@xmpp/resource-binding";
import _tcp from "@xmpp/tcp";
import TLSSocketWrapper from "@xmpp/tls/lib/Socket.js";
import { promise } from "@xmpp/events";
import SASLFactory from "saslmechanisms";
import scramsha1 from "@xmpp/sasl-scram-sha-1";
import plain from "@xmpp/sasl-plain";
import { AppError } from "../errors";
import { listApps } from "../docker/apps";
import { prosodyFor, prosodyLua, chatSnapshot } from "../chat/prosody";
import type { XmppConfig, XmppServersResponse } from "@/lib/alerts-types";
import { DeliveryError } from "./transports";
import { xmppText, splitServer, XMPP_SENDER as SENDER, type XmppOut } from "./xmpp-format";

/**
 * XMPP channels. Two ways to send:
 *  - server: through a Prosody that Gluon runs, from gluon@<domain>, injected with its admin console.
 *    No password; the account is created on first use with a random one nobody needs.
 *  - account: sign in to any XMPP account with xmpp.js, send, sign out. TLS is required; an
 *    untrusted certificate is refused unless the channel says to accept it.
 */

const TIMEOUT_MS = 20_000;
const PROSODY_IMAGE = /(^|\/)(prosody|prosodyim)\/|(^|\/)prosody(:|$)/i;

// ---------------------------------------------------------------- through this server's Prosody

const SEND_LUA = `local um=require"core.usermanager"; local st=require"util.stanza"; local id=require"util.id";
local host=prosody.hosts[A.domain]; if not host or host.type~="local" then error("NOHOST") end;
local created=false;
if not um.user_exists(A.user,A.domain) then local ok,err;
  if um.create_user_with_role then ok,err=um.create_user_with_role(A.user,A.password,A.domain,"prosody:registered") else ok,err=um.create_user(A.user,A.password,A.domain) end;
  if not ok then error("NOSENDER "..tostring(err)) end; created=true;
  local pep=host.modules.pep; if pep and pep.get_pep_service then pcall(function()
    local svc=pep.get_pep_service(A.user);
    svc:publish("http://jabber.org/protocol/nick", true, "current", st.stanza("item",{xmlns="http://jabber.org/protocol/pubsub",id="current"}):tag("nick",{xmlns="http://jabber.org/protocol/nick"}):text(A.name):up(), {["pubsub#access_model"]="open"});
  end) end;
end;
local from=A.user.."@"..A.domain.."/notify";
local missing={};
for _,to in ipairs(A.to) do local u,h=to:match("^([^@/]+)@([^/]+)"); local th=h and prosody.hosts[h];
  if th and th.type=="local" and not um.user_exists(u,h) then missing[#missing+1]=to else
  prosody.core_post_stanza(host, st.message({from=from,to=to,type="chat",id=id.medium()}):text_tag("body",A.text):tag("nick",{xmlns="http://jabber.org/protocol/nick"}):text(A.name):up()) end end;
for _,r in ipairs(A.rooms) do local h=r:match("@([^/]+)$"); local mh=h and prosody.hosts[h];
  local room=mh and mh.modules.muc and mh.modules.muc.get_room_from_jid(r);
  if not room then missing[#missing+1]=r else
  room:broadcast_message(st.message({from=r.."/"..A.nick,type="groupchat",id=id.medium()}):text_tag("body",A.text)) end end;
return {created=created, missing=missing}`;

async function sendThroughServer(c: XmppConfig, text: string): Promise<void> {
  if (!c.app || !c.domain) throw new DeliveryError("Choose the chat server and domain to send from.", true);
  let t;
  try {
    t = await prosodyFor(c.app);
  } catch (e) {
    const msg = e instanceof AppError ? e.message : (e as Error).message;
    throw new DeliveryError(`${msg}`, e instanceof AppError && e.code === "not_found");
  }
  let r: { created: boolean; missing: string[] | Record<string, never> };
  try {
    r = await prosodyLua(t, SEND_LUA, {
      domain: c.domain,
      user: SENDER,
      name: "Gluon",
      nick: c.nick,
      password: crypto.randomBytes(24).toString("base64url"),
      to: c.to,
      rooms: c.rooms,
      text,
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.startsWith("NOHOST")) throw new DeliveryError(`${t.app.name} doesn't serve ${c.domain} any more. Pick another domain.`, true);
    if (msg.startsWith("NOSENDER")) throw new DeliveryError(`${t.app.name} wouldn't create ${SENDER}@${c.domain} to send from: ${msg.slice(9)}`, true);
    throw new DeliveryError(`${t.app.name} couldn't send it: ${msg}`);
  }
  const missing = Array.isArray(r.missing) ? r.missing : [];
  if (missing.length) {
    const sent = c.to.length + c.rooms.length - missing.length;
    throw new DeliveryError(`${missing.join(", ")} ${missing.length === 1 ? "doesn't" : "don't"} exist on ${t.app.name}${sent ? `. The others got it` : ""}. Check the address${missing.length === 1 ? "" : "es"}.`, true);
  }
}

/** Chat servers Gluon runs, with their domains, accounts and group chats, for the channel form. */
export async function xmppServers(): Promise<XmppServersResponse> {
  const apps = (await listApps()).filter((a) => a.containers.some((c) => PROSODY_IMAGE.test(c.image)));
  const servers = await Promise.all(
    apps.map(async (a) => {
      const running = a.containers.some((c) => PROSODY_IMAGE.test(c.image) && c.state === "running");
      if (!running) return { app: a.id, name: a.name, running, problem: `${a.name} isn't running.`, domains: [] };
      try {
        const snap = await chatSnapshot(a.id);
        return {
          app: a.id,
          name: a.name,
          running,
          problem: null,
          domains: snap.hosts.map((h) => ({
            domain: h.host,
            accounts: h.accounts.map((x) => x.jid).filter((j) => !j.startsWith(`${SENDER}@`)),
            rooms: h.rooms.map((r) => r.jid),
          })),
        };
      } catch (e) {
        return { app: a.id, name: a.name, running, problem: (e as Error).message, domains: [] };
      }
    }),
  );
  return { servers };
}

// ---------------------------------------------------------------- any account (xmpp.js)

const NS_TLS = "urn:ietf:params:xml:ns:xmpp-tls";
const NS_SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const NS_MUC = "http://jabber.org/protocol/muc";
const NS_DISCO = "http://jabber.org/protocol/disco#info";

const CERT_CODES = /SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|ALTNAME|CERT_UNTRUSTED|CERT_REJECTED|ERR_TLS_CERT/;

/** Turn whatever went wrong into a sentence a person can act on. Exported for tests. */
export function describeXmppError(e: unknown, where: string, jid: string): DeliveryError {
  const err = e as { code?: string; condition?: string; name?: string; message?: string };
  const code = err.code ?? "";
  const msg = err.message ?? "";
  if (CERT_CODES.test(code) || CERT_CODES.test(msg)) {
    const self = /SELF_SIGNED/.test(code + msg);
    const name = /ALTNAME/.test(code + msg);
    return new DeliveryError(
      `${where}'s certificate isn't trusted (${self ? "it's self-signed" : name ? "it's for a different name" : /EXPIRED/.test(code + msg) ? "it has expired" : code || "unknown issuer"}). If this is your own server, turn on "Accept its certificate" for this channel.`,
      true,
    );
  }
  if (err.name === "SASLError" || err.condition === "not-authorized" || /not-authorized/.test(msg)) return new DeliveryError(`${where} rejected the password for ${jid}.`, true);
  if (err.condition === "account-disabled") return new DeliveryError(`${jid} is turned off on ${where}.`, true);
  if (msg === "NO_TLS") return new DeliveryError(`${where} doesn't offer an encrypted connection, so Gluon won't send the password.`, true);
  if (msg === "NO_MECHANISM" || /No compatible mechanism/i.test(msg)) return new DeliveryError(`${where} doesn't accept any sign-in method Gluon knows (SCRAM-SHA-1 or PLAIN).`, true);
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new DeliveryError(`Couldn't find ${where}. Check the address.`, code === "ENOTFOUND");
  if (code === "ECONNREFUSED") return new DeliveryError(`${where} refused the connection. Is the chat server running, and is that the right port?`);
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return new DeliveryError(`Can't reach ${where} from this server.`);
  if (code === "ECONNRESET") return new DeliveryError(`${where} dropped the connection.`);
  if (err.name === "TimeoutError" || code === "ETIMEDOUT" || /timeout|timed out/i.test(msg)) return new DeliveryError(`${where} didn't answer within ${TIMEOUT_MS / 1000} seconds.`);
  if (err.name === "StreamError" && err.condition === "host-unknown") return new DeliveryError(`${where} doesn't host ${jid.split("@")[1]}.`, true);
  return new DeliveryError(`Sending through ${where} failed: ${msg || err.condition || "unknown error"}.`);
}

async function target(c: XmppConfig, domain: string): Promise<{ host: string; port: number }> {
  if (c.server) {
    const s = splitServer(c.server);
    if (s) return s;
  }
  try {
    const srv = (await dns.resolveSrv(`_xmpp-client._tcp.${domain}`)).sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0];
    if (srv && srv.name !== ".") return { host: srv.name, port: srv.port };
  } catch {
    /* no SRV record: the domain itself */
  }
  return { host: domain, port: 5222 };
}

function buildClient(opts: { host: string; port: number; domain: string; servername: string; allowUntrusted: boolean; username: string; password: string }) {
  const entity = new Client({ service: `xmpp://${opts.host.includes(":") ? `[${opts.host}]` : opts.host}:${opts.port}`, domain: opts.domain, timeout: 10_000 });
  _tcp({ entity });
  const middleware = _middleware({ entity });
  const streamFeatures = _streamFeatures({ middleware });
  const iqCaller = _iqCaller({ middleware, entity }) as { start(): void; get(el: Element, to?: string, timeout?: number): Promise<Element> };
  const factory = new SASLFactory();
  scramsha1(factory);
  plain(factory);
  // STARTTLS with this channel's trust choice (xmpp.js's own always verifies, with no way to ask otherwise).
  streamFeatures.use("starttls", NS_TLS, async ({ entity: e }) => {
    const el = await e.sendReceive(xml("starttls", { xmlns: NS_TLS }));
    if (!el.is("proceed", NS_TLS)) throw new Error("STARTTLS_FAILURE");
    const raw = e.socket;
    const tls = new TLSSocketWrapper();
    tls.connect({ socket: raw as never, servername: opts.servername, rejectUnauthorized: !opts.allowUntrusted });
    await promise(tls, "connect");
    e._attachSocket(tls);
    await e.restart();
  });
  // Never send a password over a connection that isn't encrypted.
  streamFeatures.use("mechanisms", NS_SASL, ({ entity: e }, next) => {
    if (!e.isSecure()) throw new Error("NO_TLS");
    return next();
  });
  _sasl({ streamFeatures, saslFactory: factory }, async (done, mechanisms) => {
    const mech = mechanisms.find((m) => m === "SCRAM-SHA-1") ?? mechanisms.find((m) => m === "PLAIN");
    if (!mech) throw new Error("NO_MECHANISM");
    await done({ username: opts.username, password: opts.password }, mech);
  });
  _resourceBinding({ iqCaller, streamFeatures }, `gluon-${crypto.randomBytes(3).toString("hex")}`);
  iqCaller.start?.();
  return { entity, iqCaller };
}

async function sendFromAccount(c: XmppConfig, text: string): Promise<void> {
  const jid = (c.jid ?? "").trim();
  const [username, domain] = jid.split("@") as [string, string | undefined];
  if (!username || !domain) throw new DeliveryError("Enter the XMPP address to send from (name@example.com).", true);
  if (!c.password) throw new DeliveryError(`Enter the password for ${jid}.`, true);
  const where = await target(c, domain.split("/")[0]!);
  const label = c.server ? c.server.trim() : domain;
  const { entity, iqCaller } = buildClient({ ...where, domain, servername: domain, allowUntrusted: c.allowUntrusted, username, password: c.password });

  const errors: string[] = [];
  entity.on("error", () => undefined); // surfaced through start() and the stanza checks below
  entity.on("stanza", (s: Element) => {
    if (s.name === "message" && s.attrs.type === "error") {
      const cond = s.getChild("error")?.children.find((x): x is Element => typeof x !== "string")?.name ?? "error";
      errors.push(`${s.attrs.from?.split("/")[0] ?? "?"} (${cond === "service-unavailable" || cond === "item-not-found" ? "doesn't exist or doesn't accept messages" : cond})`);
    }
  });
  const timer = setTimeout(() => (entity.socket as unknown as { destroy?: (e: Error) => void } | null)?.destroy?.(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })), TIMEOUT_MS);
  try {
    try {
      await entity.start();
    } catch (e) {
      // Node reports the certificate problem on the TLS socket; xmpp.js may only see the close.
      const tls = (entity.socket as unknown as { socket?: TLSSocket } | null)?.socket;
      const authErr = !c.allowUntrusted && tls && !tls.authorized ? tls.authorizationError : null;
      throw describeXmppError(authErr ? Object.assign(new Error(String(authErr)), { code: String(authErr) }) : e, label, jid);
    }
    for (const to of c.to) await entity.send(xml("message", { to, type: "chat", id: crypto.randomUUID() }, xml("body", {}, text)));
    for (const room of c.rooms) {
      // Ask first: joining a room that doesn't exist would create it.
      try {
        await iqCaller.get(xml("query", { xmlns: NS_DISCO }), room, 8000);
      } catch {
        throw new DeliveryError(`There's no group chat at ${room}, or ${jid} can't see it.`, true);
      }
      const self = `${room}/${c.nick}`;
      const joined = new Promise<void>((resolve, reject) => {
        const on = (s: Element) => {
          if (s.name !== "presence" || s.attrs.from?.split("/")[0] !== room) return;
          if (s.attrs.type === "error") {
            entity.off("stanza", on);
            const cond = s.getChild("error")?.children.find((x): x is Element => typeof x !== "string")?.name ?? "error";
            reject(
              new DeliveryError(
                cond === "registration-required"
                  ? `${room} is members-only. Add ${jid} as a member first.`
                  : cond === "forbidden"
                    ? `${jid} is banned from ${room}.`
                    : cond === "conflict"
                      ? `Someone in ${room} already uses the name ${c.nick}. Choose another name for Gluon.`
                      : `${room} didn't let ${jid} in (${cond}).`,
                true,
              ),
            );
          } else if (s.getChild("x", `${NS_MUC}#user`)?.getChildren("status").some((x) => x.attrs.code === "110")) {
            entity.off("stanza", on);
            resolve();
          }
        };
        entity.on("stanza", on);
      });
      await entity.send(xml("presence", { to: self }, xml("x", { xmlns: NS_MUC }, xml("history", { maxstanzas: "0" }))));
      await Promise.race([joined, new Promise((_, rej) => setTimeout(() => rej(new DeliveryError(`${room} didn't answer when Gluon tried to join.`)), 8000))]);
      await entity.send(xml("message", { to: room, type: "groupchat", id: crypto.randomUUID() }, xml("body", {}, text)));
      await entity.send(xml("presence", { to: self, type: "unavailable" }));
    }
    // Give the server a moment to bounce messages to addresses that don't exist.
    await new Promise((r) => setTimeout(r, 1200));
    if (errors.length) throw new DeliveryError(`Not delivered to ${errors.join(", ")}. Check the address.`, true);
  } finally {
    clearTimeout(timer);
    await Promise.race([entity.stop().catch(() => undefined), new Promise((r) => setTimeout(r, 3000))]);
    (entity.socket as unknown as { destroy?: () => void } | null)?.destroy?.();
  }
}

// ---------------------------------------------------------------- entry point

export async function sendXmpp(c: XmppConfig, m: XmppOut): Promise<void> {
  const text = xmppText(m);
  if (c.mode === "server") return sendThroughServer(c, text);
  try {
    return await sendFromAccount(c, text);
  } catch (e) {
    if (e instanceof DeliveryError) throw e;
    throw describeXmppError(e, c.server || (c.jid ?? "").split("@")[1] || "the chat server", c.jid ?? "");
  }
}
