import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { createIntegration, listIntegrations, testContext } from "@/server/integrations/store";
import { runIntegrationTest } from "@/server/integrations/test";
import { KINDS } from "@/server/integrations/registry";
import { integrationRefs } from "@/server/widgets/catalog";
import { INTEGRATION_KINDS } from "@/lib/widgets-types";
import { requireRecentAuth } from "@/server/integrations/recent";

/** Admins: every connection (secrets masked). Members: the shared ones, as refs. */
export const GET = route({ auth: "user" }, async ({ user }) => {
  if (user.role === "admin") return listIntegrations();
  return integrationRefs(user);
});

const createBody = z.object({
  kind: z.enum(INTEGRATION_KINDS),
  name: z.string().max(200),
  baseUrl: z.string().max(2048),
  config: z.record(z.string(), z.unknown()).default({}),
  appId: z.string().max(200).nullable().optional(),
  shared: z.boolean().default(false),
  /** Run the connection test after saving (default true). Saving never depends on the test passing. */
  test: z.boolean().default(true),
});

export const POST = route({ auth: "admin", body: createBody }, async ({ user, session, body, ip, zone }) => {
  if (body.shared) requireRecentAuth(session);
  const integration = createIntegration(body);
  audit(
    user,
    {
      action: "integration.create",
      summary: `Connected ${KINDS[body.kind].label} (“${integration.name}”)`,
      target: integration.id,
      detail: { kind: integration.kind, baseUrl: integration.baseUrl, shared: integration.shared },
    },
    { ip, zone },
  );
  const test = body.test
    ? await runIntegrationTest(integration.kind, testContext({ kind: integration.kind, baseUrl: integration.baseUrl, config: {}, id: integration.id }), true)
    : null;
  return { integration: { ...integration, status: test ? { ok: test.ok, message: test.ok ? null : test.message, checkedAt: Date.now() } : integration.status }, test };
});
