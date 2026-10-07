import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { AppError } from "@/server/errors";
import { certChoices, releaseCert, syncVoiceCert } from "@/server/voice/certs";
import { mumbleApp } from "@/server/voice/container";
import { getVoice, setCertDomain } from "@/server/voice/store";

/** Follow an address's certificate (or stop), then check it straight away. */
export const PUT = route({ auth: "admin", body: z.object({ domain: z.string().max(253).nullable() }) }, async ({ params, body, user, ip, zone }) => {
  const id = decodeURIComponent(String(params.id));
  const app = await mumbleApp(id);
  if (!getVoice(id)?.secrets) throw new AppError("not_managed", "Let Gluon manage this voice server first.", 409);
  const domain = body.domain?.toLowerCase() ?? null;
  if (domain && !certChoices(id).includes(domain)) throw new AppError("invalid", `${domain} isn't one of your public addresses.`, 400, { field: "domain" });
  const before = getVoice(id)?.certDomain ?? null;
  setCertDomain(id, domain);
  audit(user, { action: "voice.cert.follow", target: id, summary: domain ? `Keeps ${app.name}'s certificate current from ${domain}` : `Stopped keeping ${app.name}'s certificate current` }, { ip, zone });
  if (domain) return syncVoiceCert(id);
  return { ok: true, message: before ? await releaseCert(id) : "" };
});

/** Check now (and copy if it's due). `force` copies even when the current one is fine. */
export const POST = route({ auth: "admin", body: z.object({ force: z.boolean().optional() }) }, async ({ params, body }) => {
  const id = decodeURIComponent(String(params.id));
  await mumbleApp(id);
  return syncVoiceCert(id, { force: body.force });
});
