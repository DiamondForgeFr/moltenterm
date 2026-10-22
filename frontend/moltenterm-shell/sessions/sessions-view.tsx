// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Sessions view (FR-SHELL-020): every durable terminal still running, local and SSH, grouped by workspace, the
// ones no pane shows first. A pane like CI/CD: it can stay open while you work. Since FR-SHELL-058 (DS-SHELL-100) it
// is a table at most 960 px wide: a checkbox, the name with its actions right after it (Show, Reconnect, End), the
// folder, the agent and when it was last active. Checked rows get the bulk actions of #389 in a bar above the table.
// The keyboard walks the rows (arrows, Home, End, Page keys), Enter shows, Delete ends, R reconnects, Space checks
// (Shift+Space checks the range), Escape clears the checks.

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { atoms, createBlockSplitHorizontally, getApi, getBlockMetaKeyAtom } from "@/app/store/global";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget, makeIconClass } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { agentStateLabel } from "../agent-state-model";
import { AgentStateDot } from "../agent-state-ui";
import { InterruptAction } from "../command-panel/agent-commands";
import { AgentInputs } from "../command-panel/agent-input-store";
import { EmptyState } from "../empty-state";
import { I18nModel, t as translate, useLocale, useT } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { openWebLink } from "../open-web-link";
import { sessionRowDragProps } from "../split/drop-zones";
import { whileShown } from "../tab-activity";
import { copyText } from "../term-copy/term-copy";
import { TermUpdateOutcome, updateAllSummary } from "../termupdate/termupdate-model";
import { TermUpdates } from "../termupdate/termupdate-store";
import { showToast } from "../toast-store";
import { everyInPanel, usePanelBlockId } from "../view360/offcarpet-model";
import {
    filterSessions,
    SessionsAgentMetaKey,
    sessionsFiltered,
    SessionsFolderMetaKey,
    SessionsStateMetaKey,
} from "../widget-options";
import { effectiveWorkspaceFolder } from "../workspace-project";
import { worktreeColor, WorktreeIcon } from "../worktree-model";
import { MergedPrMark, sessionMergedPr, useMergedPrs } from "./merged-prs";
import { showPane } from "./pane-focus";
import {
    BulkAction,
    BulkItem,
    bulkItems,
    BulkOptions,
    BulkResult,
    BulkRunners,
    checkState,
    CheckState,
    pruneSelected,
    rangeSelected,
    runBulk,
    sendResult,
    toggleAll,
    toggleSelected,
    unseenBulkSummary,
} from "./sessions-bulk";
import { BulkDialog, CleanupDialog, EndSessionDialog, UpdateAllDialog, UpdateSessionDialog } from "./sessions-dialogs";
import {
    activityTitle,
    agentCell,
    canInterrupt,
    canReconnect,
    canUpdate,
    cleanupResultText,
    connChip,
    contextLinks,
    DurableSession,
    flattenGroups,
    formatAge,
    groupSessions,
    HiddenGroupId,
    lastActive,
    modelText,
    MoltentermSessionsView,
    moveSelection,
    nextSelection,
    placeColumn,
    prStateLabel,
    reasonLabel,
    reasonTitle,
    rowAriaLabel,
    rowName,
    SessionGroup,
    sessionKind,
    sessionKindLabel,
    sessionName,
    sessionsSummary,
    sessionWhat,
    showLabel,
    startedFrom,
    VersionMark,
    versionMark,
} from "./sessions-model";
import { DurableSessions } from "./sessions-store";
import "./sessions.css";

export { MoltentermSessionsView };

const AgeRefreshMs = 15000;
const NavKeys = new Set(["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"]);

// DS-SHELL-100: select, name, actions, folder, agent, last active. Rows are subgrids of the table, so the actions
// column is as wide as the widest row's actions and every column lines up. A narrow pane (#533) drops the folder
// column (it is in the name's tooltip) and lays the actions over the row's end on hover, so the name and the agent
// keep the width.
const TableColumns =
    "grid grid-cols-[28px_minmax(0,1fr)_minmax(0,max-content)_minmax(56px,auto)] @2xl:grid-cols-[28px_minmax(160px,1.6fr)_auto_minmax(150px,1fr)_minmax(120px,auto)_minmax(64px,auto)]";
const FolderCell = "hidden @2xl:block";
const ActionsCell =
    "absolute top-1/2 right-1 -translate-y-1/2 rounded-6 bg-surface-2 px-1 shadow-e1 @2xl:static @2xl:translate-y-0 @2xl:bg-transparent @2xl:px-0 @2xl:shadow-none";
const RowGrid = "col-span-full grid grid-cols-subgrid items-center";

const RowButton =
    "molten-btn-ghost molten-tone-accent cursor-pointer rounded-6 px-2 py-0.5 text-11 whitespace-nowrap disabled:opacity-50";
const RowDangerButton =
    "molten-btn-ghost cursor-pointer rounded-6 px-2 py-0.5 text-11 whitespace-nowrap text-danger disabled:opacity-50";
const BarButton =
    "molten-btn-secondary cursor-pointer rounded-6 px-2.5 py-1 text-12 whitespace-nowrap disabled:opacity-50";
const CheckboxClass = "molten-check";

const ConnDotClasses: Record<string, string> = {
    connected: "bg-success",
    reconnecting: "bg-warning animate-pulse",
    disconnected: "bg-error",
};

export class SessionsViewModel implements ViewModel {
    viewType = MoltentermSessionsView;
    blockId: string;
    nodeModel: BlockNodeModel;
    viewIcon = atom("layer-group");
    viewName = atom((get) => {
        get(I18nModel.getInstance().localeAtom);
        return translate("sessions.title");
    });
    noPadding = atom(true);

    constructor({ blockId, nodeModel }: ViewModelInitType) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
    }

    get viewComponent(): ViewComponent {
        return SessionsView;
    }
}

let homeDir: string = null;

