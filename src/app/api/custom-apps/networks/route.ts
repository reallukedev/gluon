import { route } from "@/server/api";
import { dockerNetworks } from "@/server/appstore/checks";

/** Docker networks on this server an app can join (not host, none or the default bridge). */
export const GET = route({ auth: "admin" }, () => dockerNetworks());
