import { route } from "@/server/api";
import { readCompose } from "@/server/docker/compose";

export const GET = route({ auth: "admin" }, ({ params }) => readCompose(decodeURIComponent(String(params.id))));
