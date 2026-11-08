import { route } from "@/server/api";
import { internetFor } from "@/server/widgets/internet";

/** Everyone in the household; the router's address is for admins only. */
export const GET = route({ auth: "user" }, ({ user }) => internetFor(user));
