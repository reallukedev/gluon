import { route } from "@/server/api";
import { status } from "@/server/updates";

export const POST = route({ auth: "admin" }, () => status(true));
