import { route } from "@/server/api";
import { inspectContainer } from "@/server/dockerx/containers";
import { param } from "../../params";

/** Secret-looking values in the inspect output are hidden. */
export const GET = route({ auth: "admin" }, ({ params }) => inspectContainer(param(params.id)));
