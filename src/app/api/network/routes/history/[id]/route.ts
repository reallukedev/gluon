import { route } from "@/server/api";
import { readHistoryRoutes } from "@/server/caddy/routes";
import { notFound } from "@/server/errors";

export const GET = route({ auth: "admin" }, ({ params }) => {
  const id = String(params.id ?? "");
  if (!/^\d{8}T\d{6}\d*Z$/.test(id)) throw notFound("That snapshot");
  return { id, config: readHistoryRoutes(id) };
});
