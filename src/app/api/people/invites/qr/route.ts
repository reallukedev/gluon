import { z } from "zod";
import QRCode from "qrcode";
import { route } from "@/server/api";
import { badRequest } from "@/server/errors";

/** QR code (SVG) for an invite link, so a phone can scan it off the admin's screen. Only invite links. */
const body = z.object({ url: z.string().max(400) });

export const POST = route({ auth: "admin", body }, async ({ body }) => {
  if (!/^https?:\/\/[^\s/]+\/invite\/[\w-]{16,64}$/.test(body.url)) throw badRequest("That isn't an invite link.");
  const svg = await QRCode.toString(body.url, { type: "svg", margin: 0, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#0000" } });
  return { svg };
});
