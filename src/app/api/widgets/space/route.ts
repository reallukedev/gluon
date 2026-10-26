import { route } from "@/server/api";
import { spaceData } from "@/server/widgets/space";

/** Which filesystems are filling up, and when each will be full at the last week's rate. Admins. */
export const GET = route({ auth: "admin" }, () => spaceData());
