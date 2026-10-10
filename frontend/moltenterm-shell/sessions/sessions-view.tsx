// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Sessions view (FR-SHELL-020): every durable terminal still running, local and SSH, grouped by workspace, the
// ones no pane shows first. A pane like CI/CD: it can stay open while you work. Rows show what runs (the agent
// and its state, or the command), where (connection, folder, worktree), since when, and offer Show, Reconnect and
// End. The keyboard walks the rows (arrows, Home, End, Page keys), Enter shows, Delete ends, R reconnects.

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { atoms, createBlockSplitHorizontally, getApi, getBlockMetaKeyAtom } from "@/app/store/global";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget, makeIconClass } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { AgentStateDot } from "../agent-state-ui";
import { EmptyState } from "../empty-state";
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
import { CleanupDialog, EndSessionDialog } from "./sessions-dialogs";
import {
    canReconnect,
    cleanupResultText,
    connChip,
    displayFolder,
    DurableSession,
    flattenGroups,
    formatAge,
    groupSessions,
    HiddenGroupId,
    middleTruncate,
    MoltentermSessionsView,
    moveSelection,
    nextSelection,
    outputText,
    reasonLabel,
    reasonTitle,
    rowAriaLabel,
    SessionGroup,
    sessionsSummary,
    sessionWhat,
    showLabel,
} from "./sessions-model";
import { DurableSessions } from "./sessions-store";

export { MoltentermSessionsView };

const AgeRefreshMs = 15000;
const FolderMaxChars = 48;
const NavKeys = new Set(["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"]);

const RowButton =
    "molten-btn-ghost molten-tone-accent cursor-pointer rounded-6 px-2 py-0.5 text-11 whitespace-nowrap disabled:opacity-50";
const RowDangerButton =
    "molten-btn-ghost cursor-pointer rounded-6 px-2 py-0.5 text-11 whitespace-nowrap text-error disabled:opacity-50";

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

type Dialog = { kind: "end"; id: string } | { kind: "cleanup"; ids: string[] };
type Notice = { text: string; error?: boolean };

function ConnectionChip({ session }: { session: DurableSession }) {
    const chip = connChip(session);
    const showDot = !!session.connection || chip.state !== "connected";
    return (
        <span
            className="inline-flex max-w-[12rem] shrink-0 items-center gap-1 rounded-4 border border-border px-1.5 text-11 leading-[16px] text-secondary"
            title={chip.title}
        >
            {showDot ? (
                <span className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full", ConnDotClasses[chip.state])} />
            ) : null}
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
                "inline-flex max-w-[12rem] shrink-0 items-center gap-1 rounded-4 border px-1.5 text-11 leading-[16px]",
                worktreeColor(wt.path)
            )}
            title={`Worktree ${wt.path}${wt.branch ? ` on ${wt.branch}` : ""}`}
        >
            <i className={cn("fa fa-solid shrink-0 text-11", `fa-${WorktreeIcon}`)} />
            <span className="truncate">{wt.branch || wt.path.split("/").pop()}</span>
        </span>
    );
}

function SessionStateMark({ session }: { session: DurableSession }) {
    if (!session.agent) {
        return <i className={cn(makeIconClass("terminal", true), "w-2 shrink-0 text-11 text-muted")} />;
    }
    return (
        <AgentStateDot
            info={{
                blockid: session.blockid ?? session.id,
                agent: session.agent,
                agentname: session.agentname,
                state: (session.agentstate || "idle") as any,
                version: 0,
            }}
        />
    );
}

