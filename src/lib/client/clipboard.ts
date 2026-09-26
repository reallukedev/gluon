"use client";

/**
 * Copy text to the clipboard. Gluon is often opened over plain http on the home network, where
 * `navigator.clipboard` does not exist, so this falls back to a hidden textarea + execCommand.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.opacity = "0";
    ta.style.fontSize = "16px"; // no iOS zoom
    document.body.appendChild(ta);
    const selection = document.getSelection();
    const prev = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    if (prev && selection) {
      selection.removeAllRanges();
      selection.addRange(prev);
    }
    return ok;
  } catch {
    return false;
  }
}
