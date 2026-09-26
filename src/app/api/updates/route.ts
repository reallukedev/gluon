import { route } from "@/server/api";
import { status } from "@/server/updates";

/** Settings → Updates: what's running, how Gluon is installed, what's available. */
export const GET = route({ auth: "admin" }, () => status());
