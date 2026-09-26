import { route } from "@/server/api";
import { statusFor } from "@/server/status";
import { getSetting } from "@/server/settings";
import { forbidden } from "@/server/errors";

export const GET = route({ auth: "user" }, async ({ user }) => {
  if (user.role !== "admin" && !getSetting("householdCanSeeStatus")) throw forbidden();
  return statusFor(user);
});
