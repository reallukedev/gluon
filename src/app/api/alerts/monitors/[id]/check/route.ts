import { route } from "@/server/api";
import { checkNow } from "@/server/monitors/service";

export const POST = route({ auth: "admin" }, ({ params }) => checkNow(String(params.id)));
