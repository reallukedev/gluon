import { route } from "@/server/api";
import { voiceServerCandidates } from "@/server/network/voice-servers";

export const GET = route({ auth: "admin" }, async () => ({ servers: await voiceServerCandidates() }));