function getHomeDir(): string {
    if (homeDir == null) {
        try {
            homeDir = getApi()?.getHomeDir?.() ?? "";
        } catch {
            homeDir = "";
        }
    }
    return homeDir;
}

type Dialog =
    | { kind: "end"; id: string }
    | { kind: "update"; id: string }
    | { kind: "updateAll"; ids: string[] }
    | { kind: "cleanup"; ids: string[] }
    | { kind: "bulk"; action: BulkAction; ids: string[]; snapshot: DurableSession[] };
type Notice = { text: string; error?: boolean };

// A local session at home needs no chip: only another host, or a connection that is not up, is worth a mark.
function ConnectionChip({ session }: { session: DurableSession }) {
    const chip = connChip(session);
    if (!session.connection && chip.state === "connected") {
        return null;
    }
    return (
        <span
            className="inline-flex max-w-[10rem] min-w-0 shrink items-center gap-1 rounded-4 border border-border px-1.5 text-11 leading-[16px] text-secondary"
            title={chip.title}
        >
            <span className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full", ConnDotClasses[chip.state])} />
            <span className="truncate">{chip.label}</span>
        </span>
    );
}

// In a narrow pane the worktree column is gone: the name line keeps its chip.
function WorktreeMark({ session }: { session: DurableSession }) {
    const t = useT();
    const wt = session.worktree;
    if (wt == null) {
        return null;
    }
    return (
        <span
            className={cn(
                "inline-flex max-w-[9rem] min-w-0 shrink items-center gap-1 rounded-4 border px-1.5 text-11 leading-[16px] @2xl:hidden",
                worktreeColor(wt.path)
            )}
            title={
                wt.branch
                    ? t("sessions.view.worktreeOn", { path: wt.path, branch: wt.branch })
                    : t("sessions.view.worktree", { path: wt.path })
            }
        >
            <i className={cn("fa fa-solid shrink-0 text-11", `fa-${WorktreeIcon}`)} />
            <span className="truncate">{wt.branch || wt.path.split("/").pop()}</span>
        </span>
    );
}

// Direct, or the MoltenTerm action that started the session (#933).
function KindChip({ session }: { session: DurableSession }) {
    const t = useT();
    const label = sessionKindLabel(session);
    if (sessionKind(session) === "direct") {
        return (
            <span className="shrink-0 text-11 whitespace-nowrap text-muted" title={t("sessions.kindTitle.direct")}>
                {label}
            </span>
        );
    }
    return (
        <span
            className="inline-flex shrink-0 items-center gap-1 rounded-4 bg-accent/15 px-1.5 text-11 leading-[16px] whitespace-nowrap text-accent"
            title={t("sessions.kindTitle.started", { action: label })}
            data-testid="session-kind-started"
        >
            <i className={cn(makeIconClass("wand-magic-sparkles", true), "text-10")} aria-hidden="true" />
            {label}
        </span>
    );
}

const PrStateClasses: Record<string, string> = {
    open: "bg-success/15 text-success",
    draft: "bg-surface-2 text-secondary",
    merged: "bg-accent/15 text-accent",
    closed: "bg-error/15 text-danger",
};

function ContextLinks({ session }: { session: DurableSession }) {
    const t = useT();
    const links = contextLinks(session);
    if (links.length === 0) {
        return null;
    }
    return (
        <>
            {links.map((link) => {
                const body = (
                    <>
                        {link.kind === "pr" ? (
                            <i className={cn(makeIconClass("code-pull-request", true), "text-10")} aria-hidden="true" />
                        ) : null}
                        <span>{link.label}</span>
                        {link.state ? (
                            <span className={cn("rounded-4 px-1 leading-[14px]", PrStateClasses[link.state])}>
                                {prStateLabel(link.state)}
                            </span>
                        ) : null}
                    </>
                );
                const className =
                    "inline-flex shrink-0 items-center gap-1 rounded-4 text-11 whitespace-nowrap text-secondary";
                if (!link.url) {
                    return (
                        <span key={link.kind} className={className} title={link.title}>
                            {body}
                        </span>
                    );
                }
                return (
                    <button
                        key={link.kind}
                        type="button"
                        tabIndex={-1}
                        className={cn(className, "cursor-pointer hover:text-primary hover:underline")}
                        title={link.title}
                        aria-label={t("sessions.context.openLink", { what: link.label })}
                        data-testid={`session-context-${link.kind}`}
                        onClick={(e) => {
                            e.stopPropagation();
                            fireAndForget(() => openWebLink(link.url));
                        }}
                    >
                        {body}
                    </button>
                );
            })}
        </>
    );
}

function AgentCellView({ session }: { session: DurableSession }) {
    useT();
    const cell = agentCell(session);
    if (cell.kind === "agent") {
        const model = modelText(session);
        return (
            <span className="flex min-w-0 flex-col">
                <span className="flex min-w-0 items-center gap-1.5">
                    <AgentStateDot
                        info={{
                            blockid: session.blockid ?? session.id,
                            agent: session.agent,
                            agentname: session.agentname,
                            state: (session.agentstate || "idle") as any,
                            version: 0,
                        }}
                    />
                    <span className="truncate text-12 text-primary">{cell.label}</span>
                    <span className="shrink-0 text-11 text-muted">{agentStateLabel(session.agentstate || "idle")}</span>
                </span>
                {model ? (
                    <span className="truncate pl-3.5 text-11 text-muted" data-testid="session-model">
                        {model}
                    </span>
                ) : null}
            </span>
        );
    }
    return (
        <span className="flex min-w-0 items-center gap-1.5" title={session.command}>
            <i className={cn(makeIconClass("terminal", true), "w-3 shrink-0 text-11 text-muted")} />
            <span
                className={cn(
                    "truncate",
                    cell.kind === "command" ? "font-mono text-11 text-secondary" : "text-12 text-muted"
                )}
            >
                {cell.label}
            </span>
        </span>
    );
}

