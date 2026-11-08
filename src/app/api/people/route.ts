import { route } from "@/server/api";
import { listPeople } from "@/server/people/users";

export const GET = route({ auth: "admin" }, ({ user }) => listPeople(user));
