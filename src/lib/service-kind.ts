export type ServiceKind = "prosody" | "quark" | "mumble";

export const PROSODY_IMAGE_RE = /(^|\/)(prosody|prosodyim)\/|(^|\/)prosody(:|$)/i;
export const QUARK_IMAGE_RE = /(^|\/)quark(:|$)/i;
const MUMBLE = /(^|\/)(mumble-?server|murmur)(:|@|$)|mumblevoip\//i;

export function serviceKind(images: readonly string[]): ServiceKind | null {
  // Quark first: an app with both is managed through Quark, which is the one Gluon installs now.
  if (images.some((i) => QUARK_IMAGE_RE.test(i))) return "quark";
  if (images.some((i) => PROSODY_IMAGE_RE.test(i))) return "prosody";
  if (images.some((i) => MUMBLE.test(i))) return "mumble";
  return null;
}

export const isChatKind = (k: ServiceKind | null): k is "prosody" | "quark" => k === "prosody" || k === "quark";

export function chatServerOf(image: string): "prosody" | "quark" | null {
  if (QUARK_IMAGE_RE.test(image)) return "quark";
  if (PROSODY_IMAGE_RE.test(image)) return "prosody";
  return null;
}