// A native checkbox, so screen readers and the keyboard get the real control; the table's own Space works on rows.
function Check({
    state,
    label,
    onToggle,
    tabIndex,
}: {
    state: CheckState;
    label: string;
    onToggle: (shift: boolean) => void;
    tabIndex?: number;
}) {
    const ref = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (ref.current) {
            ref.current.indeterminate = state === "some";
        }
    }, [state]);
    return (
        <input
            ref={ref}
            type="checkbox"
            className={CheckboxClass}
            aria-label={label}
            checked={state === "all"}
            tabIndex={tabIndex}
            onChange={() => {}}
            onClick={(e) => {
                e.stopPropagation();
                onToggle(e.shiftKey);
            }}
            onKeyDown={(e) => {
                // Space on the checkbox toggles it natively; keep it from the row's own Space.
                if (e.key === " ") {
                    e.stopPropagation();
                }
            }}
        />
    );
}

function VersionChip({ mark }: { mark: VersionMark }) {
    const t = useT();
    if (mark !== "outdated") {
        return null;
    }
    return (
        <span
            className="shrink-0 rounded-4 bg-warning/15 px-1 text-11 whitespace-nowrap text-warning"
            title={t("sessions.view.outdatedTitle")}
            data-testid="session-outdated"
        >
            {t("sessions.view.outdated")}
        </span>
    );
}

// The worktree column: the branch in full (wrapping rather than cut), the path on hover; a click copies the path.
function PlaceCell({ session, home, onCopied }: { session: DurableSession; home: string; onCopied: () => void }) {
    const t = useT();
    const place = placeColumn(session, home);
    if (!place.label) {
        return <span className="text-muted">—</span>;
    }
    const wt = session.worktree;
    return (
        <button
            type="button"
            tabIndex={-1}
            className={cn(
                "flex max-w-full min-w-0 cursor-pointer items-start gap-1 text-left font-mono text-11 break-all hover:text-primary",
                wt != null ? "text-primary" : "text-secondary"
            )}
            title={t("sessions.view.copyPathTitle", { title: place.title })}
            data-testid="session-place"
            onClick={(e) => {
                e.stopPropagation();
                copyText(place.copy);
                onCopied();
            }}
        >
            {wt != null ? (
                <i
                    className={cn("fa fa-solid mt-0.5 shrink-0 text-10", `fa-${WorktreeIcon}`, worktreeColor(wt.path))}
                    aria-hidden="true"
                />
            ) : null}
            <span className="line-clamp-2">{place.label}</span>
        </button>
    );
}

