import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { guestWifi, guestWifiSchema, removeGuestWifi, saveGuestWifi } from "@/server/widgets/guest-wifi";

/** The guest network and its QR code. Everyone signed in: the point is to show it to guests. */
export const GET = route({ auth: "user" }, () => guestWifi());

/** Set the guest network (admins). Leave `password` out to keep the stored one. */
export const PUT = route({ auth: "admin", body: guestWifiSchema }, ({ user, body, ip, zone }) => {
  const r = saveGuestWifi(body, user.username);
  audit(user, { action: "guest-wifi.update", summary: `Set the guest Wi-Fi to “${body.ssid}”`, target: "guest-wifi", detail: { ssid: body.ssid, security: body.security, hidden: body.hidden, passwordChanged: !!body.password } }, { ip, zone });
  return r;
});

/** Forget the guest network (admins). */
export const DELETE = route({ auth: "admin" }, ({ user, ip, zone }) => {
  removeGuestWifi();
  audit(user, { action: "guest-wifi.remove", summary: "Removed the guest Wi-Fi from Home", target: "guest-wifi" }, { ip, zone });
  return { configured: false };
});
