import { route } from "@/server/api";
import { signInHistory } from "@/server/system/logins";

/** The last 7 days: sign-ins per person (merged into spans), where they came from, failed attempts. */
export const GET = route({ auth: "admin" }, () => signInHistory());
