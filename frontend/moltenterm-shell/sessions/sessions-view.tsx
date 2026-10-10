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
import { AgentStateDot } from "../agent-state-ui";
import { AgentInputs } from "../command-panel/agent-input-store";
import { EmptyState } from "../empty-state";
import { sessionRowDragProps } from "../split/drop-zones";
import { showToast } from "../toast-store";
import {
    filterSessions,
    SessionsAgentMetaKey,
    sessionsFiltered,
    SessionsFolderMetaKey,
    SessionsStateMetaKey,
} from "../widget-options";
import { effectiveWorkspaceFolder } from "../workspace-project";
import { worktreeColor, WorktreeIcon } from "../worktree-model";
import { showPane } from "./pane-focus";
import {
    BulkAction,
    BulkItem,
    bulkItems,
    BulkOptions,
    BulkResult,
    BulkRunners,
    bulkSummary,
    checkState,
    CheckState,
    pruneSelected,
    rangeSelected,
    runBulk,
    toggleAll,
    toggleSelected,
} from "./sessions-bulk";
import { BulkDialog, CleanupDialog, EndSessionDialog } from "./sessions-dialogs";
import {
    agentCell,
    canReconnect,
    cleanupResultText,
    connChip,
    displayFolder,
    DurableSession,
    flattenGroups,
    formatAge,
    groupSessions,
    HiddenGroupId,
    lastActive,
    middleTruncate,
    MoltentermSessionsView,
    moveSelection,
    nextSelection,
    outputText,
    reasonLabel,
    reasonTitle,
    rowAriaLabel,
    SessionGroup,
    sessionName,
    sessionsSummary,
    sessionWhat,
    showLabel,
} from "./sessions-model";
import { DurableSessions } from "./sessions-store";

export { MoltentermSessionsView };

const AgeRefreshMs = 15000;
const FolderMaxChars = 56;
const NavKeys = new Set(["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"]);

// DS-SHELL-100: select, name, actions, folder, agent, last active. Rows are subgrids of the table, so the actions
// column is as wide as the widest row's actions and every column lines up.
const TableColumns = "grid grid-cols-[28px_minmax(96px,1fr)_auto_minmax(0,1.5fr)_minmax(88px,auto)_minmax(56px,auto)]";
const RowGrid = "col-span-full grid grid-cols-subgrid items-center";

const RowButton =
    "molten-btn-ghost molten-tone-accent cursor-pointer rounded-6 px-2 py-0.5 text-11 whitespace-nowrap disabled:opacity-50";
const RowDangerButton =
    "molten-btn-ghost cursor-pointer rounded-6 px-2 py-0.5 text-11 whitespace-nowrap text-error disabled:opacity-50";
const BarButton =
    "molten-btn-ghost cursor-pointer rounded-6 px-2 py-1 text-12 whitespace-nowrap text-secondary hover:bg-surface-2 hover:text-primary disabled:opacity-50";
const CheckboxClass = "h-3.5 w-3.5 cursor-pointer accent-[var(--accent-color)]";

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
    viewName = atom("Sessions");
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

function WorktreeMark({ session }: { session: DurableSession }) {
    const wt = session.worktree;
    if (wt == null) {
        return null;
    }
    return (
        <span
            className={cn(
                "inline-flex max-w-[9rem] min-w-0 shrink items-center gap-1 rounded-4 border px-1.5 text-11 leading-[16px]",
                worktreeColor(wt.path)
            )}
            title={`Worktree ${wt.path}${wt.branch ? ` on ${wt.branch}` : ""}`}
        >
            <i className={cn("fa fa-solid shrink-0 text-11", `fa-${WorktreeIcon}`)} />
            <span className="truncate">{wt.branch || wt.path.split("/").pop()}</span>
        </span>
    );
}

