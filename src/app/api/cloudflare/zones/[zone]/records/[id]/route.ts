import { route } from "@/server/api";
import { removeRecord, saveRecord } from "@/server/cloudflare/service";
import { recordBody } from "@/server/cloudflare/record-schema";

/** Records Gluon keeps for public addresses are refused. */
export const PUT = route({ auth: "admin", recent: true, body: recordBody }, ({ user, params, body, ip, zone }) => saveRecord(user, { ip, zone }, String(params.zone), String(params.id), body));

export const DELETE = route({ auth: "admin", recent: true }, ({ user, params, ip, zone }) => removeRecord(user, { ip, zone }, String(params.zone), String(params.id)));
