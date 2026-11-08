import { route } from "@/server/api";
import { voiceLive } from "@/server/voice/service";

export const GET = route({ auth: "admin" }, ({ params }) => voiceLive(decodeURIComponent(String(params.id))));
