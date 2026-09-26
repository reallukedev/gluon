#!/usr/bin/env python3
"""Keeps the type roles consistent across CSS modules (idempotent; safe to re-run):
condensed text (font-stretch <= 92%) is set in the display face, and mono text gets its narrower width."""
import pathlib, re
root = pathlib.Path(__file__).resolve().parent.parent / "src"
block = re.compile(r"\{([^{}]*)\}")
changed = 0
for f in root.rglob("*.css"):
    src = f.read_text()
    def fix(m):
        body = m.group(1)
        new = body
        st = re.search(r"font-stretch:\s*(\d+(?:\.\d+)?)%", body)
        if st and float(st.group(1)) <= 92 and "font-family" not in body:
            new = re.sub(r"(font-stretch:\s*[\d.]+%;?)", r"font-family: var(--font-display); \1", new, count=1)
        if "var(--font-mono)" in body and "font-stretch" not in body:
            new = re.sub(r"(font-family:\s*var\(--font-mono\)[^;}]*;?)", lambda x: x.group(1) + ("" if x.group(1).endswith(";") else ";") + " font-stretch: var(--mono-stretch);", new, count=1)
        return "{" + new + "}"
    out = block.sub(fix, src)
    if out != src:
        f.write_text(out); changed += 1; print("updated", f.relative_to(root))
print(changed, "files")
