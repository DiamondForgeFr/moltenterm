// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The notification center (FR-SHELL-002, FR-MC-010, FR-MC-019): what needs the user's attention in every workspace,
// newest first. A notification opens where it comes from, carries up to two actions, shows when its situation is
// resolved, and is settled by acting on it or going to its source (notification-settle.ts, #2026): it then moves to the
// Archived list, as it does when cleared by hand (the ×, Clear all with its undo); the Archived list keeps them until
// cleared for good. What arrives shows as a toast
// (FR-SHELL-055), each subject says only what the user chose, and the work running in every project shows on top. What
// each subject may say is set in Preferences › Notifications, which the center links to (FR-SHELL-106,
// notification-settings.tsx).
//
// The bell is gone (FR-BOSS-009, AC9, #2003): the center is the Notifications tab of Brokk's panel
// (NotificationsPanelBody), and what the bell hosted without drawing (the listeners, the toasts, the approval dialogs)
// is NotificationHost, mounted with Brokk's host. Nothing here opens by itself: a warning, an error or a question is a
// toast, a row of Brokk's À traiter and, when the developer set it to Vient, a visit.

import { atoms, createBlock, getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { Component, ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AgentHandoffGesture, answerAgentHandoff } from "./agent-handoff";
import { AgentLinksGesture } from "./agent-links/agent-links-model";
import { openAgentLinksGesture } from "./agent-links/agent-links-store";
import { startAgentSeen } from "./agent-seen";
import { BossBubbleModel } from "./boss/boss-store";
import { startDownloads } from "./downloads/downloads-notify";
import { DownloadsModel } from "./downloads/downloads-store";
import { startHandoffSystemNotifications } from "./handoff-system-notify";
import { tCount as translateCount, t as translateNow, useT } from "./i18n/i18n";
import { serverErrorText, serverText } from "./i18n/server-text";
import { InlineCodeText } from "./inline-code";
import { DepSyncHost } from "./mission/dep-sync";
import { registerSetupPrGestures } from "./mission/release-setup-gestures";
import { TrustApprovalHost } from "./mission/trust-approval";
import { MaxRenderedRows, notificationSourceLabel, NotificationSubject, subjectOf } from "./notification-rules";
import { openNotificationSettings } from "./notification-settings";
import { startNotificationSettling } from "./notification-settle-start";
import { startNotificationToasts } from "./notification-toasts";
import { workspaceLabel, WorkspaceLabel } from "./notification-workspace";
import { WorkspaceChip } from "./notification-workspace-chip";
import {
    activeEntries,
    archivedEntries,
    checkClickable,
    checkUnread,
    displayActions,
    formatAge,
    MoltentermNotification,
    NotificationAction,
    notificationActionLabel,
    notificationMessage,
    notificationTitle,
    rowKeyAction,
} from "./notifications-model";
import { MoltentermNotifications, registerNotificationGesture, startNotificationAutoRead } from "./notifications-store";
import { showProjectTab } from "./project/project-tab";
import { canStop, stopWork, useRunningWork, WorkItem } from "./running-work";
import { showUndoToast } from "./sidebar/sidebar-undo";
import { DominoLoader } from "./suite/suite";
import { TabActivity, whileShown } from "./tab-activity";
import { toneOf } from "./toast-model";
import { ToastStack } from "./toast-stack";
import { Toasts } from "./toast-store";
import { pathParent } from "./workspace-project";
import { loadWorkspaceSources } from "./workspace-rail";

const AgeTickMs = 30000;

const MainActionClass =
    "cursor-pointer rounded-6 border border-border px-2 py-0.5 text-12 text-primary hover:bg-hover disabled:cursor-default disabled:opacity-50";
const OtherActionClass =
    "cursor-pointer rounded-6 px-2 py-0.5 text-12 text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";

// Actions every window knows; features register their own (the gold update registers "update:review").
function registerBuiltInGestures(): () => void {
    const unregister = [
        registerNotificationGesture("path:reveal", async (args) => {
            if (typeof args.path !== "string" || args.path === "") {
                return { ok: false, error: translateNow("notif.center.noPath") };
            }
            getApi().openNativePath(pathParent(args.path) || args.path);
            return { ok: true };
        }),
        // must match TerminalGesture in pkg/molten/review/trunksync.go
        registerNotificationGesture("path:terminal", async (args) => {
            if (typeof args.path !== "string" || args.path === "") {
                return { ok: false, error: translateNow("notif.center.noPath") };
            }
            await createBlock({ meta: { view: "term", controller: "shell", "cmd:cwd": args.path } });
            return { ok: true };
        }),
        registerNotificationGesture(AgentHandoffGesture, answerAgentHandoff),
        registerNotificationGesture(AgentLinksGesture, openAgentLinksGesture),
        registerSetupPrGestures(),
    ];
    return () => unregister.forEach((fn) => fn());
}

function NotificationRow({
    entry,
    label,
    now,
    archived,
    highlighted,
    running,
    error,
    onOpen,
    onAction,
    onClear,
    onSilence,
}: {
    entry: MoltentermNotification;
    label: WorkspaceLabel;
    now: number;
    archived: boolean;
    highlighted: boolean;
    running: Record<string, boolean>;
    error: string;
    onOpen: () => void;
    onAction: (action: NotificationAction) => void;
    onClear: () => void;
    onSilence: (subject: NotificationSubject) => void;
}) {
    const unread = checkUnread(entry);
    const resolved = entry.resolved != null;
    const actions = displayActions(entry);
    const tone = toneOf(entry.kind);
    const anyRunning = actions.some((a) => running[`${entry.id}:${a.id}`]);
    const hasOrigin = checkClickable(entry);
    const subject = subjectOf(entry.source);
    const t = useT();
    const rowRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (highlighted) {
            rowRef.current?.scrollIntoView({ block: "nearest" });
        }
    }, [highlighted]);
    // Delete or Backspace on the row itself clears it, and the focus moves to a neighbour so the keyboard stays in the list.
    const clearAndKeepFocus = () => {
        const row = rowRef.current;
        const neighbour = row?.nextElementSibling ?? row?.previousElementSibling;
        if (neighbour instanceof HTMLElement && neighbour.dataset.testid === "notification-row") {
            neighbour.focus();
        }
        onClear();
    };
    const onRowKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        const action = e.nativeEvent.isComposing
            ? null
            : rowKeyAction(e.key, { onRow: e.target === e.currentTarget, archived, hasOrigin });
        if (action == null) {
            return;
        }
        e.preventDefault();
        if (action === "clear") {
            clearAndKeepFocus();
            return;
        }
        onOpen();
    };
    return (
        <div
            ref={rowRef}
            data-highlighted={highlighted || undefined}
            data-testid="notification-row"
            data-notif={entry.id}
            className={cn(
                "group flex w-full items-start gap-2 border-b border-border px-3 py-2 text-left",
                unread && "bg-line",
                highlighted && "molten-notification-highlight",
                resolved && "opacity-60",
                hasOrigin && "cursor-pointer hover:bg-hover"
            )}
            onClick={hasOrigin ? onOpen : undefined}
            onKeyDown={onRowKeyDown}
            role={hasOrigin ? "button" : undefined}
            tabIndex={archived ? undefined : 0}
        >
            <i
                aria-label={tone.label}
                className={cn("fa fa-solid mt-0.5 w-4 text-center", `fa-${tone.icon}`, tone.colorClass)}
            />
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                    <span className={cn("truncate", unread && "font-semibold")}>
                        <InlineCodeText text={notificationTitle(entry, t)} />
                    </span>
                    {unread ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" /> : null}
                    {!archived ? (
                        <button
                            type="button"
                            title={t("notif.center.clearOne")}
                            aria-label={t("notif.center.clearOne")}
                            data-testid="notification-clear"
                            onClick={(e) => {
                                e.stopPropagation();
                                onClear();
                            }}
                            className="ml-auto shrink-0 cursor-pointer rounded-6 px-1 text-muted opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-primary focus-visible:opacity-100"
                        >
                            <i className="fa fa-solid fa-xmark text-11" />
                        </button>
                    ) : null}
                </div>
                {entry.message ? (
                    <div className="mt-0.5 line-clamp-3 text-12 text-secondary">
                        <InlineCodeText text={notificationMessage(entry)} />
                    </div>
                ) : null}
                <div className="mt-1 flex items-center gap-1.5 text-11 text-muted">
                    {label ? (
                        <>
                            <WorkspaceChip label={label} onGo={onOpen} />
                            <span>·</span>
                        </>
                    ) : null}
                    {resolved ? (
                        <>
                            <span className="shrink-0">✓ {t("notif.center.resolved")}</span>
                            <span>·</span>
                        </>
                    ) : null}
                    <span className="shrink-0">{notificationSourceLabel(entry.source)}</span>
                    <span>·</span>
                    <span className="shrink-0 tabular-nums">{formatAge(entry.updated, now)}</span>
                    {entry.kind === "info" && subject != null && !archived ? (
                        <button
                            type="button"
                            data-testid="notification-silence"
                            onClick={(e) => {
                                e.stopPropagation();
                                onSilence(subject);
                            }}
                            className="ml-auto cursor-pointer rounded-6 px-1 text-muted opacity-0 group-hover:opacity-100 hover:text-primary focus-visible:opacity-100"
                        >
                            {t("notif.center.silence")}
                        </button>
                    ) : null}
                </div>
                {actions.length > 0 ? (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {actions.map((action, i) => (
                            <button
                                key={action.id}
                                type="button"
                                disabled={anyRunning}
                                data-testid="notification-action"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onAction(action);
                                }}
                                className={i === 0 ? MainActionClass : OtherActionClass}
                            >
                                {running[`${entry.id}:${action.id}`] ? <DominoLoader className="mr-1.5" /> : null}
                                {running[`${entry.id}:${action.id}`]
                                    ? t("notif.center.running")
                                    : notificationActionLabel(action)}
                            </button>
                        ))}
                    </div>
                ) : null}
                {error ? <div className="mt-1 text-12 text-danger">{error}</div> : null}
            </div>
        </div>
    );
}

