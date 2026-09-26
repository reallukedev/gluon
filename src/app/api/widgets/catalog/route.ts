import { route } from "@/server/api";
import { widgetCatalog } from "@/server/widgets/catalog";

/** Widget types this person can add, with the connected apps available for each. */
export const GET = route({ auth: "user" }, ({ user }) => widgetCatalog(user));
