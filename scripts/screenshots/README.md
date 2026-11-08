# README screenshots

Use a throwaway Linux VM with Docker: the demo tags a tiny stand-in image with real app image names and writes made-up files under `/srv/apps` and `/DATA`.

1. `sudo sh scripts/screenshots/demo.sh up` starts nine made-up apps and fills `/DATA` with made-up photos, documents, films and music.
2. `sudo hostname homeserver`, then `rm -rf /tmp/gluon-demo && GLUON_DATA=/tmp/gluon-demo GLUON_NO_NSENTER=1 npm run dev`, and leave it 15 minutes so the charts fill.
3. In a second shell: `npx playwright install chromium && node scripts/screenshots/take.mjs "$(cat /tmp/gluon-demo/setup-code)"`
4. `sudo sh scripts/screenshots/demo.sh down` removes the apps and their images.
