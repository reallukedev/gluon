import { route } from "@/server/api";
import { scopesFor } from "@/server/search-sources";

export const GET = route({ auth: "user" }, async ({ user }) => ({ scopes: await scopesFor(user) }));
