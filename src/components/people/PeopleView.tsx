"use client";
import * as React from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { NavArrowRight, UserPlus, Trash } from "iconoir-react";
import type { InviteView, PersonView, ProblemReport } from "@/lib/people-types";
import { api, ApiError, useApi } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Empty, Panel, Skeleton } from "@/components/ui/Surface";
import { SectionHeader } from "@/components/settings/SectionHeader";
import { peopleHref, type PeopleTab } from "@/lib/settings-links";
import { Button, IconButton } from "@/components/ui/Button";
import { StateLine } from "@/components/ui/StateLine";
import { Tabs } from "@/components/ui/Tabs";
import { Time } from "@/components/ui/Time";
import { useConfirm } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { InviteDialog } from "./InviteDialog";
import { Avatar, REPORTS_URL, reportStage, roleLabel } from "./bits";
import s from "./people.module.css";

// Each tab (and a person's page) is its own address, and only one shows: load just that one's code.
const loading = () => <Skeleton height={320} radius={12} />;
const AccessMap = dynamic(() => import("./AccessMap").then((m) => m.AccessMap), { loading });
const ReportsTab = dynamic(() => import("./ReportsTab").then((m) => m.ReportsTab), { loading });
const AnnouncementsTab = dynamic(() => import("./AnnouncementsTab").then((m) => m.AnnouncementsTab), { loading });
const Household = dynamic(() => import("@/components/settings/Household").then((m) => m.Household), { loading });
const PersonDetail = dynamic(() => import("./PersonDetail").then((m) => m.PersonDetail), { loading });

export type { PeopleTab };

/**
 * Settings → People: everyone who can sign in (and invites), who can open what, the household's
 * problem reports, announcements, and what new members start with. `person` opens one person.
 */
export function PeopleSettings({ tab, initialPeople, person, reportId }: { tab: PeopleTab; initialPeople: PersonView[]; person: PersonView | null; reportId: string | null }) {
  if (person) return <PersonDetail initial={person} />;
  return <PeopleView tab={tab} initialPeople={initialPeople} reportId={reportId} />;
}

function PeopleView({ tab, initialPeople, reportId }: { tab: PeopleTab; initialPeople: PersonView[]; reportId: string | null }) {
  const fmt = useFormat();
  const { data: people = initialPeople, mutate } = useApi<PersonView[]>("/api/people", { refresh: 30_000, fallbackData: initialPeople });
  const { data: invites, mutate: mutateInvites } = useApi<InviteView[]>("/api/people/invites", { refresh: 60_000 });
  const { data: reports } = useApi<ProblemReport[]>(REPORTS_URL, { refresh: 30_000 });
  const [inviting, setInviting] = React.useState(false);

  const newReports = reports?.filter((r) => reportStage(r) === "sent").length ?? 0;
  const members = people.filter((p) => p.role === "member").length;
  const off = people.filter((p) => p.disabled).length;
  const weakAdmins = people.filter((p) => p.role === "admin" && !p.mfa && !p.disabled).length;
  const summary = (
    <>
      {newReports > 0 && <b>{fmt.plural(newReports, "new problem report")} from the household. </b>}
      {people.length === 1 ? "Just you so far" : members === 0 ? `${fmt.plural(people.length, "admin")}, no household members yet` : `${fmt.plural(people.length - members, "admin")} and ${fmt.plural(members, "household member")}`}
      {off ? `, ${off} turned off` : ""}.{invites?.length ? ` ${fmt.plural(invites.length, "invite")} waiting to be used.` : ""}
      {weakAdmins ? (people.length === 1 ? " Two-step verification isn't on yet." : ` ${weakAdmins === 1 ? "One admin has" : `${weakAdmins} admins have`} no two-step verification.`) : ""}
    </>
  );

  return (
    <>
      <SectionHeader
        summary={summary}
        actions={
          <Button variant="primary" icon={<UserPlus />} onClick={() => setInviting(true)}>
            Invite someone
          </Button>
        }
      />
      <Tabs
        value={tab}
        hrefFor={(v) => peopleHref({ tab: v })}
        items={[
          { value: "people", label: "People", count: people.length },
          { value: "access", label: "Who can open what" },
          { value: "reports", label: "Problem reports", count: newReports || undefined, attention: newReports > 0 },
          { value: "announcements", label: "Announcements" },
          { value: "defaults", label: "New members" },
        ]}
        aria-label="People sections"
      />
      <div className={s.tabBody}>
        {tab === "people" && <PeopleList people={people} invites={invites} onInvitesChange={() => void mutateInvites()} onInvite={() => setInviting(true)} />}
        {tab === "access" && <AccessMap />}
        {tab === "reports" && <ReportsTab focus={reportId} />}
        {tab === "announcements" && <AnnouncementsTab />}
        {tab === "defaults" && <Household />}
      </div>
      <InviteDialog
        open={inviting}
        onOpenChange={setInviting}
        onCreated={() => {
          void mutateInvites();
          void mutate();
        }}
      />
    </>
  );
}

