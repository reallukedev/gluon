import { route } from "@/server/api";
import { signInHistory } from "@/server/system/logins";

export const GET = route({ auth: "admin" }, () => signInHistory());
