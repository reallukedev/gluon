import type { AppSpec } from "@/lib/builder-types";
import { SLUG_RE } from "@/lib/builder/names";

/**
 * A new Mumble server as a builder app. Pure: answers in, the builder's spec and secrets out.
 *
 * The image is pinned to the release Gluon's copy of Mumble's admin API (MumbleServer.ice) was
 * made from, so an update is a choice, not a surprise. Ice is wired for Gluon from the first
 * start: published on 127.0.0.1 only, with secrets that live in the builder's secret store.
 * The admin (SuperUser) password isn't set through the environment, because the image applies
 * MUMBLE_SUPERUSER_PASSWORD again at every start and would undo a later reset; Gluon sets it
 * over Ice once the server is up.
 */

export const MUMBLE_IMAGE = "mumblevoip/mumble-server:v1.5.915";
export const MUMBLE_SERVICE = "mumble-server";
export const MUMBLE_PORT = 64738;
export const MUMBLE_ICON = "https://cdn.jsdelivr.net/gh/selfhst/icons/svg/mumble.svg";

export interface VoiceAnswers {
  name: string;
  welcome: string;
  /** Empty for no join password. */
  password: string;
  port: number;
}

export interface VoiceSecrets {
  iceWrite: string;
  iceRead: string;
}

export interface VoiceRecipe {
  spec: AppSpec;
  secrets: Record<string, Record<string, string>>;
  slug: string;
}

/** "Friday Night Voice" → "friday-night-voice"; falls back to "mumble". */
export function slugFor(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/g, "");
  return SLUG_RE.test(s) ? s : "mumble";
}

/** A YAML double-quoted string: safe for any text, with $ escaped for compose. */
const yamlString = (v: string) => JSON.stringify(v.replace(/\$/g, "$$$$"));

export function voiceRecipe(a: VoiceAnswers, secrets: VoiceSecrets, icePort: number): VoiceRecipe {
  const name = a.name.trim() || "Mumble";
  const slug = slugFor(name);
  const welcome = a.welcome.trim();
  const env: [string, string][] = [
    ["MUMBLE_CONFIG_ICE", "tcp -h 0.0.0.0 -p 6502"],
    ["MUMBLE_CONFIG_REGISTERNAME", name],
  ];
  if (welcome) env.push(["MUMBLE_CONFIG_WELCOMETEXT", welcome]);
  const compose = [
    "services:",
    `  ${MUMBLE_SERVICE}:`,
    `    image: ${MUMBLE_IMAGE}`,
    "    restart: unless-stopped",
    "    ports:",
    `      - "${a.port}:${MUMBLE_PORT}"`,
    `      - "${a.port}:${MUMBLE_PORT}/udp"`,
    `      - "127.0.0.1:${icePort}:6502"`,
    "    environment:",
    ...env.map(([k, v]) => `      ${k}: ${yamlString(v)}`),
    "    volumes:",
    "      - ${APP_DATA_DIR}/data/mumble:/data",
    "",
  ].join("\n");

  const svcSecrets: Record<string, string> = {
    MUMBLE_CONFIG_ICESECRETWRITE: secrets.iceWrite,
    MUMBLE_CONFIG_ICESECRETREAD: secrets.iceRead,
  };
  if (a.password) svcSecrets.MUMBLE_CONFIG_SERVERPASSWORD = a.password;

  return {
    slug,
    secrets: { [MUMBLE_SERVICE]: svcSecrets },
    spec: {
      details: {
        name,
        slug,
        tagline: "Voice chat with Mumble",
        description: "A Mumble voice server. Manage who's here, channels and settings in its Voice server tab.",
        category: "social",
        icon: MUMBLE_ICON,
        website: "https://www.mumble.info",
        support: "",
        developer: "Mumble",
        version: MUMBLE_IMAGE.split(":v")[1] ?? "",
        releaseNotes: "",
      },
      web: { service: null, containerPort: null, port: null, path: "", umbrelAuth: false },
      compose,
    },
  };
}

/** The link Mumble apps open. Older ones need `version` to accept it; `title` names the saved server. */
export function mumbleLink(host: string, port: number, name?: string): string {
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const title = name ? `&title=${encodeURIComponent(name)}` : "";
  return `mumble://${h}${port === MUMBLE_PORT ? "" : `:${port}`}/?version=1.2.0${title}`;
}
