"use client";
import * as React from "react";
import { Toast as BaseToast } from "@base-ui/react/toast";
import { Xmark } from "iconoir-react";
import s from "./toast.module.css";

export const toastManager = BaseToast.createToastManager();

type Kind = "success" | "error" | "attention" | "loading" | "info";

interface ToastInput {
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  timeout?: number;
  id?: string;
}

function add(type: Kind, t: ToastInput) {
  return toastManager.add({
    id: t.id,
    type,
    title: t.title,
    description: t.description,
    timeout: t.timeout ?? (type === "error" ? 8000 : type === "loading" ? 0 : 4500),
    priority: type === "error" ? "high" : "low",
    actionProps: t.action ? { children: t.action.label, onClick: t.action.onClick } : undefined,
  });
}

/** Fire-and-forget notices. Call from anywhere on the client. */
export const toast = {
  success: (title: string, rest?: Omit<ToastInput, "title">) => add("success", { title, ...rest }),
  info: (title: string, rest?: Omit<ToastInput, "title">) => add("info", { title, ...rest }),
  attention: (title: string, rest?: Omit<ToastInput, "title">) => add("attention", { title, ...rest }),
  error: (title: string, rest?: Omit<ToastInput, "title">) => add("error", { title, ...rest }),
  loading: (title: string, rest?: Omit<ToastInput, "title">) => add("loading", { title, ...rest }),
  update: (id: string, type: Kind, t: ToastInput) =>
    toastManager.update(id, {
      type,
      title: t.title,
      description: t.description,
      timeout: t.timeout ?? (type === "error" ? 8000 : 4500),
    }),
  dismiss: (id?: string) => toastManager.close(id),
};

function List() {
  const { toasts } = BaseToast.useToastManager();
  return toasts.map((t) => (
    <BaseToast.Root key={t.id} toast={t} className={s.toast} swipeDirection={["right", "down"]} data-motion-gentle="">
      <BaseToast.Content className={s.content} data-motion-gentle="">
        <span className={s.mark} data-type={t.type} aria-hidden data-motion-gentle="" />
        <div className={s.text}>
          <BaseToast.Title className={s.title} />
          <BaseToast.Description className={s.description} />
        </div>
        <div className={s.actions}>
          {t.actionProps && <BaseToast.Action className={s.action} />}
          <BaseToast.Close className={s.close} aria-label="Dismiss">
            <Xmark />
          </BaseToast.Close>
        </div>
      </BaseToast.Content>
    </BaseToast.Root>
  ));
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  return (
    <BaseToast.Provider toastManager={toastManager} limit={3}>
      {children}
      <BaseToast.Portal>
        <BaseToast.Viewport className={s.viewport}>
          <List />
        </BaseToast.Viewport>
      </BaseToast.Portal>
    </BaseToast.Provider>
  );
}
