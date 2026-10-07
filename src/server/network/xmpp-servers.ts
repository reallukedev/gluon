import "server-only";
import { docker } from "../docker/client";
import { PROSODY_CERT_DIR, XMPP_C2S_PORT, XMPP_S2S_PORT } from "../caddy/routes";
import type { ChatServerCandidate } from "@/lib/network-types";

const CHAT_IMAGE = /(^|\/)(prosody|prosodyim|snikket|ejabberd|openfire)[^/]*(:|$)|\/(prosody|ejabberd|snikket-server)(:|$)/i;

/** Containers on this server that look like an XMPP chat server, for the Network editor. */
export async function chatServerCandidates(): Promise<ChatServerCandidate[]> {
  const list = await docker().listContainers({ all: true });
  return list
    .filter((c) => CHAT_IMAGE.test(c.Image))
    .map((c) => {
      const pub = (priv: number) => c.Ports.find((p) => p.PrivatePort === priv && p.Type === "tcp" && p.PublicPort)?.PublicPort ?? null;
      const host = c.HostConfig?.NetworkMode === "host";
      const prosody = /prosody/i.test(c.Image);
      return {
        container: (c.Names[0] ?? c.Id).replace(/^\//, ""),
        image: c.Image,
        project: c.Labels?.["com.docker.compose.project"] ?? null,
        running: c.State === "running",
        ports: host ? { c2s: XMPP_C2S_PORT, s2s: XMPP_S2S_PORT, http: 5280 } : { c2s: pub(XMPP_C2S_PORT), s2s: pub(XMPP_S2S_PORT), http: pub(5280) },
        certDir: PROSODY_CERT_DIR,
        canSync: prosody,
      };
    })
    .sort((a, b) => Number(b.running) - Number(a.running) || a.container.localeCompare(b.container));
}
