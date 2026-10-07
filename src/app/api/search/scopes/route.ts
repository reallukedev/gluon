import { route } from "@/server/api";
import { scopesFor } from "@/server/search-sources";

/** Where this person can search: everything, apps, files, and each connected app they may use. */
export const GET = route({ auth: "user" }, async ({ user }) => ({ scopes: await scopesFor(user) }));