function SessionRow({
    session,
    depth,
    parentName,
    focused,
    checked,
    busy,
    home,
    now,
    version,
    mergedPr,
    rowRef,
    onFocusRow,
    onCheck,
    onShow,
    onEnd,
    onReconnect,
    onInterrupt,
    onUpdate,
    onCopied,
}: {
    session: DurableSession;
    depth: number;
    parentName: string;
    focused: boolean;
    checked: boolean;
    busy: string;
    home: string;
    now: number;
    version: VersionMark;
    mergedPr: number;
    rowRef: (elem: HTMLDivElement) => void;
    onFocusRow: () => void;
    onCheck: (shift: boolean) => void;
    onShow: () => void;
    onEnd: () => void;
    onReconnect: () => void;
    onInterrupt: () => void;
    onUpdate: (() => void) | null;
    onCopied: () => void;
}) {
    const t = useT();
    const locale = useLocale();
    const name = sessionName(session, home);
    const shownName = rowName(session, home);
    const active = lastActive(session, now);
    const up = formatAge(session.startedat, now);
    const from = startedFrom(session);
    const tabIndex = focused ? 0 : -1;
    const showTitle = session.canshow ? t("sessions.view.joinTitle") : reasonTitle(session.reason);
    const activeTitle = activityTitle(session, now, locale);
    return (
        <div
            ref={rowRef}
            role="row"
            tabIndex={tabIndex}
            aria-selected={checked}
            data-session-row={session.id}
            aria-label={rowAriaLabel(session, home, now, mergedPr)}
            onFocus={(e) => {
                if (e.target === e.currentTarget) {
                    onFocusRow();
                }
            }}
            onClick={onFocusRow}
            onDoubleClick={() => session.canshow && onShow()}
            {...sessionRowDragProps(session, sessionWhat(session))}
            className={cn(
                RowGrid,
                "group relative min-h-11 cursor-pointer rounded-6 py-1 transition-colors duration-120 ease-mt outline-none hover:bg-hover focus-visible:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--mt-focus-ring)",
                checked && "bg-accent/10",
                focused && !checked && "bg-hover/60"
            )}
        >
            <div role="cell" className="flex items-center justify-center self-start pt-0.5">
                <Check
                    state={checked ? "all" : "none"}
                    label={t("sessions.view.selectRow", { name: shownName, what: sessionWhat(session) })}
                    onToggle={onCheck}
                    tabIndex={tabIndex}
                />
            </div>
            <div
                role="cell"
                className="flex min-w-0 items-start gap-1.5 pr-1"
                style={depth > 0 ? { paddingLeft: `${Math.min(depth, 3) * 14}px` } : undefined}
            >
                {depth > 0 ? (
                    <i
                        className={cn(makeIconClass("turn-up", true), "mt-1 shrink-0 rotate-90 text-10 text-muted")}
                        title={parentName ? t("sessions.subSession", { name: parentName }) : undefined}
                        aria-hidden="true"
                    />
                ) : null}
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex min-w-0 items-center gap-1.5">
                        <span
                            className="max-w-[16rem] min-w-[3rem] shrink truncate text-12 font-medium text-primary"
                            title={[session.tabname || name, session.folder].filter((p) => !!p).join(" · ")}
                            data-testid="session-name"
                        >
                            {shownName}
                        </span>
                        <KindChip session={session} />
                        {session.reason ? (
                            <span
                                className={cn(
                                    "shrink-0 rounded-4 px-1 text-11 whitespace-nowrap",
                                    session.reason === "ending"
                                        ? "bg-error/15 text-primary"
                                        : "bg-warning/15 text-warning"
                                )}
                                title={reasonTitle(session.reason)}
                            >
                                {reasonLabel(session.reason)}
                            </span>
                        ) : null}
                        <VersionChip mark={version} />
                        <WorktreeMark session={session} />
                        <MergedPrMark session={session} pr={mergedPr} />
                        <ConnectionChip session={session} />
                    </div>
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-11 text-muted">
                        {from ? (
                            <span className="min-w-0 truncate" data-testid="session-from">
                                {t("sessions.from.label", { where: from })}
                            </span>
                        ) : null}
                        <ContextLinks session={session} />
                    </div>
                </div>
            </div>
            <div
                role="cell"
                className={cn(
                    ActionsCell,
                    "pointer-events-none flex items-center gap-0.5 pr-2 opacity-0 transition-opacity duration-120 ease-mt group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 motion-reduce:transition-none",
                    busy && "pointer-events-auto opacity-100"
                )}
            >
                {busy ? <span className="px-1 text-11 whitespace-nowrap text-muted">{busy}</span> : null}
                {canReconnect(session) ? (
                    <button
                        type="button"
                        tabIndex={tabIndex}
                        className={RowButton}
                        disabled={!!busy}
                        onClick={(e) => {
                            e.stopPropagation();
                            onReconnect();
                        }}
                    >
                        {t("sessions.view.reconnect")}
                    </button>
                ) : null}
                <button
                    type="button"
                    tabIndex={tabIndex}
                    className={RowButton}
                    disabled={!!busy || !session.canshow}
                    title={showTitle}
                    data-testid="session-join"
                    onClick={(e) => {
                        e.stopPropagation();
                        onShow();
                    }}
                >
                    {session.shown ? t("sessions.view.join") : showLabel(session)}
                </button>
                {canInterrupt(session) ? (
                    <button
                        type="button"
                        tabIndex={tabIndex}
                        className={RowButton}
                        disabled={!!busy}
                        title={t("sessions.view.interruptTitle")}
                        data-testid="session-interrupt"
                        onClick={(e) => {
                            e.stopPropagation();
                            onInterrupt();
                        }}
                    >
                        {t("sessions.view.interrupt")}
                    </button>
                ) : null}
                {onUpdate != null ? (
                    <button
                        type="button"
                        tabIndex={tabIndex}
                        className={RowButton}
                        disabled={!!busy}
                        title={t("sessions.view.outdatedTitle")}
                        data-testid="session-update"
                        onClick={(e) => {
                            e.stopPropagation();
                            onUpdate();
                        }}
                    >
                        {t("sessions.view.update")}
                    </button>
                ) : null}
                <button
                    type="button"
                    tabIndex={tabIndex}
                    className={RowDangerButton}
                    disabled={!!busy || !session.canend}
                    title={session.canend ? undefined : reasonTitle(session.reason)}
                    data-testid="session-stop"
                    onClick={(e) => {
                        e.stopPropagation();
                        onEnd();
                    }}
                >
                    {t("sessions.view.stop")}
                </button>
            </div>
            <div role="cell" className={cn(FolderCell, "min-w-0 pr-3")}>
                <PlaceCell session={session} home={home} onCopied={onCopied} />
            </div>
            <div role="cell" className="min-w-0 self-start pt-0.5 pr-3">
                <AgentCellView session={session} />
            </div>
            <div
                role="cell"
                className="flex flex-col items-end self-start pt-0.5 pr-2 text-11 whitespace-nowrap text-muted"
                title={activeTitle}
                data-testid="session-activity"
            >
                <span>{active}</span>
                {up ? <span>{t("sessions.up", { age: up })}</span> : null}
            </div>
        </div>
    );
}

function GroupHeader({
    group,
    checks,
    onCheckAll,
    onCleanup,
}: {
    group: SessionGroup;
    checks: CheckState;
    onCheckAll: () => void;
    onCleanup: () => void;
}) {
    const t = useT();
    const hidden = group.id === HiddenGroupId;
    const endable = group.sessions.filter((s) => s.canend).length;
    return (
        <div role="row" className={cn(RowGrid, "group h-9")}>
            <div role="cell" className="flex items-center justify-center">
                <Check
                    state={checks}
                    label={t("sessions.view.selectGroup", { group: group.title })}
                    onToggle={onCheckAll}
                />
            </div>
            <div role="cell" className="col-[2/-1] flex min-w-0 items-center gap-2">
                {hidden ? (
                    <i className={cn(makeIconClass("link-slash", true), "text-11 text-warning")} />
                ) : (
                    <span
                        className="inline-block h-2.5 w-2.5 shrink-0 rounded-4"
                        style={{ background: group.color || "var(--border-color)" }}
                        aria-hidden="true"
                    />
                )}
                <span className="truncate text-12 font-semibold text-primary">{group.title}</span>
                <span className="shrink-0 rounded-4 bg-surface-2 px-1.5 text-11 leading-[16px] text-secondary">
                    {group.sessions.length}
                </span>
                {group.current ? (
                    <span className="shrink-0 rounded-4 bg-accent/15 px-1.5 text-11 leading-[16px] text-accent">
                        {t("sessions.view.thisWorkspace")}
                    </span>
                ) : null}
                {hidden && endable > 0 ? (
                    <button type="button" className={cn(RowDangerButton, "mr-1 ml-auto")} onClick={onCleanup}>
                        {t("sessions.view.endAll", { count: endable })}
                    </button>
                ) : null}
            </div>
        </div>
    );
}

