import { route } from "@/server/api";
import { param } from "@/app/api/docker/params";
import { chatSnapshot } from "@/server/chat/prosody";

/** Everything the Chat server tab shows: domains, accounts with their devices, invites, rooms, settings. */
export const GET = route({ auth: "admin" }, async ({ params }) => chatSnapshot(param(params.app)));
