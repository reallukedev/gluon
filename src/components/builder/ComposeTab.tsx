"use client";
import * as React from "react";
import type { CustomAppDetail, Issue, SecretNames } from "@/lib/builder-types";
import { Panel, Notice } from "@/components/ui/Surface";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Field";
import { CopyButton } from "@/components/ui/CopyButton";
import { IssueList } from "./Issues";
import { YamlEditor, type YamlEditorHandle } from "./YamlEditor";
import type { Draft } from "./state";
import s from "./builder.module.css";

/**
 * The compose file itself: the source of truth for everything, including what the form doesn't
 * show. Problems sit on their lines; the fixes Gluon can make are one click.
 */
export function ComposeTab({ draft, detail, issues, onFix, onFixAll, onGo, editorRef, secrets }: { draft: Draft; detail: CustomAppDetail; issues: Issue[]; onFix: (id: string) => void; onFixAll: () => void; onGo: (i: Issue) => void; editorRef: React.RefObject<YamlEditorHandle | null>; secrets: SecretNames }) {
  const [view, setView] = React.useState<"edit" | "changes">("edit");
  const published = detail.publishedSpec?.compose ?? null;
  const composeIssues = issues.filter((i) => !i.field?.startsWith("details.") && !i.id.startsWith("srv-name"));
  const fixable = composeIssues.filter((i) => i.fix && !i.fix.id.startsWith("rm-container-name"));
  const secretList = Object.entries(secrets).flatMap(([svc, keys]) => keys.map((k) => `${svc}: ${k}`));
  const changed = published !== null && published !== draft.spec.compose;

  return (
    <div className={s.composeGrid}>
      <div className={s.stack}>
        <div className={s.editorWrap}>
          <div className={s.editorBar}>
            <h2>docker-compose.yml</h2>
            <div className={s.editorTools}>
              {published !== null && (
                <Segmented
                  aria-label="Show"
                  value={view}
                  onChange={setView}
                  options={[
                    { value: "edit", label: "Edit" },
                    { value: "changes", label: changed ? "Changes" : "No changes", disabled: !changed },
                  ]}
                />
              )}
              <CopyButton value={draft.spec.compose} label="Copy" />
            </div>
          </div>
          {view === "changes" && changed ? (
            <>
              <p className={s.diffNote}>What changed since version {detail.publishedVersion} was published. Switch back to Edit to change it.</p>
              <YamlEditor value={draft.spec.compose} original={published!} readOnly height={560} label="Changes to the compose file" />
            </>
          ) : (
            <YamlEditor ref={editorRef} value={draft.spec.compose} onChange={(compose) => draft.setSpec((sp) => ({ ...sp, compose }))} issues={composeIssues} height={560} label="Compose file" />
          )}
        </div>
        {secretList.length > 0 && (
          <Notice title={secretList.length === 1 ? "1 secret is kept out of this file" : `${secretList.length} secrets are kept out of this file`}>
            <span className="mono">{secretList.join(", ")}</span>. Gluon stores them encrypted and writes them next to the app when it&apos;s published; edit them under Services.
          </Notice>
        )}
      </div>
      <Panel
        title="Checks"
        meta={
          fixable.length > 1 ? (
            <Button size="sm" onClick={onFixAll}>
              Fix all {fixable.length}
            </Button>
          ) : undefined
        }
      >
        <IssueList
          issues={composeIssues}
          onFix={onFix}
          onGo={(i) => {
            setView("edit");
            if (i.line) requestAnimationFrame(() => editorRef.current?.gotoLine(i.line!));
            else onGo(i);
          }}
          empty="Nothing to fix. Umbrel will run this as written, plus its own proxy for the web page."
        />
      </Panel>
    </div>
  );
}
