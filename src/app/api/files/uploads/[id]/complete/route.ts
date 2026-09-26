import { route } from "@/server/api";
import { completeUpload } from "@/server/files/upload";
import { where } from "../../../_schemas";

/** Move the finished upload into place. May answer status "completing" for big cross-drive copies; poll GET. */
export const POST = route({ auth: "user" }, (ctx) => completeUpload(ctx.user, String(ctx.params.id), where(ctx)));
