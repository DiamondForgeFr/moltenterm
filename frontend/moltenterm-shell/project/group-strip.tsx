// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The group strip of the Project tab (FR-MC-028): above the next station band, every member of the linked project's
// product with its state, the stale flags and their Sync. A click on another member switches to its workspace. It
// offers no Run CI, Build local, Release or Clean branches: those stay in each member's own workspace (DS-MC-012). A
// project in no product has no strip, and its tab stays as it was (FR-MC-028-AC5). What it says comes from
// group-strip-model.ts.

import { getApi } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useCallback, useMemo, useState } from "react";
import { useLocale, useT } from "../i18n/i18n";
import { RunningDot } from "../mission/action-button";
import { StripDependency, StripMember, stripMembers, StripTone, SyncArgs } from "../mission/group-strip-model";
import { startDependencySync } from "../mission/group-sync";
import { MoltenWave } from "../molten-button";
import { workspaceShownName } from "../workspace-default-name";
import { ProjectCardProps } from "./project-context";

const ToneText: Record<StripTone, string> = {
    ok: "text-success",
    bad: "text-danger",
    running: "text-accent",
    muted: "text-muted",
};

const ToneDot: Record<StripTone, string> = {
    ok: "bg-success",
    bad: "bg-error",
    running: "",
    muted: "bg-muted/60",
};

export type SyncStatus = { running?: boolean; error?: string };

function Dot({ tone }: { tone: StripTone }) {
    if (tone === "running") {
        return <RunningDot />;
    }
    return <span className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full", ToneDot[tone])} aria-hidden />;
}

function MemberHeader({ entry, onSwitch }: { entry: StripMember; onSwitch: (workspaceId: string) => void }) {
    const t = useT();
    const name = entry.member.name;
    if (entry.current) {
        return (
            <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-13 leading-5 font-semibold text-primary">{name}</span>
                <span
                    className="shrink-0 rounded-4 border border-accent/50 px-1.5 py-px text-11 font-semibold tracking-wide text-accent uppercase"
                    data-testid="group-strip-current"
                >
                    {t("project.group.thisWorkspace")}
                </span>
            </div>
        );
    }
    const workspace = entry.member.workspaces?.[0];
    if (entry.target == null) {
        return <span className="truncate text-13 leading-5 font-semibold text-primary">{name}</span>;
    }
    return (
        <button
            type="button"
            onClick={() => onSwitch(entry.target)}
            className="group/member flex min-w-0 cursor-pointer items-center gap-2 text-left"
            title={
                workspace?.name
                    ? t("project.group.switchNamed", { name: workspaceShownName(workspace.name, t) })
                    : t("project.group.switch")
            }
            data-testid="group-strip-switch"
        >
            <span className="truncate text-13 leading-5 font-semibold text-primary group-hover/member:underline">
                {name}
            </span>
            <i className="fa fa-solid fa-arrow-right shrink-0 text-11 text-muted group-hover/member:text-primary" />
        </button>
    );
}

function DependencyFlag({
    dep,
    status,
    onSync,
}: {
    dep: StripDependency;
    status: SyncStatus;
    onSync: (args: SyncArgs) => void;
}) {
    const t = useT();
    return (
        <div
            className="flex flex-col gap-1.5 rounded-4 border border-warning/40 bg-warning/10 px-2.5 py-2 text-12"
            data-testid="group-strip-stale"
        >
            <div className="flex items-center gap-2 font-semibold text-warning">
                <i className="fa fa-solid fa-triangle-exclamation text-11" />
                <span className="min-w-0 truncate" title={dep.title}>
                    {dep.title}
                </span>
            </div>
            {dep.paths.length > 0 ? (
                <div className="font-mono text-11 break-all text-secondary">
                    {dep.paths.join(", ")}
                    {dep.morePaths > 0 ? (
                        <span className="text-muted"> {t("project.group.more", { count: dep.morePaths })}</span>
                    ) : null}
                </div>
            ) : null}
            {dep.commits.length > 0 ? (
                <ul className="flex flex-col gap-0.5 text-11 text-secondary">
                    {dep.commits.map((c) => (
                        <li key={c.sha} className="flex min-w-0 gap-1.5">
                            <span className="shrink-0 font-mono text-muted">{c.sha}</span>
                            {c.tickets.map((ticket) => (
                                <span key={ticket} className="shrink-0 text-[var(--mt-accent)]">
                                    #{ticket}
                                </span>
                            ))}
                            <span className="min-w-0 truncate" title={c.subject}>
                                {c.subject}
                            </span>
                        </li>
                    ))}
                    {dep.moreCommits > 0 || dep.moreCommitsCapped ? (
                        <li className="text-muted">
                            {dep.moreCommits > 0
                                ? t("project.group.more", { count: dep.moreCommits })
                                : t("project.group.olderCommits")}
                        </li>
                    ) : null}
                </ul>
            ) : null}
            {dep.uncommitted.length > 0 ? (
                <div className="text-11 text-secondary">
                    {t("project.group.notCommitted")} <span className="font-mono">{dep.uncommitted.join(", ")}</span>
                    {dep.moreUncommitted > 0 ? (
                        <span className="text-muted"> {t("project.group.more", { count: dep.moreUncommitted })}</span>
                    ) : null}
                </div>
            ) : null}
            {dep.sync ? (
                <div className="flex flex-wrap items-center gap-2 pt-0.5">
                    <button
                        type="button"
                        className="molten-btn flex cursor-pointer items-center gap-1.5 rounded-6 px-2.5 py-1 text-12 font-medium disabled:cursor-default disabled:opacity-50"
                        disabled={status?.running || dep.syncing}
                        onClick={() => onSync(dep.sync)}
                        title={
                            dep.branch
                                ? t("project.group.syncTitleBranch", { source: dep.source, branch: dep.branch })
                                : t("project.group.syncTitle", { source: dep.source })
                        }
                        data-testid="group-strip-sync"
                    >
                        {status?.running || dep.syncing ? (
                            <RunningDot className="text-current" />
                        ) : (
                            <i className="fa fa-solid fa-rotate text-11" />
                        )}
                        {t("project.group.sync")}
                        <MoltenWave />
                    </button>
                    {status?.error ? (
                        <span className="text-11 text-danger">{status.error}</span>
                    ) : dep.syncNote ? (
                        <span
                            className={cn("text-11", dep.syncing ? "text-muted" : "text-danger")}
                            data-testid="group-strip-sync-note"
                        >
                            {dep.syncNote}
                        </span>
                    ) : null}
                </div>
            ) : (
                <div className="text-11 text-muted">{t("project.group.noSync")}</div>
            )}
        </div>
    );
}

