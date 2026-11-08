import { z } from "zod";
import { route } from "@/server/api";
import { ddnsStatus } from "@/server/network/ddns";

export const GET = route({ auth: "admin", query: z.object({ refresh: z.enum(["0", "1"]).optional() }) }, ({ query }) =>
  ddnsStatus(query.refresh === "1"),
);
