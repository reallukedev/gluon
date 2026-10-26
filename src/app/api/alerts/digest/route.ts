import { route } from "@/server/api";
import { getSetting } from "@/server/settings";
import { digestMessage } from "@/server/notify/messages";

/** Preview of today's digest (what would be sent right now). */
export const GET = route({ auth: "admin" }, () => ({ settings: getSetting("digest"), preview: digestMessage() }));
