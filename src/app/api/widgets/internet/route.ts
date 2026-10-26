import { route } from "@/server/api";
import { internetData } from "@/server/widgets/internet";

/**
 * Is the internet up: the latest probe, a 24-hour minute strip and recent outages. Everyone in the household;
 * the router's address is for admins only.
 */
export const GET = route({ auth: "user" }, ({ user }) => {
  const d = internetData();
  return user.role === "admin" ? d : { ...d, router: null };
});