function AgentCellView({ session }: { session: DurableSession }) {
    const cell = agentCell(session);
    if (cell.kind === "agent") {
        return (
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

function SessionRow({
    session,
    focused,
    checked,
    busy,
    home,
    now,
    rowRef,
    onFocusRow,
    onCheck,
    onShow,
    onEnd,
    onReconnect,
}: {
    session: DurableSession;
    focused: boolean;
    checked: boolean;
    busy: string;
    home: string;
    now: number;
    rowRef: (elem: HTMLDivElement) => void;
    onFocusRow: () => void;
    onCheck: (shift: boolean) => void;
    onShow: () => void;
    onEnd: () => void;
    onReconnect: () => void;
}) {
    const name = sessionName(session, home);
    const folder = displayFolder(session, home);
    const active = lastActive(session, now);
    const up = formatAge(session.startedat, now);
    const output = outputText(session, now);
    const tabIndex = focused ? 0 : -1;
    const showTitle = session.canshow ? undefined : reasonTitle(session.reason);
    const activeTitle = [up ? `Up ${up}` : "", output].filter((p) => !!p).join(" · ");
    return (
        <div
            ref={rowRef}
            role="row"
            tabIndex={tabIndex}
            aria-selected={checked}
            data-session-row={session.id}
            aria-label={rowAriaLabel(session, home, now)}
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
                "group h-8 cursor-pointer rounded-6 transition-colors duration-120 ease-mt outline-none hover:bg-hover focus-visible:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
                checked && "bg-accent/10",
                focused && !checked && "bg-hover/60"
            )}
        >
            <div role="cell" className="flex items-center justify-center">
                <Check
                    state={checked ? "all" : "none"}
                    label={`Select ${name}, ${sessionWhat(session)}`}
                    onToggle={onCheck}
                    tabIndex={tabIndex}
                />
            </div>
            <div role="cell" className="flex min-w-0 items-center gap-1.5 pr-1">
                <span
                    className="min-w-0 shrink truncate text-12 font-medium text-primary"
                    title={session.tabname || name}
                >
                    {name}
                </span>
                {session.reason ? (
                    <span
                        className={cn(
                            "shrink-0 rounded-4 px-1 text-11 whitespace-nowrap",
                            session.reason === "ending" ? "bg-error/15 text-error" : "bg-warning/15 text-warning"
                        )}
                        title={reasonTitle(session.reason)}
                    >
                        {reasonLabel(session.reason)}
                    </span>
                ) : null}
                <WorktreeMark session={session} />
                <ConnectionChip session={session} />
            </div>
            <div
                role="cell"
                className={cn(
                    "flex items-center gap-0.5 pr-2 opacity-0 transition-opacity duration-120 ease-mt group-focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none",
                    busy && "opacity-100"
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
                        Reconnect
                    </button>
                ) : null}
                <button
                    type="button"
                    tabIndex={tabIndex}
                    className={RowButton}
                    disabled={!!busy || !session.canshow}
                    title={showTitle}
                    onClick={(e) => {
                        e.stopPropagation();
                        onShow();
                    }}
                >
                    {showLabel(session)}
                </button>
                <button
                    type="button"
                    tabIndex={tabIndex}
                    className={RowDangerButton}
                    disabled={!!busy || !session.canend}
                    title={session.canend ? undefined : reasonTitle(session.reason)}
                    onClick={(e) => {
                        e.stopPropagation();
                        onEnd();
                    }}
                >
                    End…
                </button>
            </div>
            <div role="cell" className="min-w-0 truncate pr-3 font-mono text-11 text-secondary" title={session.folder}>
                {folder ? middleTruncate(folder, FolderMaxChars) : <span className="text-muted">—</span>}
            </div>
            <div role="cell" className="min-w-0 pr-3">
                <AgentCellView session={session} />
            </div>
            <div role="cell" className="pr-2 text-right text-11 whitespace-nowrap text-muted" title={activeTitle}>
                {active}
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
    const hidden = group.id === HiddenGroupId;
    const endable = group.sessions.filter((s) => s.canend).length;
    return (
        <div role="row" className={cn(RowGrid, "pt-3 pb-1")}>
            <div role="cell" className="flex items-center justify-center">
                <Check state={checks} label={`Select every session of ${group.title}`} onToggle={onCheckAll} />
            </div>
            <div role="cell" className="col-span-5 flex min-w-0 items-center gap-2">
                {hidden ? (
                    <i className={cn(makeIconClass("link-slash", true), "text-11 text-warning")} />
                ) : (
                    <span
                        className="inline-block h-2.5 w-2.5 shrink-0 rounded-4"
                        style={{ background: group.color || "var(--border-color)" }}
                        aria-hidden="true"
                    />
                )}
                <span className="truncate text-11 font-semibold tracking-wide text-secondary uppercase">
                    {group.title}
                </span>
                {group.current ? <span className="shrink-0 text-11 text-muted">this workspace</span> : null}
                <span className="shrink-0 text-11 text-muted">{group.sessions.length}</span>
                {hidden && endable > 0 ? (
                    <button type="button" className={cn(RowDangerButton, "ml-auto")} onClick={onCleanup}>
                        End all ({endable})…
                    </button>
                ) : null}
            </div>
        </div>
    );
}

function TableHeader({ checks, onCheckAll }: { checks: CheckState; onCheckAll: () => void }) {
    const head = "text-11 font-medium text-muted";
    return (
        <div role="row" className={cn(RowGrid, "sticky top-0 z-[1] h-7 border-b border-border bg-surface-1")}>
            <div role="columnheader" className="flex items-center justify-center">
                <Check state={checks} label="Select every session" onToggle={onCheckAll} />
            </div>
            <div role="columnheader" className={head}>
                Name
            </div>
            <div role="columnheader" className="sr-only">
                Actions
            </div>
            <div role="columnheader" className={head}>
                Folder
            </div>
            <div role="columnheader" className={head}>
                Agent
            </div>
            <div role="columnheader" className={cn(head, "pr-2 text-right")}>
                Last active
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
    const reach = (action: BulkAction) => bulkItems(action, sessions).filter((i) => !i.skip).length;
    const agents = reach("restart");
    const endable = reach("end");
    return (
        <div
            role="toolbar"
            aria-label="Selected sessions"
            data-testid="sessions-selection-bar"
            className="flex min-h-9 flex-wrap items-center gap-1 rounded-6 border border-border bg-surface-2 px-2 py-1"
        >
            <span className="px-1 text-12 font-medium whitespace-nowrap text-primary" aria-live="polite">
                {count} selected
            </span>
            <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
            <button
                type="button"
                className={BarButton}
                disabled={agents === 0}
                title={agents === 0 ? "No selected session runs a local coding agent in a pane." : undefined}
                onClick={() => onAction("send")}
            >
                <i className={cn(makeIconClass("terminal", true), "mr-1.5 text-11")} />
                Send a command…
            </button>
            <button
                type="button"
                className={BarButton}
                disabled={agents === 0}
                title={agents === 0 ? "No selected session runs a local coding agent in a pane." : undefined}
                onClick={() => onAction("restart")}
            >
                <i className={cn(makeIconClass("rotate-right", true), "mr-1.5 text-11")} />
                Restart with current settings…
            </button>
            <button
                type="button"
                className={cn(BarButton, "text-error hover:text-error")}
                disabled={endable === 0}
                onClick={() => onAction("end")}
            >
                <i className={cn(makeIconClass("power-off", true), "mr-1.5 text-11")} />
                End…
            </button>
            <button type="button" className={cn(BarButton, "ml-auto")} onClick={onClear}>
                Clear
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
    return (
        <EmptyState
            icon="layer-group"
            title="No sessions running"
            hint="Terminals keep running when MoltenTerm quits, and they show up here."
            primary={{
                label: "Start a terminal",
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
            title="No session matches the filters"
            hint="The filters of this panel hide every running session."
            primary={{ label: "Clear the filters", onClick: clear, testId: "sessions-clear-filters" }}
            className="flex-1"
            testId="sessions-filtered-out"
        />
    );
}

const ToastKinds = { done: "success", skipped: "warning", failed: "error" } as const;

function SessionsView({ blockId }: ViewComponentProps<SessionsViewModel>) {
    const store = DurableSessions.getInstance();
    const data = useAtomValue(store.dataAtom);
    const workspace = useAtomValue(atoms.workspace);
    const agentFilter = useAtomValue(getBlockMetaKeyAtom(blockId, SessionsAgentMetaKey as keyof MetaType));
    const folderFilter = useAtomValue(getBlockMetaKeyAtom(blockId, SessionsFolderMetaKey as keyof MetaType));
    const stateFilter = useAtomValue(getBlockMetaKeyAtom(blockId, SessionsStateMetaKey as keyof MetaType));
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

    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), AgeRefreshMs);
        return () => clearInterval(timer);
    }, []);

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
            (dialog?.kind === "end" && !byId.has(dialog.id)) ||
            (dialog?.kind === "cleanup" && !dialog.ids.some((id) => byId.has(id)));
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
            setNotice({ text: e?.message ?? String(e), error: true });
        } finally {
            setRowBusy(id, null);
        }
    };

    const show = (s: DurableSession) => {
        if (!s.canshow) {
            return;
        }
        void run(s.id, s.shown ? "showing…" : "opening…", async () => {
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
        void run(s.id, "reconnecting…", () => store.reconnect(s.id));
    };

    const askEnd = (s: DurableSession) => {
        if (!s.canend) {
            return;
        }
        setFocused(s.id);
        setDialog({ kind: "end", id: s.id });
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

    const closeBulk = (action: BulkAction, results: BulkResult[]) => {
        closeDialog();
        if (results.length === 0) {
            return;
        }
        const summary = bulkSummary(action, results);
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
    const cleanupSessions =
        dialog?.kind === "cleanup" ? dialog.ids.map((id) => byId.get(id)).filter((s) => s != null) : [];
    // A session that ends while its bulk dialog is open keeps its row there (its last known state): the run reports it.
    const bulkSessions = dialog?.kind === "bulk" ? dialog.snapshot.map((s) => byId.get(s.id) ?? s) : [];
    const firstFocusable = focused != null && order.includes(focused) ? focused : (order[0] ?? null);
    const allChecks = checkState(checked, order);

    return (
        <div className="flex h-full w-full flex-col overflow-hidden" data-role="molten-sessions">
            <div className="mx-auto flex min-h-0 w-full max-w-[960px] flex-1 flex-col" data-testid="sessions-frame">
                {/* With nothing listed the empty state says it: the summary row only stays for a notice. */}
                <div
                    className={cn(
                        "flex items-center gap-3 px-3 py-2",
                        data != null && allSessions.length === 0 && notice == null && "hidden"
                    )}
                >
                    <span className="shrink-0 text-12 whitespace-nowrap text-secondary" aria-live="polite">
                        {data == null ? "Loading sessions…" : sessionsSummary(data)}
                    </span>
                    {filtered && sessions.length > 0 ? (
                        <span className="shrink-0 text-12 whitespace-nowrap text-muted" data-testid="sessions-filtered">
                            {sessions.length} shown
                        </span>
                    ) : null}
                    {notice ? (
                        <span
                            className={cn(
                                "ml-auto min-w-0 truncate text-12",
                                notice.error ? "text-error" : "text-muted"
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
                        aria-label="Durable sessions"
                        aria-multiselectable="true"
                        data-testid="sessions-table"
                        className={cn(
                            TableColumns,
                            "min-h-0 flex-1 content-start overflow-x-hidden overflow-y-auto px-1 pb-3"
                        )}
                        onKeyDown={onKeyDown}
                    >
                        <TableHeader checks={allChecks} onCheckAll={() => setChecked((cur) => toggleAll(cur, order))} />
                        {groups.map((group) => {
                            const ids = group.sessions.map((s) => s.id);
                            return (
                                <div key={group.id} role="rowgroup" aria-label={group.title} className={RowGrid}>
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
                                            focused={s.id === firstFocusable}
                                            checked={checked.has(s.id)}
                                            busy={busy[s.id]}
                                            home={home}
                                            now={now}
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
                                text: `${sessionWhat(endSession)} ends once ${endSession.connection} is back.`,
                            });
                        }
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
                    onClose={(results) => closeBulk(dialog.action, results)}
                    run={runBulkDialog(dialog.action)}
                />
            ) : null}
        </div>
    );
}
