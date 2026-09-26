# Gluon

In physics, the gluon is the particle that holds everything together. This one holds a home server
together: one calm web app for everything running on the box, however it got there.

- **Status and alerts.** One sentence says whether everything is fine; anything that needs you comes
  with its cause and a one-click fix. Uptime monitors, drive health, certificates, crash loops, and
  notifications through ntfy, Pushover, email or webhooks.
- **Apps.** Every Docker container and Compose stack, including ones Umbrel or CasaOS installed:
  live CPU and memory, logs, safe compose editing, and a diagram of how each app is put together.
  Umbrel's app store works from inside Gluon.
- **Files.** A file manager for the whole machine with pinned folders, previews, thumbnails, uploads
  and a trash. Household members only see the folders you share with them.
- **Storage.** Disks as the physical things they are, a map of what's using space, mounting drives
  and making mounts survive a restart, renaming mount points (with the apps that use them).
- **Network.** Which apps are on the internet, at what address, whether each one works and whether
  it asks for a login, drawn as a map from the visitor to the app. Manages Caddy routes.
- **System.** OS updates, services, power, who's signed in over SSH, temperatures and memory by app.
- **Diagnostics.** A checkup that runs 60+ checks in seconds, targeted checks for "an app won't open"
  or "the internet is slow", and live traffic, connections, requests, processes and logs.
- **Home.** A start page for everyone in the house, with widgets for Jellyfin, Immich, Navidrome,
  slskd, Homebridge and any app on the server.
- **Household.** Accounts with roles, invites with a QR code, a grid of who can open what, problem
  reports, and an activity log of every change.

Built with Next.js, React and Base UI. Light and dark follow your device.

## Install

Gluon manages the host itself, so it runs as one privileged container on the host network, with the
Docker socket mounted. You'll need Docker with the Compose plugin and systemd on the host.

```sh
git clone https://github.com/reallukedev/gluon.git
cd gluon
docker compose -f docker/compose.yaml up -d --build
```

Open `http://<your server>:8130`. The first visit asks for a one-time setup code, printed in
`docker logs gluon`, and then for the first admin account.

### Public addresses (optional)

Network → public addresses drives a [Caddy](https://caddyserver.com) container: Gluon writes
`routes.json` and a generated `Caddyfile` into Caddy's config folder and reloads Caddy through its
admin socket. Mount the config folder at `/proxy-caddy` and the admin socket's volume at `/run/caddy`
(see the comments in `docker/compose.yaml`).

### Reaching it from outside

Gluon is built to sit on the internet behind Caddy: passwords are hashed with argon2id, sign-ins are
throttled, admins need two-step sign-in when away from home, sessions are revocable, and every
change is recorded. Set up two-step sign-in from home before publishing it.

## Updates

Settings → Updates checks this repository for new releases (or, if you choose, every change on
`main`). Updating downloads the new version, builds it on your server, swaps it in, and puts the
previous version back if the new one doesn't come up healthy. Automatic updates can run in an hour
you pick. Installs from Umbrel's app store can also update through Umbrel.

## Development

```sh
npm install
npm run dev
```

Most features expect to run on a Linux host with Docker; the app reaches the host through the
privileged container (`nsenter`), so a laptop only shows part of it.

- `npm run typecheck` checks types; `npm run build` makes the production build.
- Design rules live in `DESIGN.md`.
