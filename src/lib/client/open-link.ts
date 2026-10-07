/**
 * App addresses are usually web pages, but a voice server's is mumble://, which hands off to the
 * Mumble app. A new tab for that would sit empty, so only web addresses follow "open in new tab".
 */
export const isWebUrl = (url: string | null | undefined) => !!url && /^https?:\/\//i.test(url);

export function linkTarget(url: string | null | undefined, newTab: boolean): "_blank" | undefined {
  return newTab && isWebUrl(url) ? "_blank" : undefined;
}

export function openAppUrl(url: string) {
  if (isWebUrl(url)) window.open(url, "_blank", "noopener");
  else window.location.href = url;
}
