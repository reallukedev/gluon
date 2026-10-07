import { route } from "@/server/api";
import { voiceServerCandidates } from "@/server/network/voice-servers";

/** Voice servers (Mumble) Gluon can see on this host, for publishing one at an address. */
export const GET = route({ auth: "admin" }, async () => ({ servers: await voiceServerCandidates() }));
