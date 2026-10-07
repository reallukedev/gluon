import type { ChatRole } from "@/lib/chat-types";

/** Prosody's role names, in the words Gluon shows. */
export function roleOf(name: string | null): ChatRole {
  if (!name) return "member";
  if (name === "prosody:operator") return "owner";
  if (name === "prosody:admin") return "admin";
  if (name === "prosody:member" || name === "prosody:registered" || name === "prosody:user") return "member";
  return "other";
}

const CLIENTS: [RegExp, string][] = [
  [/^conversations/i, "Conversations"],
  [/^cheogram/i, "Cheogram"],
  [/^quicksy/i, "Quicksy"],
  [/^monocles/i, "monocles chat"],
  [/^blabber/i, "blabber.im"],
  [/^monal/i, "Monal"],
  [/^siskin/i, "Siskin"],
  [/^beagle/i, "Beagle"],
  [/^gajim/i, "Gajim"],
  [/^dino/i, "Dino"],
  [/^kaidan/i, "Kaidan"],
  [/^movim/i, "Movim"],
  [/^converse/i, "Converse"],
  [/^profanity/i, "Profanity"],
  [/^psi/i, "Psi"],
  [/^pidgin|^purple/i, "Pidgin"],
  [/^snikket/i, "Snikket"],
  [/^atalk/i, "aTalk"],
  [/^xabber/i, "Xabber"],
];

/** A chat app's name from its resource ("Conversations.Qqth" → Conversations), if it's a known one. */
export function clientName(resource: string): string | null {
  for (const [re, name] of CLIENTS) if (re.test(resource)) return name;
  return null;
}
