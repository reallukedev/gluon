import { route } from "@/server/api";
import { appDetail } from "@/server/docker/detail";
import { movingApps } from "@/server/apps/move";

export const GET = route({ auth: "admin" }, async ({ params }) => {
  const id = decodeURIComponent(String(params.id));
  const app = await appDetail(id);
  return movingApps().has(app.id) ? { ...app, moving: true } : app;
});
