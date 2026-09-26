import { route } from "@/server/api";
import { places } from "@/server/files/places";

/** Roots this person can browse, their pinned folders and recent folders. */
export const GET = route({ auth: "user" }, ({ user }) => places(user));
