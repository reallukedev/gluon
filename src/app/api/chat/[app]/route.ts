import { route } from "@/server/api";
import { param } from "@/app/api/docker/params";
import { chatSnapshot } from "@/server/chat/backend";

export const GET = route({ auth: "admin" }, async ({ params }) => chatSnapshot(param(params.app)));