// A row that fails to render is left out instead of breaking the panel.
class RowBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
    state = { failed: false };

    static getDerivedStateFromError() {
        return { failed: true };
    }

    componentDidCatch(error: unknown) {
        console.error("A notification could not be shown:", error);
    }

    render() {
        if (this.state.failed) {
            return (
                <div className="border-b border-border px-3 py-2 text-12 text-muted">
                    {translateNow("notif.center.rowFailed")}
                </div>
            );
        }
        return this.props.children;
    }
}

function WorkRow({ item, label, now }: { item: WorkItem; label: WorkspaceLabel; now: number }) {
    const t = useT();
    const [confirming, setConfirming] = useState(false);
    const [error, setError] = useState<string>(null);
    const measured = item.progress >= 0;
    const elapsed = item.startedat ? formatAge(item.startedat, now) : "";
    return (
        <div className="border-b border-border px-3 py-2" data-testid="running-work">
            <div className="flex items-center gap-2">
                <DominoLoader className="text-accent" />
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                {measured ? (
                    <span className="text-12 text-muted tabular-nums">{Math.round(item.progress * 100)}%</span>
                ) : null}
                {canStop(item) && !confirming ? (
                    <button
                        type="button"
                        data-testid="running-work-stop"
                        onClick={() => setConfirming(true)}
                        className="cursor-pointer rounded-6 px-1.5 py-0.5 text-12 text-secondary hover:bg-hover hover:text-primary"
                    >
                        {t("notif.work.stop")}
                    </button>
                ) : null}
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-hover">
                <div
                    className={cn("h-full rounded-full bg-accent", !measured && "mt-beat-blink w-1/3")}
                    style={measured ? { width: `${Math.round(item.progress * 100)}%` } : undefined}
                />
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-11 text-muted">
                {label ? (
                    <>
                        <WorkspaceChip
                            label={label}
                            onGo={() => {
                                if (!label.current) {
                                    getApi().switchWorkspace(label.id);
                                    return;
                                }
                                fireAndForget(() => showProjectTab(label.id));
                            }}
                        />
                        {item.detail || elapsed ? <span>·</span> : null}
                    </>
                ) : null}
                {item.detail ? (
                    <span className="min-w-0 truncate">{serverText(item.detailtext, item.detail)}</span>
                ) : null}
                {item.detail && elapsed ? <span>·</span> : null}
                {elapsed ? <span className="shrink-0 tabular-nums">{t("notif.work.started", { elapsed })}</span> : null}
            </div>
            {confirming ? (
                <div className="mt-1.5 flex items-center justify-end gap-2 text-12">
                    <span className="mr-auto text-secondary">
                        {t("notif.work.stopQuestion", { title: item.title })}
                    </span>
                    <button
                        type="button"
                        onClick={() => setConfirming(false)}
                        className="cursor-pointer rounded-6 px-1.5 py-0.5 text-secondary hover:bg-hover hover:text-primary"
                    >
                        {t("notif.work.keepIt")}
                    </button>
                    <button
                        type="button"
                        data-testid="running-work-confirm-stop"
                        onClick={() =>
                            fireAndForget(async () => {
                                try {
                                    await stopWork(item);
                                    setConfirming(false);
                                } catch (e) {
                                    setError(String(e?.message ?? e));
                                }
                            })
                        }
                        className="cursor-pointer rounded-6 border border-error/50 px-1.5 py-0.5 text-danger hover:bg-error/10"
                    >
                        {t("notif.work.stop")}
                    </button>
                </div>
            ) : null}
            {error ? <div className="mt-1 text-12 text-danger">{serverErrorText(error)}</div> : null}
        </div>
    );
}

