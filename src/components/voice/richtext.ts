/**
 * A safe preview of Mumble's welcome text. Mumble shows a small subset of HTML (Qt rich text);
 * the preview keeps only formatting tags and http(s) links, so nothing typed here can run in Gluon.
 * Browser only (uses DOMParser).
 */

const KEEP = new Set(["b", "strong", "i", "em", "u", "s", "br", "p", "div", "span", "a", "ul", "ol", "li", "h1", "h2", "h3", "h4", "font", "hr", "blockquote", "code", "pre", "sub", "sup", "small", "big", "center"]);
const DROP_WITH_CONTENT = new Set(["script", "style", "iframe", "object", "embed", "template", "noscript", "svg", "math", "head", "title"]);

export function previewHtml(input: string): DocumentFragment {
  const doc = new DOMParser().parseFromString(`<body>${input}</body>`, "text/html");
  const out = document.createDocumentFragment();
  const copy = (from: Node, to: Node) => {
    for (const n of Array.from(from.childNodes)) {
      if (n.nodeType === Node.TEXT_NODE) {
        to.appendChild(document.createTextNode(n.textContent ?? ""));
        continue;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      const el = n as Element;
      const tag = el.tagName.toLowerCase();
      if (DROP_WITH_CONTENT.has(tag)) continue;
      if (!KEEP.has(tag)) {
        copy(el, to);
        continue;
      }
      const clean = document.createElement(tag === "font" || tag === "center" || tag === "big" ? "span" : tag);
      if (tag === "a") {
        const href = el.getAttribute("href") ?? "";
        if (/^(https?:|mumble:)/i.test(href.trim())) {
          clean.setAttribute("href", href.trim());
          clean.setAttribute("rel", "noopener noreferrer");
          clean.setAttribute("target", "_blank");
        }
      }
      if (tag === "center") clean.style.textAlign = "center";
      copy(el, clean);
      to.appendChild(clean);
    }
  };
  copy(doc.body, out);
  return out;
}

/** Plain text with line breaks shown as Mumble shows them when no HTML is used. */
export const looksLikeHtml = (s: string) => /<\/?[a-z][^>]*>/i.test(s);
