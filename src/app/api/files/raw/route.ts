import { z } from "zod";
import { route } from "@/server/api";
import { streamFile } from "@/server/files/stream";
import { flag, pathStr } from "../_schemas";

const handler = route({ auth: "user", query: z.object({ path: pathStr, download: flag }) }, ({ req, user, query }) => streamFile(req, user, query.path, query.download));

export const GET = handler;
export const HEAD = handler;
