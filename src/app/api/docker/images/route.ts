import { route } from "@/server/api";
import { listImages } from "@/server/dockerx/images";

/** Every image, with who uses it. */
export const GET = route({ auth: "admin" }, () => listImages());