function TableHeader({ checks, onCheckAll }: { checks: CheckState; onCheckAll: () => void }) {
    const t = useT();
    const head = "text-11 font-medium text-muted";
    return (
        <div
            role="row"
            className={cn(RowGrid, "group sticky top-0 z-[1] mb-1 h-8 border-b border-border bg-surface-1")}
        >
            <div role="columnheader" className="flex items-center justify-center">
                <Check state={checks} label={t("sessions.view.selectAll")} onToggle={onCheckAll} />
            </div>
            <div role="columnheader" className={head}>
                {t("sessions.view.colName")}
            </div>
            <div role="columnheader" className="hidden @2xl:block">
                <span className="sr-only">{t("sessions.view.colActions")}</span>
            </div>
            <div role="columnheader" className={cn(FolderCell, head)}>
                {t("sessions.view.colWorktree")}
            </div>
            <div role="columnheader" className={head}>
                {t("sessions.view.colAgent")}
            </div>
            <div role="columnheader" className={cn(head, "pr-2 text-right")}>
                {t("sessions.view.colActivity")}
            </div>
        </div>
    );
}

function SelectionBar({
    count,
    sessions,
    onAction,
    onClear,
}: {
    count: number;
    sessions: DurableSession[];
    onAction: (action: BulkAction) => void;
    onClear: () => void;
}) {
    const t = useT();
    const reach = (action: BulkAction) => bulkItems(action, sessions).filter((i) => !i.skip).length;
    const agents = reach("restart");
    const endable = reach("end");
    return (
        <div
            role="toolbar"
            aria-label={t("sessions.dialog.selected")}
            data-testid="sessions-selection-bar"
            className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-6 border border-accent/40 bg-surface-2 px-2 py-1.5 shadow-e1"
        >
            <span className="px-1 text-12 font-medium whitespace-nowrap text-primary" aria-live="polite">
                {t("sessions.view.selectedCount", { count })}
            </span>
            <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
            <button
                type="button"
                className={BarButton}
                disabled={agents === 0}
                title={agents === 0 ? t("sessions.view.noAgentSelected") : undefined}
                onClick={() => onAction("send")}
            >
                <i className={cn(makeIconClass("terminal", true), "mr-1.5 text-11")} />
                {t("sessions.view.sendCommand")}
            </button>
            <button
                type="button"
                className={BarButton}
                disabled={agents === 0}
                title={agents === 0 ? t("sessions.view.noAgentSelected") : undefined}
                onClick={() => onAction("restart")}
            >
                <i className={cn(makeIconClass("rotate-right", true), "mr-1.5 text-11")} />
                {t("sessions.view.restart")}
            </button>
            <button
                type="button"
                className={cn(BarButton, "text-danger hover:text-danger")}
                disabled={endable === 0}
                onClick={() => onAction("end")}
            >
                <i className={cn(makeIconClass("power-off", true), "mr-1.5 text-11")} />
                {t("sessions.view.end")}
            </button>
            <button
                type="button"
                className="molten-btn-ghost ml-auto cursor-pointer rounded-6 px-2 py-1 text-12"
                onClick={onClear}
            >
                {t("sessions.view.clear")}
            </button>
        </div>
    );
}

// A terminal opens beside the Sessions pane, which stays where it is.
function startTerminal(sessionsBlockId: string) {
    fireAndForget(async () => {
        await createBlockSplitHorizontally({ meta: { view: "term", controller: "shell" } }, sessionsBlockId, "before");
    });
}

function SessionsEmpty({ blockId }: { blockId: string }) {
    const t = useT();
    return (
        <EmptyState
            icon="layer-group"
            title={t("sessions.view.emptyTitle")}
            hint={t("sessions.view.emptyHint")}
            primary={{
                label: t("sessions.view.startTerminal"),
                onClick: () => startTerminal(blockId),
                testId: "sessions-start-terminal",
            }}
            className="flex-1"
            testId="sessions-empty"
        />
    );
}

// Filters set from the command panel (FR-SHELL-049) hide every running session: the list says so and clears them.
function SessionsFilteredOut({ blockId }: { blockId: string }) {
    const t = useT();
    const clear = () =>
        fireAndForget(() =>
            RpcApi.SetMetaCommand(TabRpcClient, {
                oref: WOS.makeORef("block", blockId),
                meta: {
                    [SessionsAgentMetaKey]: null,
                    [SessionsFolderMetaKey]: null,
                    [SessionsStateMetaKey]: null,
                } as MetaType,
            })
        );
    return (
        <EmptyState
            icon="filter"
            title={t("sessions.view.filteredTitle")}
            hint={t("sessions.view.filteredHint")}
            primary={{ label: t("sessions.view.clearFilters"), onClick: clear, testId: "sessions-clear-filters" }}
            className="flex-1"
            testId="sessions-filtered-out"
        />
    );
}

const ToastKinds = { done: "success", skipped: "warning", failed: "error" } as const;

