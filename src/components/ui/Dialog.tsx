"use client";
import * as React from "react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { Drawer } from "@base-ui/react/drawer";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Xmark } from "iconoir-react";
import { useMediaQuery } from "@/lib/client/motion";
import { Button, IconButton, type ButtonVariant } from "./Button";
import { HoldButton } from "./HoldButton";
import { Input } from "./Field";
import s from "./dialog.module.css";

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  footerStart?: React.ReactNode;
  size?: "default" | "wide" | "xwide";
  /** Keep content when closed (e.g. forms mid-edit). */
  keepMounted?: boolean;
  initialFocus?: React.RefObject<HTMLElement | null>;
}

const PHONE = "(max-width: 640px)";

/**
 * Phones get a bottom sheet you can flick away (Base UI Drawer: follows the finger, dismisses on
 * distance or velocity); larger screens get a centred dialog. The choice is made when the dialog
 * opens and held until it has finished closing, so rotating the phone never remounts a half-filled form.
 */
function useSheet(open: boolean) {
  const phone = useMediaQuery(PHONE);
  const [held, setHeld] = React.useState<boolean | null>(null);
  if (open && held === null) setHeld(phone);
  const done = React.useCallback((o: boolean) => {
    if (!o) setHeld(null);
  }, []);
  return [held ?? phone, done] as const;
}

export function Dialog({ open, onOpenChange, title, description, children, footer, footerStart, size = "default", keepMounted, initialFocus }: DialogProps) {
  const [sheet, onComplete] = useSheet(open);
  const P = (sheet ? Drawer : BaseDialog) as typeof BaseDialog;
  const content = (
    <>
      {sheet && <div className={s.grabber} aria-hidden />}
      <div className={s.head}>
        <div className={s.headText}>
          <P.Title className={s.title}>{title}</P.Title>
          {description && <P.Description className={s.description}>{description}</P.Description>}
        </div>
        <P.Close render={<IconButton label="Close" size="sm" className={s.close} tooltip={false}><Xmark /></IconButton>} />
      </div>
      {children && <div className={s.body}>{children}</div>}
      {footer && (
        <div className={`${s.foot} ${children ? "" : s.noBorder}`}>
          {footerStart && <span className={s.footStart}>{footerStart}</span>}
          {footer}
        </div>
      )}
    </>
  );
  const popupClass = `${s.popup} ${size !== "default" ? s[size] : ""}`;

  if (sheet) {
    return (
      <Drawer.Root open={open} onOpenChange={(o) => onOpenChange(o)} onOpenChangeComplete={onComplete} swipeDirection="down">
        <Drawer.Portal keepMounted={keepMounted}>
          <Drawer.Backdrop className={`${s.backdrop} ${s.sheetBackdrop}`} data-motion-gentle="" />
          <Drawer.VirtualKeyboardProvider>
            <Drawer.Viewport className={s.viewport}>
              <Drawer.Popup className={`${popupClass} ${s.sheet}`} initialFocus={initialFocus} data-motion-gentle="">
                {content}
              </Drawer.Popup>
            </Drawer.Viewport>
          </Drawer.VirtualKeyboardProvider>
        </Drawer.Portal>
      </Drawer.Root>
    );
  }

  return (
    <BaseDialog.Root open={open} onOpenChange={(o) => onOpenChange(o)} onOpenChangeComplete={onComplete}>
      <BaseDialog.Portal keepMounted={keepMounted}>
        <BaseDialog.Backdrop className={s.backdrop} data-motion-gentle="" />
        <BaseDialog.Viewport className={s.viewport}>
          <BaseDialog.Popup className={popupClass} initialFocus={initialFocus} data-motion-gentle="">
            {content}
          </BaseDialog.Popup>
        </BaseDialog.Viewport>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

export interface ConfirmOptions {
  title: string;
  description?: React.ReactNode;
  /** Plain-language list of what will happen. */
  consequences?: React.ReactNode[];
  confirmLabel: string;
  cancelLabel?: string;
  variant?: ButtonVariant;
  /** Require typing this text (e.g. a disk name) before the button enables. */
  typeToConfirm?: string;
  /** Require pressing and holding the button (ms). */
  holdMs?: number;
  onConfirm: () => Promise<unknown> | unknown;
}

/**
 * The only way Gluon asks "are you sure". Destructive actions spell out consequences; the most
 * dangerous ones also require typing a name or holding the button.
 */
export function ConfirmDialog({ open, onOpenChange, ...o }: ConfirmOptions & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [typed, setTyped] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setTyped("");
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const ready = !o.typeToConfirm || typed.trim() === o.typeToConfirm;

  async function go() {
    setBusy(true);
    setError(null);
    try {
      await o.onConfirm();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  const confirmButton = o.holdMs ? (
    <HoldButton variant={o.variant ?? "dangerSolid"} holdMs={o.holdMs} disabled={!ready} loading={busy} onConfirm={go}>
      {busy ? "Working…" : `Hold to ${o.confirmLabel.toLowerCase()}`}
    </HoldButton>
  ) : (
    <Button variant={o.variant ?? "dangerSolid"} disabled={!ready} loading={busy} onClick={go}>
      {o.confirmLabel}
    </Button>
  );

  const hasBody = !!(o.consequences?.length || o.typeToConfirm || error);

  return (
    <AlertDialog.Root open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className={s.backdrop} data-motion-gentle="" />
        <AlertDialog.Viewport className={s.viewport}>
          <AlertDialog.Popup className={s.popup} data-motion-gentle="">
            <div className={s.head}>
              <div className={s.headText}>
                <AlertDialog.Title className={s.title}>{o.title}</AlertDialog.Title>
                {o.description && <AlertDialog.Description className={s.description}>{o.description}</AlertDialog.Description>}
              </div>
            </div>
            {hasBody && (
              <div className={s.body}>
                {o.consequences && o.consequences.length > 0 && (
                  <ul className={s.consequences}>
                    {o.consequences.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                )}
                {o.typeToConfirm && (
                  <label className={s.typeLabel}>
                    Type <code>{o.typeToConfirm}</code> to confirm
                    <Input
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
                      autoComplete="off"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      className={s.typeInput}
                      aria-label={`Type ${o.typeToConfirm} to confirm`}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && ready && !o.holdMs && !busy) void go();
                      }}
                    />
                  </label>
                )}
                {error && (
                  <p role="alert" className={s.error}>
                    {error}
                  </p>
                )}
              </div>
            )}
            <div className={`${s.foot} ${hasBody ? "" : s.noBorder}`}>
              <AlertDialog.Close render={<Button variant="ghost" disabled={busy} />}>{o.cancelLabel ?? "Cancel"}</AlertDialog.Close>
              {confirmButton}
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/** Imperative helper: `const confirm = useConfirm(); confirm({...})`. */
export function useConfirm() {
  const [state, setState] = React.useState<ConfirmOptions | null>(null);
  const [open, setOpen] = React.useState(false);
  // A fresh dialog per question, so the last one's typed text or error never shows for a frame.
  const [asked, setAsked] = React.useState(0);
  const ask = React.useCallback((o: ConfirmOptions) => {
    setState(o);
    setAsked((n) => n + 1);
    setOpen(true);
  }, []);
  const node = state ? <ConfirmDialog key={asked} {...state} open={open} onOpenChange={setOpen} /> : null;
  return [ask, node] as const;
}
