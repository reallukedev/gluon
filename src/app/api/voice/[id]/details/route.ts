import { route } from "@/server/api";
import { voiceDetails } from "@/server/voice/service";

export const GET = route({ auth: "admin" }, ({ params }) => voiceDetails(decodeURIComponent(String(params.id))));
