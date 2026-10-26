# Security

Gluon runs privileged on the host with the Docker socket, so a bug in it can be a bug in the whole
server. Please report anything that could let someone in, see what they shouldn't, or run commands
they shouldn't.

## Reporting a vulnerability

Report it privately through GitHub: **Security → Report a vulnerability** on
[the repository](https://github.com/reallukedev/gluon/security/advisories/new). Please don't open a
public issue for it.

Say what you found, how to reproduce it, and which version (Settings → About) you were running. You'll
get a reply within a week, and credit in the release notes once it's fixed, if you'd like it.

## Supported versions

Fixes go into `main` (the Nightly channel) first and the next tagged release after that. Only the
newest release gets security fixes.

## Running it safely

- Keep Gluon behind Caddy (or another TLS proxy) if it's reachable from the internet, and set up
  two-step sign-in from home before publishing it.
- Anyone with an admin account effectively has root on the server. Give household members the
  member role.
