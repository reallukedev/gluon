import { route } from "@/server/api";
import { summaryFor } from "@/server/onboarding";

/** What the first run left set up, read back from the real settings. */
export const GET = route({ auth: "user" }, ({ user }) => summaryFor(user));
