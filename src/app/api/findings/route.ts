import { z } from "zod";
import { route } from "@/server/api";
import { listHistory, listOpen, listAllOpen } from "@/server/findings";

export const GET = route({ auth: "admin", query: z.object({ view: z.enum(["open", "all", "history"]).default("open") }) }, ({ query }) => {
  if (query.view === "history") return listHistory(200);
  if (query.view === "all") return listAllOpen();
  return listOpen();
});
