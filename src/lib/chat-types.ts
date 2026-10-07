/** Types shared by the chat server (Prosody) API and its screens. No server imports. */

/** Who can make an account: only the admin (in Gluon), people with an invite, or anyone. */
export type SignUp = "closed" | "invite" | "open";
/** How long message history (MAM) is kept on the server. "custom": a value set by hand. */
export type HistoryKeep = "off" | "1w" | "1m" | "3m" | "1y" | "never" | "custom";

export interface ChatSettings {
  signUp: SignUp;
  history: HistoryKeep;
  /** Group chats (MUC) on their own address, e.g. rooms.chat.example.com. */
  groups: { on: boolean; host: string; whoCreates: "everyone" | "admins" };
  /** Photos and files in chats (HTTP File Upload), through the chat domain's web address. */
  files: { on: boolean; host: string; maxMb: number; keepDays: number };
  /** Notifications on phones when the chat app is closed (XEP-0357). */
  push: boolean;
  /** Talk to people on other chat servers. */
  federation: boolean;
  /** Chat from a web browser (BOSH and WebSocket) through the chat domain's web address. */
  web: boolean;
  /**
   * Voice and video calls across networks: chat apps get logins for a TURN relay (coturn) at
   * `host`. Optional so settings saved before calls existed still read.
   */
  calls?: { on: boolean; host: string };
  /** A message every new account gets. */
  welcome: string | null;
  /** Where people can reach the server's admin (XEP-0157), e.g. you@chat.example.com. */
  contact: string | null;
}

export type ChatRole = "member" | "admin" | "owner" | "other";

export interface ChatDevice {
  resource: string;
  /** A friendlier name guessed from the resource ("Conversations", "Gajim"), or null. */
  client: string | null;
  ip: string | null;
  secure: boolean;
  since: number | null;
  /** Stream management: reconnects without losing messages. */
  resumable: boolean;
  /** The app says it's in the background (CSI). */
  inactive: boolean;
}

export interface ChatAccount {
  user: string;
  jid: string;
  role: ChatRole;
  /** Prosody's role name, e.g. prosody:member. */
  roleName: string | null;
  /** Listed in `admins` in the config file, which outranks the role Gluon can set. */
  fromConfig: boolean;
  /** The account Gluon sends XMPP notifications from. */
  sender: boolean;
  enabled: boolean;
  created: number | null;
  passwordChanged: number | null;
  lastActive: number | null;
  devices: ChatDevice[];
}

export interface ChatInvite {
  token: string;
  /** Set when the invite is for one specific username. */
  username: string | null;
  role: ChatRole;
  created: number;
  expires: number;
  /** xmpp: link chat apps open. */
  uri: string;
  /** Gluon's web page for the invite, when Gluon has a public address. */
  page: string | null;
  reusable: boolean;
  reset: boolean;
}

export interface ChatRoom {
  jid: string;
  name: string | null;
  description: string | null;
  public: boolean;
  membersOnly: boolean;
  persistent: boolean;
  occupants: number;
}

/** What chat apps can do with this server, by what a person notices. */
export interface ChatCapability {
  key: "secure" | "history" | "devices" | "mobile" | "push" | "files" | "groups" | "federation" | "contact" | "web" | "calls" | "invites";
  label: string;
  on: boolean;
  /** One sentence: what it means, or why it's off. */
  detail: string;
  /** XEPs or RFCs behind it, for the curious. */
  specs: string[];
  /** The setting that turns it on, when Gluon can. */
  fix: "signUp" | "history" | "groups" | "files" | "push" | "federation" | "web" | "contact" | "calls" | null;
}

export interface ChatHostSnapshot {
  host: string;
  /** Prosody couldn't read this domain's accounts (a storage or auth module error). */
  problem: string | null;
  accounts: ChatAccount[];
  invites: ChatInvite[];
  /** null when the invites module isn't loaded. */
  invitesReady: boolean;
  rooms: ChatRoom[];
  groupsHost: string | null;
  filesHost: string | null;
  settings: ChatSettings;
  /** Settings changed by hand in the main config that Gluon shows but leaves alone. */
  ownComponents: { muc: string | null; files: string | null };
  capabilities: ChatCapability[];
  modules: string[];
}

export interface ChatSnapshot {
  app: { id: string; name: string };
  container: string;
  version: string;
  /** Major version, e.g. 13. Settings need 13 or newer. */
  major: number | null;
  startedAt: number | null;
  hosts: ChatHostSnapshot[];
  /** The chat domain on Network, when one points here. */
  routeHost: string | null;
  /** Where the config lives on the server, and whether Gluon can change it. */
  config: { file: string | null; hostPath: string | null; writable: boolean; reason: string | null; managed: boolean; layout: "main" | "confd"; rev: string };
  /** Gluon's public address, for invite pages. */
  publicBase: string | null;
  checkedAt: number;
}

export interface ChatConfigFiles {
  main: string;
  gluon: string | null;
  file: string;
}

/** Calls across networks: the TURN relay and whether people outside can reach it. */
export interface ChatCallsStatus {
  on: boolean;
  /** The name chat apps are given for the relay (the chat domain, pointing at your home). */
  host: string | null;
  relay: { appId: string; name: string; running: boolean } | null;
  /** STUN answers from the relay on this server's address, and through the router's public one. null: not checked. */
  answers: { here: boolean | null; outside: boolean | null };
  lanIp: string | null;
  gateway: string | null;
  publicIp: string | null;
  ports: { turn: number; relayMin: number; relayMax: number };
}
