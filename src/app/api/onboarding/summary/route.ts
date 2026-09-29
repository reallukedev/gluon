import { route } from "@/server/api";
import { summaryFor } from "@/server/onboarding";

/** GET /api/onboarding/summary — what the first run left set up, read back from the real settings. */
export const GET = route({ auth: "user" }, ({ user }) => summaryFor(user));
