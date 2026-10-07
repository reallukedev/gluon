/** Which first-party management Gluon offers for an app, from its container images. No server imports. */

export type ServiceKind = "prosody" | "mumble";

const PROSODY = /(^|\/)(prosody|prosodyim)\/|(^|\/)prosody(:|$)/i;
const MUMBLE = /(^|\/)(mumble-?server|murmur)(:|@|$)|mumblevoip\//i;

export function serviceKind(images: readonly string[]): ServiceKind | null {
  if (images.some((i) => PROSODY.test(i))) return "prosody";
  if (images.some((i) => MUMBLE.test(i))) return "mumble";
  return null;
}
