import { route } from "@/server/api";
import { getSetting } from "@/server/settings";
import { digestMessage } from "@/server/notify/messages";

export const GET = route({ auth: "admin" }, () => ({ settings: getSetting("digest"), preview: digestMessage() }));