function SessionsView({ blockId }: ViewComponentProps<SessionsViewModel>) {
    const t = useT();
    const store = DurableSessions.getInstance();
    const data = useAtomValue(store.dataAtom);
    const workspace = useAtomValue(atoms.workspace);
    const agentFilter = useAtomValue(getBlockMetaKeyAtom(blockId, SessionsAgentMetaKey as keyof MetaType));
    const folderFilter = useAtomValue(getBlockMetaKeyAtom(blockId, SessionsFolderMetaKey as keyof MetaType));
    const stateFilter = useAtomValue(getBlockMetaKeyAtom(blockId, SessionsStateMetaKey as keyof MetaType));
    const termUpdates = TermUpdates.getInstance();
    const outdated = useAtomValue(termUpdates.dataAtom);
    const [now, setNow] = useState(Date.now());
    const [focused, setFocused] = useState<string>(null);
    const [checked, setChecked] = useState<Set<string>>(() => new Set());
    const [anchor, setAnchor] = useState<string>(null);
    const [dialog, setDialog] = useState<Dialog>(null);
    const [notice, setNotice] = useState<Notice>(null);
    const [busy, setBusy] = useState<Record<string, string>>({});
    const rowRefs = useRef(new Map<string, HTMLDivElement>());
    const listRef = useRef<HTMLDivElement>(null);
    const prevOrder = useRef<string[]>([]);
    const focusWanted = useRef(false);
    const home = getHomeDir();
    const panelId = usePanelBlockId();

    useEffect(() => {
        return everyInPanel(panelId, whileShown(AgeRefreshMs), () => setNow(Date.now()), "clock");
    }, [panelId]);

    const allSessions = data?.sessions ?? [];
    const filters = { agent: agentFilter, folder: folderFilter, state: stateFilter };
    const filtered = sessionsFiltered(filters);
    const workspaceFolder = effectiveWorkspaceFolder(workspace);
    const sessions = useMemo(
        () => (filtered ? filterSessions(allSessions, filters, workspaceFolder) : allSessions),
        [data, filtered, agentFilter, folderFilter, stateFilter, workspaceFolder]
    );
    const groups = useMemo(() => groupSessions(sessions, workspace?.oid), [sessions, workspace?.oid]);
    const order = useMemo(() => flattenGroups(groups), [groups]);
    const orderKey = order.join("\n");
    const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
    const outdatedBlocks = useMemo(() => new Set(outdated.terminals.map((term) => term.blockid)), [outdated]);
    const updatable = order.map((id) => byId.get(id)).filter((s) => s != null && canUpdate(s, outdatedBlocks));
    const mergedPrs = useMergedPrs(allSessions, panelId);

    // A row that went away hands the focus to the one that took its place, if the list had it; it leaves the checks.
    useEffect(() => {
        const prev = prevOrder.current;
        prevOrder.current = order;
        setChecked((cur) => pruneSelected(cur, order));
        if (focused == null || order.includes(focused)) {
            return;
        }
        const next = nextSelection(prev, order, focused);
        setFocused(next);
        if (focusIsOurs()) {
            focusWanted.current = true;
        }
    }, [orderKey]);

    // A session that ended elsewhere while its dialog was open closes the dialog. A bulk run keeps its own list.
    useEffect(() => {
        const gone =
            ((dialog?.kind === "end" || dialog?.kind === "update") && !byId.has(dialog.id)) ||
            ((dialog?.kind === "cleanup" || dialog?.kind === "updateAll") && !dialog.ids.some((id) => byId.has(id)));
        if (!gone) {
            return;
        }
        if (focusIsOurs()) {
            focusWanted.current = true;
        }
        setDialog(null);
    }, [byId, dialog]);

    // A wanted focus waits for its row: a row ended from its dialog is still listed until wavesrv's next list. It is
    // dropped once the user is elsewhere, so a late list never pulls the focus out of a terminal.
    useEffect(() => {
        if (!focusWanted.current) {
            return;
        }
        if (!focusIsOurs()) {
            focusWanted.current = false;
            return;
        }
        const row = focused == null ? null : rowRefs.current.get(focused);
        if (row == null) {
            return;
        }
        focusWanted.current = false;
        row.focus();
    });

    // The focus is in the list, in one of its dialogs, on this pane's frame (Wave parks it there when a focused element
    // goes away), or nowhere.
    const focusIsOurs = () => {
        const active = document.activeElement;
        return (
            active == null ||
            active === document.body ||
            listRef.current?.contains(active) ||
            active.closest('[data-role^="molten-session"]') != null ||
            active.closest("[data-blockid]")?.getAttribute("data-blockid") === blockId
        );
    };

    const focusRow = (id: string) => {
        setFocused(id);
        focusWanted.current = true;
    };

    const check = (id: string, shift: boolean) => {
        setChecked((cur) =>
            shift && anchor != null ? rangeSelected(cur, order, anchor, id) : toggleSelected(cur, id)
        );
        if (!shift || anchor == null) {
            setAnchor(id);
        }
    };

    const setRowBusy = (id: string, label: string) => {
        setBusy((prev) => {
            const next = { ...prev };
            if (label) {
                next[id] = label;
            } else {
                delete next[id];
            }
            return next;
        });
    };

    const run = async (id: string, label: string, fn: () => Promise<void>) => {
        if (busy[id]) {
            return;
        }
        setRowBusy(id, label);
        setNotice(null);
        try {
            await fn();
        } catch (e) {
            setNotice({ text: serverErrorText(e), error: true });
        } finally {
            setRowBusy(id, null);
        }
    };

    const show = (s: DurableSession) => {
        if (!s.canshow) {
            return;
        }
        void run(s.id, s.shown ? t("sessions.view.showing") : t("sessions.view.opening"), async () => {
            const loc = await store.show(s.id);
            if (loc != null && !loc.created) {
                showPane(loc);
            }
        });
    };

    const reconnect = (s: DurableSession) => {
        if (!canReconnect(s)) {
            return;
        }
        void run(s.id, t("sessions.view.reconnecting"), () => store.reconnect(s.id));
    };

    const askEnd = (s: DurableSession) => {
        if (!s.canend) {
            return;
        }
        setFocused(s.id);
        setDialog({ kind: "end", id: s.id });
    };

    // Interrupt (#933): the agent's interrupt key, as the AI panel's Interrupt (FR-REV-005).
    const interrupt = (s: DurableSession) => {
        if (!canInterrupt(s)) {
            return;
        }
        void run(s.id, t("sessions.view.interrupting"), async () => {
            const out = await AgentInputs.getInstance().send({
                blockid: s.blockid,
                agent: s.agent,
                action: InterruptAction,
            });
            const result = sendResult(s.id, out);
            setNotice({
                text:
                    result.kind === "done"
                        ? t("sessions.view.interrupted", { name: rowName(s, home) })
                        : result.message,
                error: result.kind === "failed",
            });
        });
    };

    const askUpdate = (s: DurableSession) => {
        if (!canUpdate(s, outdatedBlocks)) {
            return;
        }
        setFocused(s.id);
        setDialog({ kind: "update", id: s.id });
    };

    // Update terminal (FR-SHELL-041) confirmed: the shell starts again on the current version; an idle agent exits and
    // resumes its conversation, with the guarantees of Restart with current settings (#389).
    const updateOne = async (s: DurableSession) => {
        const outcome = await termUpdates.run(s.blockid, true);
        return { blockid: s.blockid, outcome };
    };

    const askUpdateAll = () => {
        const ids = updatable.map((s) => s.id);
        if (ids.length > 0) {
            setDialog({ kind: "updateAll", ids });
        }
    };

    const reportUpdates = (results: { blockid: string; outcome: TermUpdateOutcome }[]) => {
        const summary = updateAllSummary(results);
        showToast({ kind: summary.kind, title: summary.title, message: summary.message || undefined });
    };

    const hiddenGroup = groups.find((g) => g.id === HiddenGroupId);
    const askCleanup = () => {
        const ids = (hiddenGroup?.sessions ?? []).filter((s) => s.canend).map((s) => s.id);
        if (ids.length > 0) {
            setDialog({ kind: "cleanup", ids });
        }
    };

    const checkedIds = order.filter((id) => checked.has(id));
    const checkedSessions = checkedIds.map((id) => byId.get(id)).filter((s) => s != null);

    const askBulk = (action: BulkAction) => {
        if (checkedIds.length > 0) {
            setDialog({ kind: "bulk", action, ids: checkedIds, snapshot: checkedSessions });
        }
    };

    const runners: BulkRunners = {
        end: (s) => store.end(s.id),
        restart: (req) => store.restartAgent(req),
        send: (req) => AgentInputs.getInstance().send(req),
    };

    const runBulkDialog =
        (action: BulkAction) => (items: BulkItem[], opts: BulkOptions, onResult: (r: BulkResult) => void) =>
            runBulk(action, items, runners, opts, onResult);

    const closeDialog = () => {
        setDialog(null);
        if (focusIsOurs()) {
            focusWanted.current = true;
        }
        if (focused == null) {
            setFocused(order[0] ?? null);
        }
    };

    // The results dialog showed every result: closing it adds no toast (#439).
    const closeBulk = () => {
        closeDialog();
    };

    const reportUnseenBulk = (action: BulkAction, results: BulkResult[]) => {
        const summary = unseenBulkSummary(action, results, false);
        if (summary == null) {
            return;
        }
        showToast({ kind: ToastKinds[summary.tone], title: summary.title, message: summary.detail || undefined });
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        const target = e.target as HTMLElement;
        const onRow = target?.dataset?.sessionRow != null;
        if (NavKeys.has(e.key)) {
            const next = moveSelection(order, focused, e.key);
            if (next != null) {
                e.preventDefault();
                focusRow(next);
                if (e.shiftKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                    setChecked((cur) =>
                        rangeSelected(new Set([...cur, anchor ?? focused]), order, anchor ?? focused, next)
                    );
                    if (anchor == null) {
                        setAnchor(focused);
                    }
                }
            }
            return;
        }
        if (e.key === "Escape" && checked.size > 0 && dialog == null) {
            e.preventDefault();
            e.stopPropagation();
            setChecked(new Set());
            return;
        }
        if ((e.key === "a" || e.key === "A") && (e.metaKey || e.ctrlKey) && !e.altKey) {
            e.preventDefault();
            setChecked(new Set(order));
            return;
        }
        if (!onRow) {
            return;
        }
        const s = byId.get(target.dataset.sessionRow);
        if (s == null) {
            return;
        }
        if (e.key === " ") {
            e.preventDefault();
            check(s.id, e.shiftKey);
        } else if (e.key === "Enter") {
            e.preventDefault();
            show(s);
        } else if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault();
            askEnd(s);
        } else if ((e.key === "r" || e.key === "R") && !e.metaKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault();
            reconnect(s);
        }
    };

    const endSession = dialog?.kind === "end" ? byId.get(dialog.id) : null;
    const updateSession = dialog?.kind === "update" ? byId.get(dialog.id) : null;
    const updateAllSessions =
        dialog?.kind === "updateAll" ? dialog.ids.map((id) => byId.get(id)).filter((s) => s != null) : [];
    const cleanupSessions =
        dialog?.kind === "cleanup" ? dialog.ids.map((id) => byId.get(id)).filter((s) => s != null) : [];
    // A session that ends while its bulk dialog is open keeps its row there (its last known state): the run reports it.
    const bulkSessions = dialog?.kind === "bulk" ? dialog.snapshot.map((s) => byId.get(s.id) ?? s) : [];
    const firstFocusable = focused != null && order.includes(focused) ? focused : (order[0] ?? null);
    const allChecks = checkState(checked, order);

    return (
        <div className="@container flex h-full w-full flex-col overflow-hidden" data-role="molten-sessions">
            <div className="mx-auto flex min-h-0 w-full max-w-[960px] flex-1 flex-col" data-testid="sessions-frame">
                {/* With nothing listed the empty state says it: the summary row only stays for a notice. */}
                <div
                    className={cn(
                        "flex items-center gap-3 px-3 py-2",
                        data != null && allSessions.length === 0 && notice == null && "hidden"
                    )}
                >
                    <span className="shrink-0 text-12 whitespace-nowrap text-secondary" aria-live="polite">
                        {data == null ? t("sessions.view.loading") : sessionsSummary(data)}
                    </span>
                    {filtered && sessions.length > 0 ? (
                        <span className="shrink-0 text-12 whitespace-nowrap text-muted" data-testid="sessions-filtered">
                            {t("sessions.view.shownCount", { count: sessions.length })}
                        </span>
                    ) : null}
                    {updatable.length > 0 ? (
                        <button
                            type="button"
                            className={BarButton}
                            onClick={askUpdateAll}
                            data-testid="sessions-update-all"
                        >
                            <i className={cn(makeIconClass("arrows-rotate", true), "mr-1.5 text-11")} />
                            {t("sessions.view.updateAll", { count: updatable.length })}
                        </button>
                    ) : null}
                    {notice ? (
                        <span
                            className={cn(
                                "ml-auto min-w-0 truncate text-12",
                                notice.error ? "text-danger" : "text-muted"
                            )}
                            role="status"
                            title={notice.text}
                        >
                            {notice.text}
                        </span>
                    ) : null}
                </div>
                {checkedSessions.length > 0 ? (
                    <div className="px-2 pb-2">
                        <SelectionBar
                            count={checkedSessions.length}
                            sessions={checkedSessions}
                            onAction={askBulk}
                            onClear={() => setChecked(new Set())}
                        />
                    </div>
                ) : null}
                {data != null && allSessions.length === 0 ? (
                    <SessionsEmpty blockId={blockId} />
                ) : data != null && sessions.length === 0 ? (
                    <SessionsFilteredOut blockId={blockId} />
                ) : (
                    <div
                        ref={listRef}
                        role="table"
                        aria-label={t("sessions.view.tableLabel")}
                        aria-multiselectable="true"
                        data-testid="sessions-table"
                        className={cn(
                            TableColumns,
                            "min-h-0 flex-1 content-start overflow-x-hidden overflow-y-auto px-2 pb-3",
                            checked.size > 0 && "molten-sessions-selecting"
                        )}
                        onKeyDown={onKeyDown}
                    >
                        <TableHeader checks={allChecks} onCheckAll={() => setChecked((cur) => toggleAll(cur, order))} />
                        {groups.map((group) => {
                            const ids = group.sessions.map((s) => s.id);
                            return (
                                <div
                                    key={group.id}
                                    role="rowgroup"
                                    aria-label={group.title}
                                    className={cn(
                                        RowGrid,
                                        "mb-2 rounded-6 border bg-surface-1 pb-1",
                                        group.current ? "border-accent/40" : "border-border"
                                    )}
                                >
                                    <GroupHeader
                                        group={group}
                                        checks={checkState(checked, ids)}
                                        onCheckAll={() => setChecked((cur) => toggleAll(cur, ids))}
                                        onCleanup={askCleanup}
                                    />
                                    {group.sessions.map((s) => (
                                        <SessionRow
                                            key={s.id}
                                            session={s}
                                            depth={group.depths?.[s.id] ?? 0}
                                            parentName={
                                                s.parentid && byId.has(s.parentid)
                                                    ? rowName(byId.get(s.parentid), home)
                                                    : ""
                                            }
                                            version={versionMark(s, outdatedBlocks)}
                                            onInterrupt={() => interrupt(s)}
                                            onUpdate={canUpdate(s, outdatedBlocks) ? () => askUpdate(s) : null}
                                            onCopied={() => setNotice({ text: t("sessions.view.copied") })}
                                            focused={s.id === firstFocusable}
                                            checked={checked.has(s.id)}
                                            busy={busy[s.id]}
                                            home={home}
                                            now={now}
                                            mergedPr={sessionMergedPr(s, mergedPrs)}
                                            rowRef={(elem) => {
                                                if (elem) {
                                                    rowRefs.current.set(s.id, elem);
                                                } else {
                                                    rowRefs.current.delete(s.id);
                                                }
                                            }}
                                            onFocusRow={() => setFocused(s.id)}
                                            onCheck={(shift) => check(s.id, shift)}
                                            onShow={() => show(s)}
                                            onEnd={() => askEnd(s)}
                                            onReconnect={() => reconnect(s)}
                                        />
                                    ))}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
            {endSession != null ? (
                <EndSessionDialog
                    session={endSession}
                    home={home}
                    now={now}
                    onKeep={closeDialog}
                    onEnd={async () => {
                        const res = await store.end(endSession.id);
                        if (res?.pending) {
                            setNotice({
                                text: t("sessions.view.endsLater", {
                                    what: sessionWhat(endSession),
                                    connection: endSession.connection,
                                }),
                            });
                        }
                        closeDialog();
                    }}
                />
            ) : null}
            {updateSession != null ? (
                <UpdateSessionDialog
                    session={updateSession}
                    home={home}
                    onKeep={closeDialog}
                    onUpdate={async () => {
                        reportUpdates([await updateOne(updateSession)]);
                        closeDialog();
                    }}
                />
            ) : null}
            {dialog?.kind === "updateAll" && updateAllSessions.length > 0 ? (
                <UpdateAllDialog
                    sessions={updateAllSessions}
                    home={home}
                    onKeep={closeDialog}
                    onUpdate={async () => {
                        const results: { blockid: string; outcome: TermUpdateOutcome }[] = [];
                        for (const s of updateAllSessions) {
                            try {
                                results.push(await updateOne(s));
                            } catch (e) {
                                results.push({
                                    blockid: s.blockid,
                                    outcome: { status: "failed", message: serverErrorText(e) },
                                });
                            }
                        }
                        reportUpdates(results);
                        closeDialog();
                    }}
                />
            ) : null}
            {dialog?.kind === "cleanup" && cleanupSessions.length > 0 ? (
                <CleanupDialog
                    sessions={cleanupSessions}
                    home={home}
                    onKeep={closeDialog}
                    onEnd={async () => {
                        const res = await store.cleanup(cleanupSessions.map((s) => s.id));
                        setNotice({ text: cleanupResultText(res) });
                        closeDialog();
                    }}
                />
            ) : null}
            {dialog?.kind === "bulk" && bulkSessions.length > 0 ? (
                <BulkDialog
                    key={`${dialog.action}:${dialog.ids.join(",")}`}
                    action={dialog.action}
                    sessions={bulkSessions}
                    home={home}
                    onClose={closeBulk}
                    onUnseen={(results) => reportUnseenBulk(dialog.action, results)}
                    run={runBulkDialog(dialog.action)}
                />
            ) : null}
        </div>
    );
}
