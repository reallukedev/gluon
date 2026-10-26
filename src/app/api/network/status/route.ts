import { z } from "zod";
import { route } from "@/server/api";
import { networkStatus } from "@/server/network/status";

/** DNS, certificate, HTTP-through-Caddy and backend status of every public address. Cached ~30 s. */
export const GET = route({ auth: "admin", query: z.object({ refresh: z.enum(["0", "1"]).optional() }) }, ({ query }) =>
  networkStatus({ force: query.refresh === "1" }),
);
