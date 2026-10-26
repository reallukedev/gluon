import { route } from "@/server/api";
import { appsFor } from "@/server/apps/listing";

export const GET = route({ auth: "user" }, ({ user }) => appsFor(user));
