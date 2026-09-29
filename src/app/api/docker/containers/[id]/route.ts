import { route } from "@/server/api";
import { inspectContainer } from "@/server/dockerx/containers";
import { param } from "../../params";

/** One container, readable, plus Docker's inspect output (secret-looking values hidden). */
export const GET = route({ auth: "admin" }, ({ params }) => inspectContainer(param(params.id)));