// The center, as the Notifications tab of Brokk's panel draws it: the work that runs, the active notifications and the
// archived ones, with the bell's actions (mark all read, clear the archive, the link to Preferences). The panel leaves
// (onLeave) when an action takes the developer somewhere. What the developer looked at is settled when the tab is
// left, as the bell's panel did on closing: read, and the resolved ones archived.
export function NotificationsPanelBody({
    onLeave,
    highlightIds = [],
}: {
    onLeave: () => void;
    highlightIds?: string[];
}) {
    const t = useT();
    const model = MoltentermNotifications.getInstance();
    const entries = useAtomValue(model.entriesAtom, { store: globalStore });
    const listed = useAtomValue(model.shownEntriesAtom, { store: globalStore });
    const unread = useAtomValue(model.unreadCountAtom, { store: globalStore });
    const running = useAtomValue(model.runningAtom, { store: globalStore });
    const errors = useAtomValue(model.errorsAtom, { store: globalStore });
    const work = useRunningWork();
    const currentWorkspace = useAtomValue(atoms.workspace, { store: globalStore });
    const [tab, setTab] = useState<"active" | "archived">("active");
    const [workspaces, setWorkspaces] = useState<Map<string, Workspace>>(new Map());
    const [now, setNow] = useState(Date.now());
    const archived = archivedEntries(entries);
    const active = activeEntries(listed);

    useEffect(() => () => model.settleSeen(), [model]);
    useEffect(() => TabActivity.getInstance().every(whileShown(AgeTickMs), () => setNow(Date.now()), "clock"), []);
    useEffect(() => {
        if (tab === "archived" && archived.length === 0) {
            setTab("active");
        }
    }, [tab, archived.length]);
    useEffect(() => {
        let live = true;
        fireAndForget(async () => {
            const sources = await loadWorkspaceSources();
            const known = new Map(sources.map((s) => [s.workspace.oid, s.workspace]));
            if (currentWorkspace != null && !known.has(currentWorkspace.oid)) {
                known.set(currentWorkspace.oid, currentWorkspace);
            }
            if (live) {
                setWorkspaces(known);
            }
        });
        return () => {
            live = false;
        };
    }, [currentWorkspace]);

    // Clears the whole active list; the undo toast gives back exactly what was cleared (FR-MC-019, #2026).
    const clearAll = () => {
        const ids = active.map((e) => e.id);
        if (ids.length === 0) {
            return;
        }
        const undo = model.clear(ids);
        showUndoToast(translateCount("notif.center.cleared", ids.length), undo);
    };
    const list = tab === "archived" ? archived : active;
    const shown = list.slice(0, MaxRenderedRows);
    const hidden = list.length - shown.length;
    const showWork = tab === "active" && work.length > 0;
    return (
        <div data-testid="notification-center">
            <div className="flex items-center gap-3 border-b border-border px-3 py-1.5">
                <button
                    type="button"
                    data-testid="notification-list-active"
                    onClick={() => setTab("active")}
                    className={cn(
                        "cursor-pointer text-12 whitespace-nowrap",
                        tab === "active" ? "font-semibold text-primary" : "text-muted hover:text-secondary"
                    )}
                >
                    {t("notif.center.title")}
                </button>
                {archived.length > 0 ? (
                    <button
                        type="button"
                        data-testid="notification-list-archived"
                        onClick={() => setTab("archived")}
                        className={cn(
                            "cursor-pointer text-12 whitespace-nowrap",
                            tab === "archived" ? "font-semibold text-primary" : "text-muted hover:text-secondary"
                        )}
                    >
                        {t("notif.center.archived")}
                    </button>
                ) : null}
                <span className="flex-1" />
                {tab === "archived" ? (
                    <button
                        type="button"
                        title={t("notif.center.clearTitle")}
                        aria-label={t("notif.center.clear")}
                        data-testid="notification-clear-archive"
                        onClick={() => model.clearArchive()}
                        className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-6 text-secondary hover:bg-hover hover:text-primary"
                    >
                        <i className="fa fa-solid fa-trash-can text-11" aria-hidden />
                    </button>
                ) : (
                    <>
                        {unread > 0 ? (
                            <button
                                type="button"
                                title={t("notif.center.markAllRead")}
                                aria-label={t("notif.center.markAllRead")}
                                data-testid="notification-mark-all-read"
                                onClick={() => model.markAllRead()}
                                className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-6 text-secondary hover:bg-hover hover:text-primary"
                            >
                                <i className="fa fa-solid fa-check-double text-11" aria-hidden />
                            </button>
                        ) : null}
                        {active.length > 0 ? (
                            <button
                                type="button"
                                title={t("notif.center.clearAllTitle")}
                                data-testid="notification-clear-all"
                                onClick={clearAll}
                                className="cursor-pointer rounded-6 px-1.5 py-0.5 text-12 whitespace-nowrap text-secondary hover:bg-hover hover:text-primary"
                            >
                                {t("notif.center.clearAll")}
                            </button>
                        ) : null}
                    </>
                )}
                {/* The levels live in Preferences › Notifications, their one home (FR-SHELL-106). */}
                <button
                    type="button"
                    title={`${t("notif.center.settingsLink")}: ${t("notif.center.settingsTitle")}`}
                    aria-label={t("notif.center.settingsLink")}
                    data-testid="notification-settings-link"
                    onClick={() => {
                        onLeave();
                        openNotificationSettings();
                    }}
                    className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-6 text-muted hover:bg-hover hover:text-primary"
                >
                    <i className="fa fa-solid fa-sliders text-11" aria-hidden />
                </button>
            </div>
            {showWork ? (
                <div className="border-b border-border">
                    <div className="px-3 pt-2 text-11 font-medium tracking-wide text-muted uppercase">
                        {t("notif.center.runningHeading")}
                    </div>
                    {work.map((item) => (
                        <WorkRow
                            key={`${item.kind}:${item.id}`}
                            item={item}
                            label={workspaceLabel(item.workspaceid, workspaces, currentWorkspace?.oid)}
                            now={now}
                        />
                    ))}
                </div>
            ) : null}
            {shown.length === 0 && !showWork ? (
                <div className="px-3 py-6 text-center text-secondary" data-testid="notification-empty">
                    {t(tab === "archived" ? "notif.center.emptyArchived" : "notif.center.empty")}
                </div>
            ) : null}
            {shown.map((entry) => (
                <RowBoundary key={entry.id}>
                    <NotificationRow
                        entry={entry}
                        label={workspaceLabel(entry.workspaceid, workspaces, currentWorkspace?.oid, entry.tabid)}
                        now={now}
                        archived={tab === "archived"}
                        highlighted={highlightIds.includes(entry.id)}
                        running={running}
                        error={errors[entry.id]}
                        onOpen={() => {
                            onLeave();
                            fireAndForget(() => model.open(entry));
                        }}
                        onAction={(action) => {
                            if (action.kind === "open") {
                                onLeave();
                            }
                            fireAndForget(() => model.runAction(entry, action));
                        }}
                        onClear={() => model.clear([entry.id])}
                        onSilence={(subject) => {
                            onLeave();
                            openNotificationSettings(subject);
                        }}
                    />
                </RowBoundary>
            ))}
            {hidden > 0 ? (
                <div className="px-3 py-2 text-center text-12 text-muted">
                    {t("notif.center.more", { count: hidden })}
                </div>
            ) : null}
        </div>
    );
}

