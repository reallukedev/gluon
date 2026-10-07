import { route } from "@/server/api";
import { voiceDetails } from "@/server/voice/service";

/** Registered people, settings and the certificate. */
export const GET = route({ auth: "admin" }, ({ params }) => voiceDetails(decodeURIComponent(String(params.id))));
