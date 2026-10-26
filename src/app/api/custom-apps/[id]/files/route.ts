import { route } from "@/server/api";
import { previewFiles } from "@/server/appstore/service";

/** The files the next publish writes, and the ones last published. */
export const GET = route({ auth: "admin" }, ({ params }) => previewFiles(String(params.id)));
