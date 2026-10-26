import { route } from "@/server/api";
import { voiceLive } from "@/server/voice/service";

/** The voice server at a glance: state, who's here, channels. Polled while the tab is open. */
export const GET = route({ auth: "admin" }, ({ params }) => voiceLive(decodeURIComponent(String(params.id))));
