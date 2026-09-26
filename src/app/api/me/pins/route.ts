import { z } from "zod";
import { route } from "@/server/api";
import { addPin, listPins, removePin, renamePin, reorderPins } from "@/server/pins";

const kind = z.enum(["folder", "app", "page", "link"]);

export const GET = route({ auth: "user" }, ({ user }) => listPins(user.id));

export const POST = route(
  { auth: "user", body: z.object({ kind, target: z.string().min(1).max(1024), label: z.string().min(1).max(60) }) },
  ({ user, body }) => addPin(user.id, body.kind, body.target, body.label),
);

export const PATCH = route(
  {
    auth: "user",
    body: z.union([z.object({ order: z.array(z.string()).max(100) }), z.object({ id: z.string(), label: z.string().min(1).max(60) })]),
  },
  ({ user, body }) => {
    if ("order" in body) reorderPins(user.id, body.order);
    else renamePin(user.id, body.id, body.label);
    return listPins(user.id);
  },
);

export const DELETE = route({ auth: "user", body: z.object({ id: z.string() }) }, ({ user, body }) => {
  removePin(user.id, body.id);
  return listPins(user.id);
});
