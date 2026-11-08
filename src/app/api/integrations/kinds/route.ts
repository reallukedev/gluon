import { route } from "@/server/api";
import { allKindInfo } from "@/server/integrations/registry";

export const GET = route({ auth: "admin" }, () => allKindInfo());
