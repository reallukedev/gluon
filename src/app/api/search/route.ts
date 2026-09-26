import { z } from "zod";
import { route } from "@/server/api";
import { searchAll } from "@/server/search";

export const GET = route({ auth: "user", query: z.object({ q: z.string().max(200) }) }, ({ user, query }) => searchAll(user, query.q));
