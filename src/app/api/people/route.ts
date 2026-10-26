import { route } from "@/server/api";
import { listPeople } from "@/server/people/users";

/** Everyone with an account: role, 2FA, last seen, devices, grants. */
export const GET = route({ auth: "admin" }, ({ user }) => listPeople(user));
