"use client";
import * as React from "react";
import { Download } from "iconoir-react";
import { Button } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import s from "./parts.module.css";

/** The ten single-use recovery codes, shown once, with copy and download. */
export function RecoveryCodes({ codes, username, serverName }: { codes: string[]; username: string; serverName: string }) {
  const text = `Gluon recovery codes for ${username} on ${serverName}\nEach code works once, instead of a code from your authenticator app.\n\n${codes.join("\n")}\n`;
  const download = React.useCallback(() => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `gluon-recovery-codes-${username}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [text, username]);
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <ol className={s.codes} aria-label="Recovery codes">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ol>
      <div className={s.codesActions}>
        <CopyButton value={codes.join("\n")} variant="secondary" size="md">
          Copy codes
        </CopyButton>
        <Button icon={<Download />} onClick={download}>
          Download
        </Button>
      </div>
      <p className={s.codesNote}>If you lose your phone, each code signs you in once. Keep them somewhere safe, like a password manager. This is the only time they're shown.</p>
    </div>
  );
}
