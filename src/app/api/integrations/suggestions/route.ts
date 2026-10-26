import { route } from "@/server/api";
import { suggestions } from "@/server/integrations/suggest";

/** Apps running on this server that Gluon knows how to connect to, with the address prefilled. */
export const GET = route({ auth: "admin" }, () => suggestions());
