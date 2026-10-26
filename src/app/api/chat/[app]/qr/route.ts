import { z } from "zod";
import QRCode from "qrcode";
import { route } from "@/server/api";
import { badRequest } from "@/server/errors";

/**
 * QR code (SVG) for a chat invite or an account address, so a phone's chat app can scan it off the
 * admin's screen. Only xmpp: links, Gluon's own chat invite pages and Quark's.
 */
const body = z.object({ text: z.string().max(600) });

export const POST = route({ auth: "admin", body }, async ({ body }) => {
  const ok =
    /^xmpp:[^\s<>"]+$/.test(body.text) ||
    /^https?:\/\/[^\s/]+\/chat-invite\/[a-z0-9.-]+\/[\w-]{8,100}$/.test(body.text) ||
    // Quark's own invite page, on the chat domain's web address.
    /^https:\/\/[a-z0-9.-]+\/invite\/[\w-]{8,100}$/.test(body.text);
  if (!ok) throw badRequest("That isn't a chat link.");
  const svg = await QRCode.toString(body.text, { type: "svg", margin: 0, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#0000" } });
  return { svg };
});
