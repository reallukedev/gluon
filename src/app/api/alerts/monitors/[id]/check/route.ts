import { route } from "@/server/api";
import { checkNow } from "@/server/monitors/service";

/** Run the check right now (recorded like any other check). */
export const POST = route({ auth: "admin" }, ({ params }) => checkNow(String(params.id)));
