import { route } from "@/server/api";
import { appDetail } from "@/server/docker/detail";

export const GET = route({ auth: "admin" }, ({ params }) => appDetail(decodeURIComponent(String(params.id))));
