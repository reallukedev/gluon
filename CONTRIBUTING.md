# Contributing

Thanks for wanting to help. Bug reports, fixes and ideas are all welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the shape of it.
- Read [DESIGN.md](DESIGN.md). Gluon has a strong voice: plain words, one calm sentence where other
  tools show a wall of numbers, and every problem comes with its cause and a fix. New screens and
  copy should follow it.

## Setting up

You'll need Node 22 or newer.

```sh
npm install
GLUON_DATA=./data GLUON_NO_NSENTER=1 npm run dev
```

The app opens on `http://localhost:8130`; the setup code it asks for is printed in the terminal and
saved in `data/setup-code`. Most features expect a Linux host with Docker and reach the
host through the privileged container (`nsenter`), so on a laptop only part of Gluon works. For the
full experience, run the dev image on a Linux machine or VM with `docker/Dockerfile.dev`.

## Checks

Run these before opening a pull request:

```sh
npm run typecheck
npm test
npm run test:e2e
npm run build
```

Unit tests live next to the code they cover (`*.test.ts`), with sample files in `__fixtures__`
folders. End-to-end tests live in `test/e2e`; see its README.
Don't put real hostnames, addresses, MAC addresses or account names in fixtures; use `example.com`,
private address ranges and made-up names.

## Pull requests

- Keep each pull request to one change, with a short description of what it fixes and how you
  checked it. Screenshots help for anything visible.
- Match the code around you: naming, comment style and how much it comments.
- By contributing you agree your work is released under the [GNU GPL v3 or later](LICENSE).
