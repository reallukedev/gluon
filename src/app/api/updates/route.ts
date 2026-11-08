import { route } from "@/server/api";
import { status } from "@/server/updates";

export const GET = route({ auth: "admin" }, () => status());
