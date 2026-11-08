import { route } from "@/server/api";
import { suggestions } from "@/server/integrations/suggest";

export const GET = route({ auth: "admin" }, () => suggestions());
