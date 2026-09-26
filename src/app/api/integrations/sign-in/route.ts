import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { badRequest } from "@/server/errors";
import { createIntegration, getRecord, normaliseBaseUrl, testContext, updateIntegration } from "@/server/integrations/store";
import { runIntegrationTest } from "@/server/integrations/test";
import { KEY_NAME, mintKey } from "@/server/integrations/signin";
import { KINDS } from "@/server/integrations/registry";
import { SIGN_IN_KINDS, type SignInResult } from "@/lib/widgets-types";

const body = z.object({
  kind: z.enum(SIGN_IN_KINDS),
  baseUrl: z.string().max(2048),
  username: z.string().trim().min(1, "Enter the username.").max(200),
  /** Used once to make the key; never stored or logged. */
  password: z.string().min(1, "Enter the password.").max(500),
  name: z.string().max(60).optional(),
  appId: z.string().max(200).nullable().optional(),
  shared: z.boolean().default(true),
  allowSelfSigned: z.boolean().default(false),
  /** Reconnect: replace the key of this saved connection instead of making a new one. */
  integrationId: z.string().max(64).optional(),
});

/**
 * Connect Jellyfin or Immich by signing in once. Gluon asks the app for its own API key named "Gluon", saves only
 * that key (encrypted), tests it, and forgets the password.
 */
export const POST = route({ auth: "admin", body }, async ({ user, body, ip, zone }): Promise<SignInResult> => {
  const label = KINDS[body.kind].label;
  const existing = body.integrationId ? getRecord(body.integrationId) : null;
  if (body.integrationId && !existing) throw badRequest("That connection is gone. Close this and connect again.");
  if (existing && existing.kind !== body.kind) throw badRequest("That connection is for a different app.");
  const baseUrl = normaliseBaseUrl(body.kind, body.baseUrl);
  const minted = await mintKey(body.kind, baseUrl, body.username, body.password, body.allowSelfSigned);

  const config = {
    apiKey: minted.apiKey,
    allowSelfSigned: body.allowSelfSigned,
  };
  const integration = existing
    ? updateIntegration(existing.id, { baseUrl, config }).after
    : createIntegration({
        kind: body.kind,
        name: body.name?.trim() || label,
        baseUrl,
        config,
        appId: body.appId ?? null,
        shared: body.shared,
      });

  audit(
    user,
    {
      action: existing ? "integration.update" : "integration.create",
      summary: `${existing ? "Reconnected" : "Connected"} ${label} by signing in as “${minted.account}” (Gluon made its own key, “${KEY_NAME}”)`,
      target: integration.id,
      detail: {
        kind: body.kind,
        baseUrl,
        shared: integration.shared,
        via: "sign-in",
        account: minted.account,
      },
    },
    { ip, zone },
  );

  const test = await runIntegrationTest(body.kind, testContext({ kind: body.kind, baseUrl, config: {}, id: integration.id }), true);
  return {
    integration: {
      ...integration,
      status: {
        ok: test.ok,
        message: test.ok ? null : test.message,
        checkedAt: Date.now(),
      },
    },
    test,
    account: minted.account,
  };
});
