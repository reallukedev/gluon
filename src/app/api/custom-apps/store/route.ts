import { z } from "zod";
import { route } from "@/server/api";
import { prepareStore, removeStore, setUpStore, storeStatus } from "@/server/appstore/service";

export const GET = route({ auth: "admin" }, () => storeStatus());

/**
 * step "check": write the store and test that Umbrel can read it (changes nothing in Umbrel).
 * step "register": add it to Umbrel's community app stores (or repair a lost or moved one).
 */
export const POST = route({ auth: "admin", recent: true, body: z.object({ step: z.enum(["check", "register"]) }) }, ({ body, user, ip, zone }) =>
  body.step === "check" ? prepareStore() : setUpStore(user, { ip, zone }),
);

/** Take Gluon's store out of Umbrel (only when none of its apps are installed). */
export const DELETE = route({ auth: "admin", recent: true }, ({ user, ip, zone }) => removeStore(user, { ip, zone }));
