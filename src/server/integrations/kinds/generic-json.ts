import "server-only";
import { z } from "zod";
import { client, fail, ok, runTest, type KindContext, type KindDef } from "./base";
import { extractFields, parsePath, PathError } from "../../widgets/jsonpath";
import { JSON_FIELD_FORMATS, type JsonFieldsData } from "@/lib/widgets-types";

const FORBIDDEN_HEADERS = /^(host|content-length|transfer-encoding|connection|keep-alive|upgrade|te|trailer|proxy-.*|accept-encoding)$/i;

const header = z.object({
  name: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/, "Header names use letters, numbers and dashes.")
    .refine((n) => !FORBIDDEN_HEADERS.test(n), "Gluon sets that header itself."),
  value: z.string().max(4096).refine((v) => !/[\r\n]/.test(v), "Header values must be on one line."),
});

const field = z.object({
  label: z.string().trim().min(1, "Give every value a label.").max(40),
  path: z
    .string()
    .trim()
    .min(1, "Enter a path, like data.uptime.")
    .max(300)
    .superRefine((p, ctx) => {
      try {
        parsePath(p);
      } catch (e) {
        ctx.addIssue({ code: "custom", message: e instanceof PathError ? e.message : "That path can't be read." });
      }
    }),
  format: z.enum(JSON_FIELD_FORMATS).default("text"),
});

const schema = z.object({
  headers: z.array(header).max(10).default([]),
  fields: z.array(field).min(1, "Add at least one value to show.").max(12),
  allowSelfSigned: z.boolean().default(false),
});
type Config = z.infer<typeof schema>;

function http(ctx: KindContext<Config>) {
  return client(def, ctx, (status) => `The address answered ${status}: check the headers (API key or token).`);
}

async function fetchFields(ctx: KindContext<Config>): Promise<JsonFieldsData> {
  // baseUrl is the full endpoint; path "" keeps it as is.
  const doc = await http(ctx).json<unknown>("", { maxBytes: 2 * 1024 * 1024 });
  return { fields: extractFields(doc, ctx.config.fields) };
}

export const def: KindDef<Config> = {
  kind: "generic-json",
  label: "JSON address",
  noun: "the address",
  description: "Pick values out of any JSON API (uptime, counts, sizes…) and show them as a widget.",
  baseUrlLabel: "JSON address",
  baseUrlPlaceholder: "http://192.168.1.10:8080/api/status",
  keyHelp:
    "If the API needs a key, add it as a header (for example “Authorization: Bearer …” or “X-API-Key: …”). Header values are stored encrypted. Paths look like data.items[0].name, $.stats.total, list[*].size.sum() or items.length.",
  fields: [
    { key: "headers", label: "Headers", type: "headers", required: false, secret: true, help: "Sent with every request. Values are never shown again; leave one empty to keep it." },
    { key: "fields", label: "Values to show", type: "fields", required: true, secret: false },
    { key: "allowSelfSigned", label: "Allow self-signed certificate", type: "boolean", required: false, secret: false },
  ],
  schema,
  secretKeys: ["headers"],
  widgets: ["json.fields"],
  insecureTls: (c) => c.allowSelfSigned,
  authorize(ctx, req) {
    for (const h of ctx.config.headers) req.headers[h.name] = h.value;
  },
  test: (ctx) =>
    runTest(async () => {
      const { fields } = await fetchFields(ctx);
      const missing = fields.filter((f) => f.missing);
      if (missing.length === fields.length) {
        return fail(`Connected, but none of the paths found anything. Check them against the JSON the address returns.`, { preview: fields });
      }
      return ok(
        missing.length
          ? `Connected. ${missing.length} of ${fields.length} paths found nothing: ${missing.map((f) => `“${f.label}”`).join(", ")}.`
          : `Connected. Found all ${fields.length} value${fields.length === 1 ? "" : "s"}.`,
        { preview: fields },
      );
    }),
  data: {
    "json.fields": (ctx) => fetchFields(ctx),
  },
};