function SessionRow({
    session,
    selected,
    busy,
    home,
    now,
    rowRef,
    onSelect,
    onShow,
    onEnd,
    onReconnect,
}: {
    session: DurableSession;
    selected: boolean;
    busy: string;
    home: string;
    now: number;
    rowRef: (elem: HTMLDivElement) => void;
    onSelect: () => void;
    onShow: () => void;
    onEnd: () => void;
    onReconnect: () => void;
}) {
    const folder = displayFolder(session, home);
    const up = formatAge(session.startedat, now);
    const output = outputText(session, now);
    const tabIndex = selected ? 0 : -1;
    const command = session.agent && session.command !== session.agentname ? session.command : null;
    const showTitle = session.canshow ? undefined : reasonTitle(session.reason);
    return (
        <div
            ref={rowRef}
            role="listitem"
            tabIndex={tabIndex}
            data-session-row={session.id}
            aria-label={rowAriaLabel(session, home, now)}
            onFocus={(e) => {
                if (e.target === e.currentTarget) {
                    onSelect();
                }
            }}
            onClick={onSelect}
            onDoubleClick={() => session.canshow && onShow()}
            className={cn(
                "group relative flex cursor-pointer items-stretch rounded-6 transition-colors duration-120 ease-mt outline-none hover:bg-hover focus-visible:bg-hover",
                selected && "bg-hover/60"
            )}
        >
            <span
                className="w-[3px] shrink-0 rounded-l-4"
                style={{ background: session.workspacecolor || "var(--border-color)" }}
                aria-hidden="true"
            />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5 px-2.5 py-1.5">
                <div className="flex min-w-0 items-center gap-2">
                    <SessionStateMark session={session} />
                    <span className="max-w-[65%] min-w-0 shrink-0 truncate text-13 font-medium text-primary">
                        {sessionWhat(session)}
                    </span>
                    {command ? <span className="min-w-0 truncate font-mono text-11 text-muted">{command}</span> : null}
                    <ConnectionChip session={session} />
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-11 text-muted">
                    {folder ? (
                        <span className="min-w-0 truncate" title={session.folder}>
                            {middleTruncate(folder, FolderMaxChars)}
                        </span>
                    ) : null}
                    <WorktreeMark session={session} />
                    {up ? <span className="whitespace-nowrap">up {up}</span> : null}
                    {output ? <span className="whitespace-nowrap">{output}</span> : null}
                    {session.reason ? (
                        <span
                            className={cn(
                                "rounded-4 px-1 whitespace-nowrap",
                                session.reason === "ending" ? "bg-error/15 text-error" : "bg-warning/15 text-warning"
                            )}
                            title={reasonTitle(session.reason)}
                        >
                            {reasonLabel(session.reason)}
                        </span>
                    ) : null}
                    <span className="font-mono whitespace-nowrap opacity-70" title="Session id (molten session)">
                        {session.shortid}
                    </span>
                </div>
            </div>
            <div
                className={cn(
                    "flex shrink-0 items-center gap-1 pr-2 opacity-0 transition-opacity duration-120 ease-mt group-focus-within:opacity-100 group-hover:opacity-100",
                    busy && "opacity-100"
                )}
            >
                {busy ? <span className="text-11 text-muted">{busy}</span> : null}
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
        </div>
    );
}