function MemberEntry({
    entry,
    syncs,
    onSwitch,
    onSync,
}: {
    entry: StripMember;
    syncs: Record<string, SyncStatus>;
    onSwitch: (workspaceId: string) => void;
    onSync: (args: SyncArgs) => void;
}) {
    const t = useT();
    return (
        <li
            className={cn(
                "flex w-[300px] min-w-[240px] shrink-0 flex-col gap-2 rounded-6 border px-3 py-2.5",
                entry.current
                    ? "border-accent/60 bg-[color-mix(in_srgb,var(--mt-accent)_6%,transparent)]"
                    : "border-border",
                entry.flagged.length > 0 && !entry.current && "border-warning/50"
            )}
            aria-current={entry.current ? "true" : undefined}
            data-testid="group-strip-member"
            data-member={entry.member.name}
        >
            <MemberHeader entry={entry} onSwitch={onSwitch} />
            {entry.note ? <div className={cn("text-11", ToneText[entry.noteTone])}>{entry.note}</div> : null}
            {entry.facts.length > 0 ? (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-11">
                    {entry.facts.map((fact) => (
                        <div key={fact.key} className="contents">
                            <dt className="text-muted">{fact.label}</dt>
                            <dd
                                className={cn("flex min-w-0 items-center gap-1.5", ToneText[fact.tone])}
                                title={fact.title}
                            >
                                <Dot tone={fact.tone} />
                                <span className="truncate">{fact.value}</span>
                            </dd>
                        </div>
                    ))}
                </dl>
            ) : null}
            {entry.flagged.map((dep) => (
                <DependencyFlag
                    key={dep.key}
                    dep={dep}
                    status={dep.sync ? syncs[syncKey(dep.sync)] : null}
                    onSync={onSync}
                />
            ))}
            {entry.unresolved.length > 0 ? (
                <div className="text-11 text-muted" title={t("project.group.unresolvedTitle")}>
                    {entry.unresolved.join(" · ")}
                </div>
            ) : null}
        </li>
    );
}

export function syncKey(args: SyncArgs): string {
    return `${args.dir}\u0000${args.index}`;
}

export function GroupStripView({
    name,
    members,
    syncs,
    onSwitch,
    onSync,
}: {
    name: string;
    members: StripMember[];
    syncs: Record<string, SyncStatus>;
    onSwitch: (workspaceId: string) => void;
    onSync: (args: SyncArgs) => void;
}) {
    const t = useT();
    if (members.length === 0) {
        return null;
    }
    return (
        <section
            aria-label={t("project.group.aria", { name })}
            className="flex flex-col gap-2 border-b border-border px-4 py-3 @min-[42rem]:px-6"
            data-testid="group-strip"
        >
            <div className="flex items-baseline gap-2">
                <span className="text-11 font-semibold tracking-[0.14em] text-muted uppercase">
                    {t("project.group.product")}
                </span>
                <span className="text-13 font-semibold text-primary">{name}</span>
                <span className="text-11 text-muted">
                    {members.length === 1
                        ? t("project.group.repositoryOne")
                        : t("project.group.repositories", { count: members.length })}
                </span>
            </div>
            <ul className="flex items-start gap-2 overflow-x-auto pb-0.5">
                {members.map((entry) => (
                    <MemberEntry
                        key={entry.member.dir}
                        entry={entry}
                        syncs={syncs}
                        onSwitch={onSwitch}
                        onSync={onSync}
                    />
                ))}
            </ul>
        </section>
    );
}

export function GroupStrip({ project, group }: ProjectCardProps) {
    const [syncs, setSyncs] = useState<Record<string, SyncStatus>>({});
    const locale = useLocale();
    const workspaceId = project.workspace?.oid;
    const members = useMemo(
        () => (group == null ? [] : stripMembers(group, workspaceId, project.dir, Date.now())),
        [group, workspaceId, project.dir, locale]
    );
    const onSwitch = useCallback((target: string) => getApi().switchWorkspace(target), []);
    const onSync = useCallback(
        (args: SyncArgs) =>
            fireAndForget(async () => {
                const key = syncKey(args);
                setSyncs((current) => ({ ...current, [key]: { running: true } }));
                const result = await startDependencySync(args);
                setSyncs((current) => ({ ...current, [key]: result?.ok ? {} : { error: result?.error } }));
            }),
        []
    );
    if (group == null) {
        return null;
    }
    return <GroupStripView name={group.name} members={members} syncs={syncs} onSwitch={onSwitch} onSync={onSync} />;
}
