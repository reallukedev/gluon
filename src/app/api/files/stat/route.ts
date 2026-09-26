import { z } from "zod";
import { route } from "@/server/api";
import { statPath } from "@/server/files/list";
import { pathStr } from "../_schemas";

export const GET = route({ auth: "user", query: z.object({ path: pathStr }) }, ({ user, query }) => statPath(user, query.path));
