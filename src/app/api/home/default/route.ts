import { z } from "zod";
import { route } from "@/server/api";
import { householdDefault, saveHouseholdDefault } from "@/server/home";
import { layoutSchema } from "@/lib/home";
import { audit } from "@/server/audit";

export const GET = route({ auth: "admin" }, () => householdDefault());

export const PUT = route({ auth: "admin", body: z.object({ layout: layoutSchema }) }, ({ user, body, ip, zone }) => {
  const layout = saveHouseholdDefault(body.layout);
  audit(user, { action: "home.default_saved", summary: "Set the household's default home page" }, { ip, zone });
  return layout;
});
