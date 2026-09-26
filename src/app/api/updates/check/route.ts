import { route } from "@/server/api";
import { status } from "@/server/updates";

/** Ask GitHub (and the store) again now. */
export const POST = route({ auth: "admin" }, () => status(true));