// Where a toast flies when it times out: Brokk's avatar, where its notification waits (the bell's place before #2003).
const AvatarRef = {
    get current(): HTMLElement {
        return document.querySelector<HTMLElement>("[data-brokk-avatar]");
    },
} as React.RefObject<HTMLElement>;

// What the bell hosted without drawing: the listeners that raise toasts and settle notifications, the dialogs that wait
// on an answer (dependency sync, trust), the toast stack, and the requests of the surfaces that want a section of
// Brokk's panel (a toast's Open, the downloads pill, a notification's View). A request only brings the panel on the
// developer's gesture; the one a notification makes for itself brings nothing unless the panel is open already.
export function NotificationHost() {
    const boss = BossBubbleModel.getInstance();
    const model = MoltentermNotifications.getInstance();
    const downloads = DownloadsModel.getInstance();
    const panelRequest = useAtomValue(model.panelRequestAtom, { store: globalStore });
    const downloadsRequest = useAtomValue(downloads.requestAtom, { store: globalStore });
    useEffect(() => startNotificationAutoRead(), []);
    useEffect(() => startAgentSeen(), []);
    useEffect(() => startNotificationSettling(), []);
    useEffect(() => registerBuiltInGestures(), []);
    useEffect(() => startNotificationToasts(), []);
    useEffect(() => startHandoffSystemNotifications(), []);
    useEffect(() => startDownloads(), []);
    useEffect(() => {
        if (panelRequest != null && panelRequest.ids.length > 0) {
            boss.showInOpenPanel("notifications", panelRequest.ids);
        }
    }, [panelRequest, boss]);
    useEffect(() => {
        if (downloadsRequest == null) {
            return;
        }
        Toasts.getInstance().clearNotificationToasts();
        boss.showPanel("downloads");
    }, [downloadsRequest, boss]);
    return (
        <>
            <DepSyncHost />
            <TrustApprovalHost />
            {/* On the body: the stack's z-index must compete with the dialogs, not with Brokk's layer. */}
            {createPortal(
                <ToastStack onOpenCenter={() => boss.showPanel("notifications")} bellRef={AvatarRef} />,
                document.body
            )}
        </>
    );
}
