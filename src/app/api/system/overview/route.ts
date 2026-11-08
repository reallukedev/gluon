import { route } from "@/server/api";
import { systemOverview } from "@/server/system/overview";

export const GET = route({ auth: "admin" }, () => systemOverview());
