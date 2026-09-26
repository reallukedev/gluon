import { route } from "@/server/api";
import { allKindInfo } from "@/server/integrations/registry";

/** Form definitions for each kind of connection. */
export const GET = route({ auth: "admin" }, () => allKindInfo());