function GroupHeader({ group, onCleanup }: { group: SessionGroup; onCleanup: () => void }) {
    const hidden = group.id === HiddenGroupId;
    const endable = group.sessions.filter((s) => s.canend).length;
    return (
        <div className="flex items-center gap-2 px-3 pt-3 pb-1">
            {hidden ? (
                <i className={cn(makeIconClass("link-slash", true), "text-11 text-warning")} />
            ) : (
                <span
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-4"
                    style={{ background: group.color || "var(--border-color)" }}
                    aria-hidden="true"
                />
            )}
            <span className="text-11 font-semibold tracking-wide text-secondary uppercase">{group.title}</span>
            {group.current ? <span className="text-11 text-muted">this workspace</span> : null}
            <span className="text-11 text-muted">{group.sessions.length}</span>
            {hidden && endable > 0 ? (
                <button type="button" className={cn(RowDangerButton, "ml-auto")} onClick={onCleanup}>
                    End all ({endable})…
                </button>
            ) : null}
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

function SessionsView({ blockId }: ViewComponentProps<SessionsViewModel>) {
    const store = DurableSessions.getInstance();
    const data = useAtomValue(store.dataAtom);
    const workspace = useAtomValue(atoms.workspace);
    const agentFilter = useAtomValue(getBlockMetaKeyAtom(blockId, SessionsAgentMetaKey as keyof MetaType));
    const folderFilter = useAtomValue(getBlockMetaKeyAtom(blockId, SessionsFolderMetaKey as keyof MetaType));
    const stateFilter = useAtomValue(getBlockMetaKeyAtom(blockId, SessionsStateMetaKey as keyof MetaType));
    const [now, setNow] = useState(Date.now());
    const [selected, setSelected] = useState<string>(null);
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

    // A row that went away hands the focus to the one that took its place, if the list had it.
    useEffect(() => {
        const prev = prevOrder.current;
        prevOrder.current = order;
        if (selected == null || order.includes(selected)) {
            return;
        }
        const next = nextSelection(prev, order, selected);
        setSelected(next);
        if (focusIsOurs()) {
            focusWanted.current = true;
        }
    }, [orderKey]);

    // A session that ended elsewhere while its dialog was open closes the dialog.
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
        const row = selected == null ? null : rowRefs.current.get(selected);
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
        setSelected(id);
        focusWanted.current = true;
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
        setSelected(s.id);
        setDialog({ kind: "end", id: s.id });
    };

    const hiddenGroup = groups.find((g) => g.id === HiddenGroupId);
    const askCleanup = () => {
        const ids = (hiddenGroup?.sessions ?? []).filter((s) => s.canend).map((s) => s.id);
        if (ids.length > 0) {
            setDialog({ kind: "cleanup", ids });
        }
    };

    const closeDialog = () => {
        setDialog(null);
        if (focusIsOurs()) {
            focusWanted.current = true;
        }
        if (selected == null) {
            setSelected(order[0] ?? null);
        }
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        const target = e.target as HTMLElement;
        const onRow = target?.dataset?.sessionRow != null;
        if (NavKeys.has(e.key)) {
            const next = moveSelection(order, selected, e.key);
            if (next != null) {
                e.preventDefault();
                focusRow(next);
            }
            return;
        }
        if (!onRow) {
            return;
        }
        const s = byId.get(target.dataset.sessionRow);
        if (s == null) {
            return;
        }
        if (e.key === "Enter") {
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
    const firstSelectable = selected != null && order.includes(selected) ? selected : (order[0] ?? null);

    return (
        <div className="flex h-full w-full flex-col overflow-hidden" data-role="molten-sessions">
            {/* With nothing listed the empty state says it: the summary row only stays for a notice. */}
            <div
                className={cn(
                    "flex items-center gap-3 border-b border-border px-3 py-2",
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
                        className={cn("ml-auto min-w-0 truncate text-12", notice.error ? "text-error" : "text-muted")}
                        role="status"
                        title={notice.text}
                    >
                        {notice.text}
                    </span>
                ) : null}
            </div>
            {data != null && allSessions.length === 0 ? (
                <SessionsEmpty blockId={blockId} />
            ) : data != null && sessions.length === 0 ? (
                <SessionsFilteredOut blockId={blockId} />
            ) : (
                <div
                    ref={listRef}
                    role="list"
                    aria-label="Durable sessions"
                    className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1 pb-3"
                    onKeyDown={onKeyDown}
                >
                    {groups.map((group) => (
                        <div key={group.id} role="group" aria-label={group.title}>
                            <GroupHeader group={group} onCleanup={askCleanup} />
                            <div className="flex flex-col gap-0.5">
                                {group.sessions.map((s) => (
                                    <SessionRow
                                        key={s.id}
                                        session={s}
                                        selected={s.id === firstSelectable}
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
                                        onSelect={() => setSelected(s.id)}
                                        onShow={() => show(s)}
                                        onEnd={() => askEnd(s)}
                                        onReconnect={() => reconnect(s)}
                                    />
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            )}
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
        </div>
    );
}
