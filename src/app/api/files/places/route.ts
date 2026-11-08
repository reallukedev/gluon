import { route } from "@/server/api";
import { places } from "@/server/files/places";

export const GET = route({ auth: "user" }, ({ user }) => places(user));
