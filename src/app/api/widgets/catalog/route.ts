import { route } from "@/server/api";
import { widgetCatalog } from "@/server/widgets/catalog";

export const GET = route({ auth: "user" }, ({ user }) => widgetCatalog(user));
