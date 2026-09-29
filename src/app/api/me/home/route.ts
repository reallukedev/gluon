import { z } from "zod";
import { route } from "@/server/api";
import { homeFor, resetHome, saveHome } from "@/server/home";
import { layoutSchema } from "@/lib/home";

export const GET = route({ auth: "user" }, ({ user }) => homeFor(user.id, user.role));

export const PUT = route({ auth: "user", body: z.object({ layout: layoutSchema }) }, ({ user, body }) => ({ layout: saveHome(user.id, body.layout), personal: true }));

export const DELETE = route({ auth: "user" }, async ({ user }) => {
  resetHome(user.id);
  return homeFor(user.id, user.role);
});
