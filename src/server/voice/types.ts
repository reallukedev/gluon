/** Shapes the Voice server tab reads. Types only, so client components can import them. */

export type VoiceProblemCode = "stopped" | "not_managed" | "unreachable" | "wrong_secret" | "booting" | "no_server";

export interface VoicePort {
  host: number;
  container: number;
  proto: "tcp" | "udp";
  ip: string;
}

/** How Gluon would make Ice reachable, or why it can't. */
export interface ManageOption {
  ok: boolean;
  /** builder: the app's spec is changed and republished. compose: its compose file is edited and applied. */
  via: "builder" | "compose" | null;
  why: string | null;
}

export interface VoiceUser {
  session: number;
  /** Registered id, or -1 for a guest. */
  userId: number;
  name: string;
  channel: number;
  mute: boolean;
  deaf: boolean;
  selfMute: boolean;
  selfDeaf: boolean;
  suppress: boolean;
  recording: boolean;
  prioritySpeaker: boolean;
  onlineSecs: number;
  idleSecs: number;
  client: string | null;
  os: string | null;
  address: string | null;
  tcpOnly: boolean;
  pingMs: number | null;
}

export interface VoiceChannel {
  id: number;
  name: string;
  parent: number;
  description: string;
  position: number;
  temporary: boolean;
  links: number[];
}

export interface VoiceLive {
  appId: string;
  appName: string;
  running: boolean;
  managed: boolean;
  problem: { code: VoiceProblemCode; message: string } | null;
  container: { name: string; image: string; version: string | null; ports: VoicePort[]; startedAt: number | null } | null;
  /** What Gluon can tell without Ice: from the container's settings and its open connections. */
  basics: { welcome: string | null; passwordSet: boolean; maxUsers: number | null; connected: number | null; port: number | null };
  manage: ManageOption;
  server: { id: number; version: string; uptimeSecs: number; others: number } | null;
  users: VoiceUser[];
  channels: VoiceChannel[];
  defaultChannel: number;
  /** Where people connect: a host name if one points here, else the LAN address. */
  address: { host: string; port: number } | null;
}

export type SettingKind = "text" | "richtext" | "secret" | "number" | "bool";

export interface VoiceSetting {
  key: string;
  label: string;
  help: string;
  kind: SettingKind;
  /** Effective value. Secrets are sent only so the admin can reveal them. */
  value: string;
  /** Where the value comes from. */
  source: "gluon" | "compose" | "default";
  /** The compose file's variable, when it sets this. */
  envName: string | null;
  envValue: string | null;
  /** What Mumble uses when nothing is saved here: the compose file's value or its own default. */
  fallback: string;
  unit?: string;
  min?: number;
  max?: number;
  /** Number shown to people is the stored number divided by this (bandwidth in kbit/s). */
  scale?: number;
}

export interface VoiceRegistered {
  id: number;
  name: string;
  lastActive: string | null;
  hasCertificate: boolean;
  online: boolean;
}

export interface VoiceCertView {
  /** The address whose Caddy certificate Gluon keeps Mumble's current with, if set. */
  domain: string | null;
  /** Names Caddy serves that this could follow. */
  choices: string[];
  /** Where the certificate files are on the server, when Gluon can find the mounted folder. */
  folder: string | null;
  writable: boolean;
  served: { subject: string | null; issuer: string | null; notAfter: number | null; selfSigned: boolean; fingerprint: string | null } | null;
  sync: { ok: boolean; message: string; checkedAt: number | null; copiedAt: number | null } | null;
  /** Why Gluon can't keep it current here, when it can't. */
  blocked: string | null;
}

export interface VoiceDetails {
  managed: boolean;
  registered: VoiceRegistered[];
  settings: VoiceSetting[];
  cert: VoiceCertView;
  /** Variables in the compose file Mumble ignores because MUMBLE_CUSTOM_CONFIG_FILE is set, etc. */
  notes: string[];
}

export interface ManagePlan {
  ok: boolean;
  via: "builder" | "compose" | null;
  why: string | null;
  port: number;
  connected: number | null;
  changes: string[];
  warnings: string[];
}

export interface InstallDefaults {
  port: number;
  name: string;
  welcome: string;
  taken: { port: number; proto: "tcp" | "udp"; by: string }[];
  lanHost: string | null;
}
