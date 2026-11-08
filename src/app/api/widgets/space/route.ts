import { route } from "@/server/api";
import { spaceData } from "@/server/widgets/space";

export const GET = route({ auth: "admin" }, () => spaceData());
