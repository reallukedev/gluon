import type { AppSpec } from "@/lib/builder-types";
import type { ChatServerKind, ChatSettings } from "@/lib/chat-types";
import { isStandardPorts, QUARK_CONTAINER_PORTS, QUARK_PORTS, type QuarkPorts } from "@/lib/chat-ports";

/**
 * A new Prosody, the way Gluon sets it up: the official image (pinned to its 13.0 series) with its
 * own environment-driven config, and only conf.d, certs and the data folder mounted. Gluon's
 * settings (gluon.cfg.lua, picked up by the image's conf.d/*.cfg.lua include) and the person's
 * custom.lua (included by Gluon's file, last) live in conf.d, so updating the image never fights
 * with them. Pure: answers in, builder spec out.
 */

export const PROSODY_IMAGE = "prosodyim/prosody:13.0";
export const QUARK_IMAGE = "ghcr.io/reallukedev/quark:0.1";
/** Where Quark picks up <host>.crt and <host>.key (it reloads them on its own). */
export const QUARK_CERT_DIR = "/etc/quark/certs";
/** Quark's built-in call relay: the TURN port and the ports calls are relayed on. */
export const QUARK_TURN = { port: QUARK_PORTS.turn, relayMin: QUARK_PORTS.relayMin, relayMax: QUARK_PORTS.relayMax } as const;

export interface ChatInstall {
  /** Which server to install. Quark is the default: one container, live settings, its own call relay. */
  server: ChatServerKind;
  domain: string;
  /** The first account, an admin. */
  username: string;
  settings: ChatSettings;
  /** Quark only: the host ports to publish. The standard set unless something already holds it. */
  ports?: QuarkPorts;
  /** Quark only: the server's public IPv4, which its call relay advertises. Left out when unknown. */
  externalIp?: string | null;
}

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function installSettings(domain: string, s: Partial<ChatSettings> = {}): ChatSettings {
  return {
    signUp: "invite",
    history: "3m",
    groups: { on: true, host: `rooms.${domain}`, whoCreates: "everyone" },
    files: { on: true, host: `upload.${domain}`, maxMb: 100, keepDays: 30 },
    push: true,
    federation: true,
    web: false,
    calls: { on: false, host: domain },
    welcome: null,
    contact: null,
    ...s,
  };
}

export function prosodyRecipe(a: ChatInstall): AppSpec {
  const compose = `# Prosody, the chat (XMPP) server, set up by Gluon.
# Settings live in data/conf.d: gluon.cfg.lua is written by Gluon (Apps, Prosody, Chat server)
# and read after the image's own config; custom.lua is yours and is read last.
services:
  prosody:
    image: ${PROSODY_IMAGE}
    restart: unless-stopped
    environment:
      PROSODY_VIRTUAL_HOSTS: "${a.domain}"
      PROSODY_ADMINS: "${a.username}@${a.domain}"
      PROSODY_S2S_SECURE_AUTH: "1"
    ports:
      # Chat apps sign in here.
      - "5222:5222"
      # Other chat servers (federation).
      - "5269:5269"
      # Web chat and file uploads, reached through Caddy at https://${a.domain}.
      - "5280:5280"
    volumes:
      - \${APP_DATA_DIR}/data/conf.d:/etc/prosody/conf.d
      - \${APP_DATA_DIR}/data/certs:/etc/prosody/certs
      - \${APP_DATA_DIR}/data/prosody:/var/lib/prosody
`;
  return {
    details: {
      name: "Prosody",
      slug: "prosody",
      tagline: `Chat server for ${a.domain}`,
      description: `Prosody, an XMPP chat server, for addresses like you@${a.domain}. Manage accounts, invites and group chats in Gluon under Apps, Prosody, Chat server.`,
      category: "social",
      icon: "https://avatars.githubusercontent.com/u/4312871?s=200&v=4",
      website: "https://prosody.im",
      support: "https://prosody.im/doc",
      developer: "Prosody",
      version: "13.0",
      releaseNotes: "",
    },
    web: { service: null, containerPort: null, port: null, path: "", umbrelAuth: false },
    compose,
  };
}

