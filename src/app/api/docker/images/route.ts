import { route } from "@/server/api";
import { listImages } from "@/server/dockerx/images";

export const GET = route({ auth: "admin" }, () => listImages());
