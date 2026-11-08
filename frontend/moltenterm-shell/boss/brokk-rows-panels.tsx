// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The Agents, Sessions and Téléchargements panels of Brokk's group (FR-BOSS-009, AC19, #2032). Agents and Sessions are
// the Sessions tab of #2003 split in two (brokk-rows-model.ts): the agents, and the terminals and SSH sessions the agents
// no longer crowd, each grouped by workspace, the current one first. Téléchargements is the #1992 section as it is, with
// its origin line. The group has no Usage panel any more (AC58, #2106).

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget, makeIconClass } from "@/util/util";
import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { AgentStateDotClasses } from "../agent-state-model";
import { DownloadsList } from "../downloads/downloads-view";
import { useLocale, useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { workspaceLabel } from "../notification-workspace";
import { DurableSessions } from "../sessions/sessions-store";
import { DominoLoader } from "../suite/suite";
import { homeFolder, openSessionsView, startTerminal } from "./boss-card-actions";
import { GoButton, SecondaryButton } from "./boss-card-buttons";
import { CardGroup, cardGroups, CardRow } from "./boss-card-model";
import { EmptyLine, PanelFrame, PanelProblem } from "./brokk-panel-frame";
import { agentGroups, rowCount, sessionGroups, taskOf } from "./brokk-rows-model";
import { goToWorkspace, WorkspaceTag } from "./brokk-workspace-tag";
import { BrokkActions } from "./use-brokk-actions";

const ConnDotClasses: Record<string, string> = {
    connected: "bg-success",
    reconnecting: "bg-warning",
    disconnected: "bg-error",
};

// The groups of the sessions the panels list, read from the Sessions view's own data.
export function useSessionGroups(now: number): { loaded: boolean; groups: CardGroup[] } {
    const data = useAtomValue(DurableSessions.getInstance().dataAtom, { store: globalStore });
    const workspace = useAtomValue(atoms.workspace, { store: globalStore });
    const locale = useLocale();
    const home = homeFolder();
    const groups = useMemo(
        () => cardGroups(data, workspace?.oid, home, now),
        // The words of a row follow the language.
        [data, workspace?.oid, home, now, locale]
    );
    return { loaded: data != null, groups };
}

function GroupHead({
    group,
    workspaces,
    currentId,
}: {
    group: CardGroup;
    workspaces: Map<string, Workspace>;
    currentId: string;
}) {
    const t = useT();
    const label = group.unplaced ? null : workspaceLabel(group.id, workspaces, currentId);
    return (
        <div className="mt-brokk-gh" data-testid="boss-card-group" data-group={group.id}>
            {group.unplaced ? (
                <>
                    <i className={cn(makeIconClass("link-slash", true), "text-11 text-warning")} aria-hidden />
                    <span className="min-w-0 truncate">{group.title}</span>
                </>
            ) : label != null ? (
                <WorkspaceTag label={label} onGo={() => goToWorkspace(label)} />
            ) : (
                <span className="min-w-0 truncate">{group.title}</span>
            )}
            <span className="mt-brokk-gp-count">{group.rows.length}</span>
            {group.current ? (
                <span className="rounded-4 bg-[var(--mt-action-wash)] px-1.5 text-11 leading-[16px] text-[var(--mt-action-text)]">
                    {t("sessions.view.thisWorkspace")}
                </span>
            ) : null}
        </div>
    );
}

function GoTo({ row, actions }: { row: CardRow; actions: BrokkActions }) {
    const t = useT();
    const label = row.shown ? t("boss.card.goTo") : t("boss.card.showIt");
    const aria = row.shown
        ? t("boss.card.goToName", { name: row.name })
        : t("boss.card.showItName", { name: row.name });
    const busy = actions.busyId === row.id;
    return (
        <button
            type="button"
            className={GoButton}
            disabled={busy || !row.canShow}
            title={row.canShow ? undefined : row.blockedTitle}
            aria-label={aria}
            data-testid="boss-card-go"
            data-go
            onClick={() => row.canShow && actions.goToSession(row.id, row.id)}
        >
            {busy ? <DominoLoader className="mr-1" /> : null}
            {label}
        </button>
    );
}

function HostChip({ row }: { row: CardRow }) {
    if (!row.host) {
        return null;
    }
    return (
        <span
            className="inline-flex max-w-[10rem] min-w-0 items-center gap-1 rounded-4 border border-border px-1.5 leading-[16px]"
            title={row.hostTitle}
            data-testid="boss-card-host"
        >
            <span
                className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full", ConnDotClasses[row.hostState])}
                aria-hidden
            />
            <span className="truncate">{row.host}</span>
        </span>
    );
}

function AgentRowView({ row, actions }: { row: CardRow; actions: BrokkActions }) {
    const t = useT();
    const task = taskOf(row);
    return (
        <li
            className="mt-brokk-row"
            style={{ paddingLeft: row.depth * 14 }}
            data-testid="brokk-agent-row"
            data-session={row.id}
            data-state={row.state}
        >
            <div className="mt-brokk-rh">
                <span className="mt-brokk-sd" data-testid="brokk-agent-mark" aria-hidden>
                    {row.state === "working" ? (
                        <DominoLoader className="mt-brokk-dom" />
                    ) : (
                        <span
                            className={cn(
                                "inline-block h-2 w-2 shrink-0 rounded-full",
                                AgentStateDotClasses[row.state] ?? AgentStateDotClasses.idle
                            )}
                        />
                    )}
                </span>
                <span className="mt-brokk-state" data-state={row.state} data-testid="boss-card-state">
                    {row.stateText}
                </span>
                {row.model ? <span className="mt-brokk-when">{row.model}</span> : null}
            </div>
            <div className="mt-brokk-rt" data-testid="boss-card-name">
                {row.name}
                {row.agentName ? <span className="font-normal text-secondary"> · {row.agentName}</span> : null}
            </div>
            <div className="mt-brokk-rs flex flex-wrap items-center gap-x-2 gap-y-0.5">
                {task ? <span data-testid="boss-card-project">{task}</span> : null}
                {row.branch ? (
                    <span className="inline-flex min-w-0 items-center gap-1 font-mono" data-testid="boss-card-branch">
                        <i className={cn(makeIconClass("code-branch", true), "shrink-0 text-10")} aria-hidden />
                        <span className="truncate">{row.branch}</span>
                    </span>
                ) : null}
                {row.up ? <span data-testid="boss-card-up">{t("sessions.up", { age: row.up })}</span> : null}
                <HostChip row={row} />
            </div>
            <div className="mt-brokk-ra">
                <GoTo row={row} actions={actions} />
            </div>
        </li>
    );
}

function SessionRowView({ row, actions }: { row: CardRow; actions: BrokkActions }) {
    const t = useT();
    return (
        <li className="mt-brokk-row" data-testid="brokk-session-row" data-session={row.id}>
            <div className="mt-brokk-rh">
                {row.host ? (
                    <span
                        className={cn("inline-block h-2 w-2 shrink-0 rounded-full", ConnDotClasses[row.hostState])}
                        aria-hidden
                    />
                ) : (
                    <i className={cn(makeIconClass("terminal", true), "text-10 text-muted")} aria-hidden />
                )}
                <span className="mt-brokk-state font-mono" data-testid="boss-card-state">
                    {row.stateText}
                </span>
                {row.up ? (
                    <span className="mt-brokk-when" data-testid="boss-card-up">
                        {t("sessions.up", { age: row.up })}
                    </span>
                ) : null}
            </div>
            <div className="mt-brokk-rt" data-testid="boss-card-name">
                {row.name}
            </div>
            <div className="mt-brokk-rs flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <HostChip row={row} />
                {row.project ? <span data-testid="boss-card-project">{row.project}</span> : null}
                {row.branch ? (
                    <span className="inline-flex min-w-0 items-center gap-1 font-mono" data-testid="boss-card-branch">
                        <i className={cn(makeIconClass("code-branch", true), "shrink-0 text-10")} aria-hidden />
                        <span className="truncate">{row.branch}</span>
                    </span>
                ) : null}
            </div>
            <div className="mt-brokk-ra">
                <GoTo row={row} actions={actions} />
                {row.canReconnect ? (
                    <button
                        type="button"
                        className={SecondaryButton}
                        disabled={actions.busyId === `reconnect|${row.id}`}
                        data-testid="brokk-session-reconnect"
                        onClick={() => actions.reconnect(row.id)}
                    >
                        {actions.busyId === `reconnect|${row.id}` ? <DominoLoader className="mr-1" /> : null}
                        {t("sessions.view.reconnect")}
                    </button>
                ) : null}
            </div>
        </li>
    );
}

function Groups({
    groups,
    workspaces,
    currentId,
    render,
}: {
    groups: CardGroup[];
    workspaces: Map<string, Workspace>;
    currentId: string;
    render: (row: CardRow) => React.ReactElement;
}) {
    return (
        <>
            {groups.map((group) => (
                <section key={group.id} aria-label={group.title}>
                    <GroupHead group={group} workspaces={workspaces} currentId={currentId} />
                    <ul className="flex flex-col">{group.rows.map((row) => render(row))}</ul>
                </section>
            ))}
        </>
    );
}

export function AgentsPanel({
    now,
    workspaces,
    actions,
    onClose,
}: {
    now: number;
    workspaces: Map<string, Workspace>;
    actions: BrokkActions;
    onClose: () => void;
}) {
    const t = useT();
    const workspace = useAtomValue(atoms.workspace, { store: globalStore });
    const { loaded, groups: all } = useSessionGroups(now);
    const groups = useMemo(() => agentGroups(all), [all]);
    return (
        <PanelFrame id="agents" title={t("boss.group.panels.agents")} count={rowCount(groups)} onClose={onClose}>
            {!loaded ? (
                <div className="flex items-center gap-2 py-3 text-12 text-secondary" data-testid="boss-card-loading">
                    <DominoLoader />
                    {t("sessions.view.loading")}
                </div>
            ) : groups.length === 0 ? (
                <EmptyLine text={t("boss.group.agentsEmpty")} testId="brokk-agents-empty" />
            ) : (
                <Groups
                    groups={groups}
                    workspaces={workspaces}
                    currentId={workspace?.oid}
                    render={(row) => <AgentRowView key={row.id} row={row} actions={actions} />}
                />
            )}
            <PanelProblem problem={actions.problem} />
        </PanelFrame>
    );
}

export function SessionsPanel({
    now,
    workspaces,
    actions,
    onLeave,
    onClose,
}: {
    now: number;
    workspaces: Map<string, Workspace>;
    actions: BrokkActions;
    onLeave: () => void;
    onClose: () => void;
}) {
    const t = useT();
    const workspace = useAtomValue(atoms.workspace, { store: globalStore });
    const { loaded, groups: all } = useSessionGroups(now);
    const groups = useMemo(() => sessionGroups(all), [all]);
    return (
        <PanelFrame id="sessions" title={t("boss.group.panels.sessions")} count={rowCount(groups)} onClose={onClose}>
            {!loaded ? (
                <div className="flex items-center gap-2 py-3 text-12 text-secondary" data-testid="boss-card-loading">
                    <DominoLoader />
                    {t("sessions.view.loading")}
                </div>
            ) : groups.length === 0 ? (
                <div className="flex flex-col items-start gap-2.5 py-3" data-testid="boss-card-empty">
                    <div className="text-12 text-secondary">{t("boss.group.sessionsEmpty")}</div>
                    <button
                        type="button"
                        className="molten-btn inline-flex h-row cursor-pointer items-center gap-1.5 rounded-6 px-3 text-12 font-medium"
                        data-testid="boss-card-new-terminal"
                        onClick={() => {
                            onLeave();
                            fireAndForget(() => startTerminal());
                        }}
                    >
                        {t("boss.card.newTerminal")}
                        <MoltenWave />
                    </button>
                </div>
            ) : (
                <Groups
                    groups={groups}
                    workspaces={workspaces}
                    currentId={workspace?.oid}
                    render={(row) => <SessionRowView key={row.id} row={row} actions={actions} />}
                />
            )}
            <div className="flex items-center justify-end py-2">
                <button
                    type="button"
                    className="molten-btn-secondary inline-flex cursor-pointer items-center gap-1.5 rounded-6 px-2.5 py-1 text-12 whitespace-nowrap"
                    data-testid="boss-card-open-sessions"
                    onClick={() => {
                        onLeave();
                        fireAndForget(() => openSessionsView());
                    }}
                >
                    <i className={cn(makeIconClass("layer-group", true), "text-11")} aria-hidden />
                    {t("boss.card.openSessions")}
                </button>
            </div>
            <PanelProblem problem={actions.problem} />
        </PanelFrame>
    );
}

export function DownloadsPanel({
    count,
    onLeave,
    onClose,
}: {
    count: number;
    onLeave: () => void;
    onClose: () => void;
}) {
    const t = useT();
    return (
        <PanelFrame id="downloads" title={t("boss.group.panels.downloads")} count={count} onClose={onClose}>
            <div className="-mx-3">
                <DownloadsList onLeave={onLeave} />
            </div>
        </PanelFrame>
    );
}
