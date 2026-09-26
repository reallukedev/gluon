import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth/session";
import { getPrefs } from "@/server/prefs";

/** Entry point after sign-in and for the installed app: goes to each person's chosen start page. */
export default async function Start() {
  const { user } = await requireUser();
  const p = getPrefs(user.id).startPage;
  const allowed = user.role === "admin" || p === "home" || p === "status" || p === "files";
  redirect(allowed ? ({ home: "/", status: "/status", apps: "/apps", files: "/files" } as const)[p] : "/");
}
