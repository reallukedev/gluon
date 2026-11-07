import { route } from "@/server/api";
import { saveRecord, zoneRecords } from "@/server/cloudflare/service";
import { recordBody } from "@/server/cloudflare/record-schema";

/** Every DNS record in one Cloudflare domain, and adding one. */
export const GET = route({ auth: "admin" }, ({ params }) => zoneRecords(String(params.zone)));

export const POST = route({ auth: "admin", recent: true, body: recordBody }, ({ user, params, body, ip, zone }) => saveRecord(user, { ip, zone }, String(params.zone), null, body));
