import { route } from "@/server/api";
import { securityState } from "@/server/diagnostics/checkup/state";

/** The last security checkup with its results, earlier ones, and any running now. */
export const GET = route({ auth: "admin" }, () => securityState());
