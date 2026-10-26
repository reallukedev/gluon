import "server-only";

/** A first page that looks finished, works on a phone and in dark mode, and is short enough to read in one go. */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const page = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
${body}
</body>
</html>
`;

const CSS = `:root {
  color-scheme: light dark;
  --ink: #1d1d1f;
  --muted: #5f5f66;
  --ground: #fbfaf7;
  --rule: #e4e1da;
  --link: #1f5fa8;
}

@media (prefers-color-scheme: dark) {
  :root {
    --ink: #ecebe6;
    --muted: #a5a39c;
    --ground: #141416;
    --rule: #2c2c30;
    --link: #8db8ea;
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--ground);
  color: var(--ink);
  font: 1.0625rem/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-text-size-adjust: 100%;
}

main,
footer {
  width: min(100% - 2.5rem, 38rem);
  margin-inline: auto;
}

main { padding-block: clamp(3rem, 12vh, 7rem) 3rem; }

h1 {
  font-size: clamp(2rem, 6vw, 3rem);
  line-height: 1.1;
  letter-spacing: -0.02em;
  margin: 0 0 1.25rem;
  text-wrap: balance;
}

p { margin: 0 0 1rem; }

a { color: var(--link); text-underline-offset: 0.15em; }

footer {
  border-top: 1px solid var(--rule);
  padding-block: 1.25rem 2.5rem;
  color: var(--muted);
  font-size: 0.875rem;
}
`;

export function starterFiles(name: string): { path: string; text: string }[] {
  const n = esc(name);
  const year = new Date().getFullYear();
  return [
    {
      path: "index.html",
      text: page(
        n,
        `  <main>
    <h1>${n}</h1>
    <p>This is the first page of your site. Change this text in index.html, save, and the preview shows it straight away.</p>
    <p>When it looks right, publish it, and anyone with the address can open it.</p>
  </main>
  <footer>
    <p>&copy; ${year} ${n}</p>
  </footer>`,
      ),
    },
    { path: "style.css", text: CSS },
    {
      path: "404.html",
      text: page(
        `Page not found · ${n}`,
        `  <main>
    <h1>Page not found</h1>
    <p>There's nothing at this address. It may have moved, or the link has a typo.</p>
    <p><a href="/">Go to the home page</a></p>
  </main>`,
      ),
    },
  ];
}