/**
 * A new Quark: one container with its own call relay. It writes its config (quark.toml) on first
 * start from the environment; Gluon then applies the settings and makes the first account through
 * its admin console, so nothing here holds a setting Gluon manages.
 */
export function quarkRecipe(a: ChatInstall): AppSpec {
  const p = a.ports ?? QUARK_PORTS;
  const c = QUARK_CONTAINER_PORTS;
  const standard = isStandardPorts(p);
  const env = [
    `      QUARK_DOMAIN: "${a.domain}"`,
    `      QUARK_ADMINS: "${a.username}@${a.domain}"`,
    // The relay tells chat apps its ports, so it has to listen on the ones the host publishes.
    ...(standard ? [] : [`      QUARK_TURN_PORT: "${p.turn}"`, `      QUARK_TURN_RELAY_MIN: "${p.relayMin}"`, `      QUARK_TURN_RELAY_MAX: "${p.relayMax}"`]),
    // Inside a container Quark only sees a bridge address; this is the one calls reach from outside.
    ...(a.externalIp && IPV4_RE.test(a.externalIp) ? [`      QUARK_TURN_EXTERNAL_IP: "${a.externalIp}"`] : []),
  ].join("\n");
  const compose = `# Quark, the chat (XMPP) server, set up by Gluon.
# Its config file is data/config/quark.toml. Gluon changes settings through Quark itself
# (Apps, Quark, Chat server), and every change applies straight away.
services:
  quark:
    image: ${QUARK_IMAGE}
    restart: unless-stopped
    environment:
${env}
    ports:${standard ? "" : `
      # Another chat server holds the standard ports, so these are moved on this server only;
      # chat apps and other servers find them through DNS SRV records.`}
      # Chat apps sign in here, and on ${p.tls} with TLS from the start.
      - "${p.c2s}:${c.c2s}"
      - "${p.tls}:${c.tls}"
      # Other chat servers (federation).
      - "${p.s2s}:${c.s2s}"
      # Web chat, file uploads and invite pages, reached through Caddy at https://${a.domain}.
      - "${p.http}:${c.http}"
      # The call relay: chat apps ask it for a route, then calls travel over the UDP range.
      - "${p.turn}:${p.turn}/udp"
      - "${p.turn}:${p.turn}/tcp"
      - "${p.relayMin}-${p.relayMax}:${p.relayMin}-${p.relayMax}/udp"
    volumes:
      - \${APP_DATA_DIR}/data/config:/etc/quark
      - \${APP_DATA_DIR}/data/lib:/var/lib/quark
`;
  return {
    details: {
      name: "Quark",
      slug: "quark",
      tagline: `Chat server for ${a.domain}`,
      description: `Quark, an XMPP chat server, for addresses like you@${a.domain}. Manage accounts, invites and group chats in Gluon under Apps, Quark, Chat server.`,
      category: "social",
      icon: null,
      website: "https://github.com/reallukedev/quark",
      support: "https://github.com/reallukedev/quark",
      developer: "Quark",
      version: "0.1",
      releaseNotes: "",
    },
    web: { service: null, containerPort: null, port: null, path: "", umbrelAuth: false },
    compose,
  };
}

/**
 * The compose with port ranges written out one port per line, so the server's port check (which
 * skips ranges) sees every relay port. Only for checking; the app itself keeps the range.
 */
export function checkableCompose(compose: string): string {
  return compose.replace(/^(\s+)- "(\d+)-(\d+):(\d+)-(\d+)(\/(?:tcp|udp))?"$/gm, (line, indent: string, h1: string, h2: string, c1: string, c2: string, proto = "") => {
    const [a, b, x, y] = [h1, h2, c1, c2].map(Number) as [number, number, number, number];
    if (b < a || b - a !== y - x || b - a > 1000) return line;
    return Array.from({ length: b - a + 1 }, (_, i) => `${indent}- "${a + i}:${x + i}${proto}"`).join("\n");
  });
}

/** The recipe for the server the person picked. */
export const chatRecipe = (a: ChatInstall): AppSpec => (a.server === "quark" ? quarkRecipe(a) : prosodyRecipe(a));
