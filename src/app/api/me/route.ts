import { route } from "@/server/api";
import { getPrefs } from "@/server/prefs";

export const GET = route({ auth: "user" }, ({ user, zone }) => ({ user: { ...user, zone }, prefs: getPrefs(user.id) }));