function PeopleList({ people, invites, onInvitesChange, onInvite }: { people: PersonView[]; invites: InviteView[] | undefined; onInvitesChange: () => void; onInvite: () => void }) {
  const router = useRouter();
  const [confirm, confirmNode] = useConfirm();

  const revoke = (i: InviteView) =>
    confirm({
      title: `Cancel the invite${i.displayName ? ` for ${i.displayName}` : ""}?`,
      consequences: ["The link stops working straight away.", "You can always make a new one."],
      confirmLabel: "Cancel invite",
      cancelLabel: "Keep it",
      onConfirm: async () => {
        try {
          await api.del("/api/people/invites", { id: i.id });
          toast.success("Invite cancelled");
          onInvitesChange();
        } catch (e) {
          if (!(e instanceof ApiError && e.code === "reauth_cancelled")) throw e;
        }
      },
    });

  return (
    <>
      <div className={s.table} role="table" aria-label="People">
        <div className={s.headRow} role="row">
          <span role="columnheader">Person</span>
          <span role="columnheader">Role</span>
          <span role="columnheader">Two-step</span>
          <span role="columnheader">Last seen</span>
          <span role="columnheader">Status</span>
          <span role="columnheader" className="sr-only">Open</span>
        </div>
        {people.map((p) => {
          const href = peopleHref({ person: p.id });
          return (
            <div
              key={p.id}
              role="row"
              className={s.row}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest("a,button")) return;
                router.push(href);
              }}
            >
              <span role="cell" className={s.who}>
                <Avatar name={p.displayName} off={p.disabled} />
                <span className={s.whoText}>
                  <Link href={href} className={s.whoName} title={p.displayName}>
                    {p.displayName}
                    {p.self ? " (you)" : ""}
                  </Link>
                  <span className={`${s.whoSub} mono`}>{p.username}</span>
                </span>
              </span>
              <span role="cell" className={s.role}>
                <span className={s.cellLabel}>Role</span>
                {roleLabel(p.role)}
              </span>
              <span role="cell" className={s.mfa}>
                <span className={s.cellLabel}>Two-step</span>
                {p.mfa ? "On" : <span className={s.muted}>Off</span>}
              </span>
              <span role="cell" className={s.seen}>
                <span className={s.cellLabel}>Seen</span>
                {p.lastSeenAt ? <Time ts={p.lastSeenAt} /> : p.lastLoginAt ? <Time ts={p.lastLoginAt} /> : <span className={s.muted}>Never signed in</span>}
              </span>
              <span role="cell" className={s.state}>
                {p.disabled ? (
                  <StateLine state="stopped" label="Turned off" />
                ) : p.mustChangePassword ? (
                  <StateLine state="starting" label="Must pick a new password" />
                ) : p.role === "admin" && !p.mfa ? (
                  <StateLine state="attention" label="Admin without two-step" />
                ) : (
                  p.sessions ? (
                    <StateLine state="running" label={`Signed in on ${p.sessions} device${p.sessions === 1 ? "" : "s"}`} />
                  ) : (
                    <StateLine state="stopped" label={p.lastLoginAt ? "Signed out" : "Hasn't signed in yet"} />
                  )
                )}
              </span>
              <span role="cell" className={s.go} aria-hidden>
                <NavArrowRight />
              </span>
            </div>
          );
        })}
      </div>

      <Panel title="Invites not used yet" meta={invites?.length ? <span className="num">{invites.length}</span> : undefined} flush>
        {!invites ? (
          <div className={s.skeletons}>
            <Skeleton height={44} />
          </div>
        ) : invites.length === 0 ? (
          <Empty title="No open invites" action={<Button onClick={onInvite}>Invite someone</Button>}>
            An invite is a one-time link that lets someone choose their own username and password. It works for 7 days.
          </Empty>
        ) : (
          <ul className={`${s.invites} appear`} role="list">
            {invites.map((i) => (
              <li key={i.id} className={s.invite}>
                <Avatar name={i.displayName ?? "?"} size={28} off />
                <span className={s.inviteText}>
                  <span>
                    {i.displayName ?? "Someone"} · {roleLabel(i.role)}
                  </span>
                  <span className={s.inviteSub}>
                    made <Time ts={i.createdAt} />, expires <Time ts={i.expiresAt} />
                  </span>
                  <InviteLife createdAt={i.createdAt} expiresAt={i.expiresAt} />
                </span>
                <IconButton label="Cancel invite" size="sm" onClick={() => revoke(i)}>
                  <Trash />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {invites && invites.length > 0 && <p className={s.hint}>For safety, Gluon only shows an invite link once, when it's made. If one was lost, cancel it and make a new one.</p>}
      {confirmNode}
    </>
  );
}

/** How much of an invite's week is left, as a hairline that shortens towards expiry. */
function InviteLife({ createdAt, expiresAt }: { createdAt: number; expiresAt: number }) {
  const [now] = React.useState(() => Date.now());
  const span = Math.max(1, expiresAt - createdAt);
  const left = Math.max(0, Math.min(1, (expiresAt - now) / span));
  return (
    <span className={s.life} role="meter" aria-label="Time left before the invite expires" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(left * 100)}>
      <i style={{ transform: `scaleX(${left})` }} data-low={left < 0.15 ? "" : undefined} />
    </span>
  );
}
