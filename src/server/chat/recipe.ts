import type { AppSpec } from "@/lib/builder-types";
import type { ChatSettings } from "@/lib/chat-types";

/**
 * A new Prosody, the way Gluon sets it up: the official image (pinned to its 13.0 series) with its
 * own environment-driven config, and only conf.d, certs and the data folder mounted. Gluon's
 * settings (gluon.cfg.lua, picked up by the image's conf.d/*.cfg.lua include) and the person's
 * custom.lua (included by Gluon's file, last) live in conf.d, so updating the image never fights
 * with them. Pure: answers in, builder spec out.
 */

export const PROSODY_IMAGE = "prosodyim/prosody:13.0";

export interface ChatInstall {
  domain: string;
  /** The first account, an admin. */
  username: string;
  settings: ChatSettings;
}

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
