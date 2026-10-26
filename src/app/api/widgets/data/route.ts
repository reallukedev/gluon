import { z } from "zod";
import { route } from "@/server/api";
import { widgetBatch, widgetData } from "@/server/widgets/data";
import type { WidgetBatchResponse, WidgetRequest } from "@/lib/widgets-types";

const one = z.object({
  key: z.string().max(80).optional(),
  type: z.string().max(60),
  integration: z.string().max(60).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Widget data. One widget (`WidgetRequest`) answers with its `WidgetResponse`; a batch
 * (`{ widgets: [...] }`, up to 40) answers per widget, so one failing app never blanks the rest.
 * POST keeps personal addresses (calendars, feeds) out of logs and browser history.
 */
const body = z.union([z.object({ widgets: z.array(one).max(40, "That's more widgets than one page can ask for at once.") }), one]);

export const POST = route({ auth: "user", body }, async ({ user, body }) => {
  if ("widgets" in body) {
    const results = await widgetBatch(user, body.widgets as WidgetRequest[]);
    return { results } satisfies WidgetBatchResponse;
  }
  return widgetData(user, body as WidgetRequest);
});
