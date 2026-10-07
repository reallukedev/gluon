import type { ChatCapability, ChatSettings } from "@/lib/chat-types";

/**
 * What chat apps can do with this server, by what a person notices, mapped from the modules Prosody
 * has loaded. Follows the XMPP Compliance Suites (XEP-0479): the pieces modern apps like
 * Conversations, Monal and Gajim expect. Pure, so it's tested without a chat server.
 */

const HISTORY_WORDS: Record<ChatSettings["history"], string> = {
  off: "",
  "1w": "for a week",
  "1m": "for a month",
  "3m": "for three months",
  "1y": "for a year",
  never: "for good",
  custom: "for as long as the config says",
};

export function capabilities(c: {
  host: string;
  modules: Set<string>;
  groupsHost: string | null;
  filesHost: string | null;
  /** The chat domain's web address goes to the chat server (Network). */
  webSide: boolean;
  settings: ChatSettings;
  requireEncryption: boolean;
}): ChatCapability[] {
  const has = (m: string) => c.modules.has(m);
  const out: ChatCapability[] = [];

  const secure = has("tls") && has("saslauth") && c.requireEncryption;
  out.push({
    key: "secure",
    label: "Encrypted sign-in",
    on: secure,
    detail: secure ? "Apps must use TLS, and passwords are checked without being sent in the clear." : "Prosody lets apps connect without encryption. Set c2s_require_encryption = true in its config.",
    specs: ["RFC 6120", "RFC 7590", "XEP-0440"],
    fix: null,
  });

  const history = has("mam");
  out.push({
    key: "history",
    label: "Message history",
    on: history,
    detail: history ? `Messages sync to every device and are kept ${HISTORY_WORDS[c.settings.history]}.` : "A message only reaches the devices that were online when it arrived.",
    specs: ["XEP-0313"],
    fix: "history",
  });

  const devices = has("carbons") && has("bookmarks") && (has("pep") || has("pep_simple"));
  out.push({
    key: "devices",
    label: "Every device in sync",
    on: devices,
    detail: devices ? "Messages you send from one device show up on the others, along with your contacts, avatar and group chats." : "Add carbons, pep and bookmarks to modules_enabled so devices stay in step.",
    specs: ["XEP-0280", "XEP-0163", "XEP-0402", "XEP-0398"],
    fix: null,
  });

  const mobile = has("smacks") && (has("csi_simple") || has("csi"));
  out.push({
    key: "mobile",
    label: "Phones on patchy networks",
    on: mobile,
    detail: mobile ? "Phones reconnect without losing messages and save battery while the app is in the background." : "Add smacks and csi_simple to modules_enabled so phones don't miss messages.",
    specs: ["XEP-0198", "XEP-0352"],
    fix: null,
  });

  const push = has("cloud_notify");
  out.push({
    key: "push",
    label: "Notifications when the app is closed",
    on: push,
    detail: push ? "iPhone apps like Monal get a nudge to fetch new messages." : "iPhone apps like Monal can't tell you about new messages once iOS closes them.",
    specs: ["XEP-0357"],
    fix: "push",
  });

  const filesReady = !!c.filesHost && c.webSide;
  out.push({
    key: "files",
    label: "Photos and files",
    on: filesReady,
    detail: filesReady
      ? `People can send photos, voice messages and files up to ${c.settings.files.maxMb} MB.`
      : c.filesHost
        ? `File sharing is on, but https://${c.host} doesn't lead to the chat server's web port yet, so uploads fail.`
        : "Apps can't send photos, voice messages or files.",
    specs: ["XEP-0363"],
    fix: "files",
  });

  out.push({
    key: "groups",
    label: "Group chats",
    on: !!c.groupsHost,
    detail: c.groupsHost ? `Group chats live at ${c.groupsHost}${has("muc_mam") || c.settings.history !== "off" ? ", with history" : ""}.` : "People can only chat one to one.",
    specs: ["XEP-0045", "XEP-0313"],
    fix: "groups",
  });

  const fed = has("s2s");
  out.push({
    key: "federation",
    label: "Other chat servers",
    on: fed,
    detail: fed ? "People here can chat with anyone on another XMPP server, like email." : "People here can only chat with each other.",
    specs: ["RFC 6120", "XEP-0220", "XEP-0288"],
    fix: "federation",
  });

  const invites = has("invites") && has("invites_register");
  out.push({
    key: "invites",
    label: "Invite links",
    on: invites,
    detail: invites ? "You can send someone a link that sets up their account in their chat app." : "Invite links aren't available, so you set passwords for people yourself.",
    specs: ["XEP-0401", "XEP-0379"],
    fix: "signUp",
  });

  const web = (has("bosh") || has("websocket")) && c.webSide;
  out.push({
    key: "web",
    label: "Chat in a browser",
    on: web,
    detail: web ? `Web chat apps connect through https://${c.host}.` : has("bosh") || has("websocket") ? `Web chat is on, but https://${c.host} doesn't lead to the chat server yet.` : "Only installed chat apps can connect.",
    specs: ["XEP-0206", "RFC 7395", "XEP-0156"],
    fix: "web",
  });

  const calls = has("turn_external") || has("external_services");
  out.push({
    key: "calls",
    label: "Calls across networks",
    on: calls,
    detail: calls
      ? "Chat apps get a relay for voice and video calls, so calls work between two homes and on mobile data."
      : "Voice and video calls work on the same network, but often fail between two homes or on mobile data. A small relay fixes that.",
    specs: ["XEP-0215", "XEP-0167"],
    fix: "calls",
  });

  const contact = has("server_contact_info") && !!c.settings.contact;
  out.push({
    key: "contact",
    label: "Admin contact",
    on: contact,
    detail: contact ? `Apps and other servers know to reach ${c.settings.contact} about problems.` : "Apps and other servers have nobody to contact about problems.",
    specs: ["XEP-0157"],
    fix: "contact",
  });

  return out;
}
