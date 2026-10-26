"use client";
import * as React from "react";
import { GluonMark } from "@/components/brand/GluonMark";
import { useRouter } from "next/navigation";
import { STEP_LABEL, type Plan, type StepId } from "@/lib/onboarding";
import { usePrefs } from "@/components/PrefsProvider";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toast";
import { FlowContext, type Flow } from "./flow";
import { Found } from "./steps/Found";
import { UpdatesStep } from "./steps/Updates";
import { NotifyStep } from "./steps/Notify";
import { PeopleStep } from "./steps/People";
import { SecurityStep } from "./steps/Security";
import { Summary } from "./steps/Summary";
import { Hello } from "./steps/Hello";
import { AppsStep } from "./steps/Apps";
import { Ready } from "./steps/Ready";
import o from "./onboarding.module.css";

const STEPS: Record<StepId, React.ComponentType> = {
  found: Found,
  updates: UpdatesStep,
  notify: NotifyStep,
  people: PeopleStep,
  security: SecurityStep,
  summary: Summary,
  hello: Hello,
  apps: AppsStep,
  ready: Ready,
};

/**
 * Remembers whether the last thing the person did was on the keyboard. Steps that change because
 * someone pressed Enter swap in place; a click gets the short slide.
 */
function useKeyboardLast() {
  const ref = React.useRef(false);
  React.useEffect(() => {
    const key = () => {
      ref.current = true;
    };
    const pointer = () => {
      ref.current = false;
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointerdown", pointer, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("pointerdown", pointer, true);
    };
  }, []);
  return ref;
}

/**
 * First run. One step on screen at a time; every move is saved to prefs.onboarding, so signing out
 * (or closing the tab) and coming back resumes on the same step. Finishing or skipping marks it done
 * and it never shows again.
 */
export function Welcome({ plan }: { plan: Plan }) {
  const router = useRouter();
  const { setPrefs, serverName } = usePrefs();
  const [step, setStep] = React.useState<StepId>(plan.start);
  const [enter, setEnter] = React.useState<"none" | "forward" | "back">("none");
  const [leaving, setLeaving] = React.useState(false);
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const keyboard = useKeyboardLast();
  const moved = React.useRef(false);

  const steps = plan.steps as StepId[];
  const at = Math.max(0, steps.indexOf(step));

  const go = React.useCallback(
    (to: StepId) => {
      const dir = steps.indexOf(to) > steps.indexOf(step) ? "forward" : "back";
      moved.current = true;
      setEnter(keyboard.current ? "none" : dir);
      setStep(to);
      // Progress is a convenience: if saving it fails, the flow still works; it just resumes earlier.
      setPrefs({ onboarding: to }).catch(() => undefined);
    },
    [steps, step, keyboard, setPrefs],
  );

  const finish = React.useCallback(
    (to = "/") => {
      if (leaving) return;
      setLeaving(true);
      setPrefs({ onboarding: "done" })
        .then(() => {
          router.replace(to);
          router.refresh();
        })
        .catch((e: unknown) => {
          setLeaving(false);
          toast.error("Couldn't finish setting up", { description: e instanceof Error ? e.message : "Check your connection and try again." });
        });
    },
    [leaving, router, setPrefs],
  );

  const next = React.useCallback(() => {
    const n = steps[at + 1];
    if (n) go(n);
    else finish();
  }, [steps, at, go, finish]);
  const back = at > 0 ? () => go(steps[at - 1]!) : undefined;

  // A new step: start at the top and put focus on its title (not on first load: the page just opened).
  React.useEffect(() => {
    if (!moved.current) return;
    window.scrollTo({ top: 0 });
    headingRef.current?.focus({ preventScroll: true });
  }, [step]);

  const flow: Flow = { plan, step, next, back, finish, leaving, headingRef };
  const Current = STEPS[step];
  const last = at === steps.length - 1;

  return (
    <FlowContext.Provider value={flow}>
      <div className={o.frame}>
        <header className={o.top}>
          <span className={o.server} title={serverName}>
            <GluonMark className={o.serverMark} />
            <span className={o.serverName}>{serverName}</span>
          </span>
          {!last && (
            <Button variant="ghost" size="sm" onClick={() => finish()} disabled={leaving}>
              {plan.role === "admin" ? "Skip setup" : "Skip to Home"}
            </Button>
          )}
        </header>
        <main className={o.column}>
          <Progress steps={steps} current={at} onJump={(i) => go(steps[i]!)} />
          <div key={step} className={o.stage} data-enter={enter} data-motion-gentle="">
            <Current />
          </div>
        </main>
      </div>
    </FlowContext.Provider>
  );
}

/**
 * Where you are: one hairline per step, filled as steps are done, with the current step's name.
 * Steps already done can be revisited. Phones show only the current name and "2 of 5".
 */
function Progress({ steps, current, onJump }: { steps: StepId[]; current: number; onJump: (i: number) => void }) {
  return (
    <nav className={o.progress} aria-label="Setup steps">
      <ol className={o.bars}>
        {steps.map((id, i) => {
          const state = i < current ? "done" : i === current ? "current" : "upcoming";
          const label = (
            <>
              <span className={o.barLabel}>{STEP_LABEL[id]}</span>
              <span className="sr-only">{state === "done" ? ", done" : state === "upcoming" ? ", to do" : ", current step"}</span>
            </>
          );
          return (
            <li key={id} className={o.bar} data-state={state} aria-current={state === "current" ? "step" : undefined}>
              <span className={o.barLine} aria-hidden data-motion-gentle="" />
              {state === "done" ? (
                <button type="button" className={o.barButton} onClick={() => onJump(i)}>
                  {label}
                </button>
              ) : (
                <span className={o.barText}>{label}</span>
              )}
            </li>
          );
        })}
      </ol>
      <p className={o.progressNow} aria-hidden>
        <b>{STEP_LABEL[steps[current]!]}</b>
        <span className="num">
          {current + 1} of {steps.length}
        </span>
      </p>
    </nav>
  );
}
