// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The notification center (FR-SHELL-002, FR-MC-010, FR-MC-019): a bell in the tab bar gathers what needs the user's
// attention in every workspace, newest first. A notification opens where it comes from, carries up to two actions,
// shows when its situation is resolved, and can be archived; the Archived tab keeps them until cleared. What arrives
// shows as a toast instead of opening the panel (FR-SHELL-055), each subject says only what the user chose, and the
// work running in every project shows on top, with a progress ring on the bell. What needs an answer opens the panel
// on itself in the focused window (#790, notification-attention.ts).

import { atoms, createBlock, getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { Component, ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AgentHandoffGesture, answerAgentHandoff } from "./agent-handoff";
import { startAgentSeen } from "./agent-seen";
import { startHandoffSystemNotifications } from "./handoff-system-notify";
import { t as translateNow, useT, useTCount } from "./i18n/i18n";
import { serverErrorText, serverText } from "./i18n/server-text";
import { InlineCodeText } from "./inline-code";
import { DepSyncHost } from "./mission/dep-sync";
import { checkAnswered } from "./notification-attention";
import {
    badgeCount,
    Delivery,
    DeliveryLabels,
    MaxRenderedRows,
    notificationSourceLabel,
    NotificationSubject,
    NotificationSubjects,
    subjectOf,
} from "./notification-rules";
import { startNotificationToasts } from "./notification-toasts";
import { workspaceLabel, WorkspaceLabel } from "./notification-workspace";
import { WorkspaceChip } from "./notification-workspace-chip";
import {
    activeEntries,
    archivedEntries,
    checkUnread,
    displayActions,
    formatAge,
    MoltentermNotification,
    NotificationAction,
    notificationActionLabel,
    notificationMessage,
    notificationTitle,
} from "./notifications-model";
import { MoltentermNotifications, registerNotificationGesture, startNotificationAutoRead } from "./notifications-store";
import { showProjectTab } from "./project/project-tab";
import { canStop, overallProgress, stopWork, useRunningWork, WorkItem } from "./running-work";
import { DominoLoader } from "./suite/suite";
import { TabActivity, whileShown } from "./tab-activity";
import { toneOf } from "./toast-model";
import { ToastStack } from "./toast-stack";
import { Toasts } from "./toast-store";
import { useWorkingBeat } from "./working-beat";
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
    onArchive,
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
    onArchive: () => void;
    onSilence: (subject: NotificationSubject) => void;
}) {
    const unread = checkUnread(entry);
    const resolved = entry.resolved != null;
    const actions = displayActions(entry);
    const tone = toneOf(entry.kind);
    const anyRunning = actions.some((a) => running[`${entry.id}:${a.id}`]);
    const hasOrigin = !!(entry.workspaceid || entry.tabid || entry.blockid);
    const subject = subjectOf(entry.source);
    const t = useT();
    const rowRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (highlighted) {
            rowRef.current?.scrollIntoView({ block: "nearest" });
        }
    }, [highlighted]);
    return (
        <div
            ref={rowRef}
            data-highlighted={highlighted || undefined}
            className={cn(
                "group flex w-full items-start gap-2 border-b border-border px-3 py-2 text-left",
                unread && "bg-line",
                highlighted && "molten-notification-highlight",
                resolved && "opacity-60",
                hasOrigin && "cursor-pointer hover:bg-hover"
            )}
            onClick={hasOrigin ? onOpen : undefined}
            role={hasOrigin ? "button" : undefined}
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
                            title={t("notif.center.archiveOne")}
                            aria-label={t("notif.center.archiveOne")}
                            onClick={(e) => {
                                e.stopPropagation();
                                onArchive();
                            }}
                            className="ml-auto shrink-0 cursor-pointer rounded-6 px-1 text-muted opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-primary focus-visible:opacity-100"
                        >
                            <i className="fa fa-solid fa-box-archive text-11" />
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
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onAction(action);
                                }}
                                className={i === 0 ? MainActionClass : OtherActionClass}
                            >
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

// The bell's ring while work runs: the measured progress, or an arc turning on the working beat when nothing is
// measured.
function ProgressRing({ progress }: { progress: number }) {
    useWorkingBeat(progress == null);
    const radius = 13;
    const length = 2 * Math.PI * radius;
    const shown = progress == null ? 0.25 : Math.max(0.04, Math.min(1, progress));
    return (
        <svg
            aria-hidden
            viewBox="0 0 30 30"
            className={cn(
                "pointer-events-none absolute inset-0 h-full w-full -rotate-90",
                progress == null && "mt-beat-turn"
            )}
        >
            <circle cx="15" cy="15" r={radius} fill="none" stroke="currentColor" strokeOpacity={0.15} strokeWidth={2} />
            <circle
                cx="15"
                cy="15"
                r={radius}
                fill="none"
                stroke="var(--color-accent)"
                strokeWidth={2}
                strokeLinecap="round"
                strokeDasharray={`${shown * length} ${length}`}
            />
        </svg>
    );
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

function SettingsView({ highlight }: { highlight: NotificationSubject }) {
    const t = useT();
    const model = MoltentermNotifications.getInstance();
    const prefs = useAtomValue(model.prefsAtom, { store: globalStore });
    const panelPolicy = useAtomValue(model.panelPolicyAtom, { store: globalStore });
    return (
        <div className="flex flex-col gap-1 px-3 py-2" data-testid="notification-settings">
            <label className="flex cursor-pointer items-start gap-2 rounded-4 px-2 py-1.5 hover:bg-hover">
                <input
                    type="checkbox"
                    data-testid="notification-panel-policy"
                    checked={panelPolicy === "all"}
                    onChange={(e) => model.setPanelPolicy(e.target.checked ? "all" : "answers")}
                    className="mt-0.5 cursor-pointer accent-[var(--color-accent)]"
                />
                <span className="min-w-0 flex-1">
                    <span className="block text-primary">{t("notif.settings.openPanel")}</span>
                    <span className="block text-11 text-muted">{t("notif.settings.openPanelHint")}</span>
                </span>
            </label>
            <div className="pt-1 pb-1 text-12 text-secondary">{t("notif.settings.intro")}</div>
            {NotificationSubjects.map((subject) => {
                const chosen = prefs[subject.id] ?? "notify";
                return (
                    <div
                        key={subject.id}
                        className={cn(
                            "flex items-center gap-2 rounded-4 px-2 py-1.5",
                            highlight === subject.id && "bg-accent/10 ring-1 ring-accent/40"
                        )}
                    >
                        <span className="min-w-0 flex-1 truncate text-primary">{t(subject.labelKey)}</span>
                        <div
                            role="radiogroup"
                            aria-label={t(subject.labelKey)}
                            className="flex rounded-4 border border-border p-0.5"
                        >
                            {(["notify", "quiet", "off"] as Delivery[]).map((delivery) => (
                                <button
                                    key={delivery}
                                    type="button"
                                    role="radio"
                                    aria-checked={chosen === delivery}
                                    onClick={() => model.setDelivery(subject.id, delivery)}
                                    className={cn(
                                        "cursor-pointer rounded-6 px-2 py-0.5 text-12",
                                        chosen === delivery ? "bg-hover text-primary" : "text-muted hover:text-primary"
                                    )}
                                >
                                    {t(DeliveryLabels[delivery])}
                                </button>
                            ))}
                        </div>
                    </div>
                );
            })}
            <div className="pt-1 text-11 text-muted">{t("notif.settings.footer")}</div>
        </div>
    );
}

export function NotificationCenter() {
    const t = useT();
    const tc = useTCount();
    const model = MoltentermNotifications.getInstance();
    const entries = useAtomValue(model.entriesAtom, { store: globalStore });
    const listed = useAtomValue(model.shownEntriesAtom, { store: globalStore });
    const unread = useAtomValue(model.unreadCountAtom, { store: globalStore });
    const open = useAtomValue(model.openCountAtom, { store: globalStore });
    const count = useAtomValue(model.attentionCountAtom, { store: globalStore });
    const panelRequest = useAtomValue(model.panelRequestAtom, { store: globalStore });
    const running = useAtomValue(model.runningAtom, { store: globalStore });
    const errors = useAtomValue(model.errorsAtom, { store: globalStore });
    const work = useRunningWork();
    const [panelOpen, setPanelOpen] = useState(false);
    const [tab, setTab] = useState<"active" | "archived" | "settings">("active");
    const [highlight, setHighlight] = useState<NotificationSubject>(null);
    // The notifications the panel opened by itself for (#790): highlighted, and it closes once they are answered.
    const [selfOpenedFor, setSelfOpenedFor] = useState<string[]>([]);
    const [highlightIds, setHighlightIds] = useState<string[]>([]);
    // Bumped when the count rises, to replay the badge's arrival pulse.
    const [pulse, setPulse] = useState(0);
    const lastCountRef = useRef(count);
    const [workspaces, setWorkspaces] = useState<Map<string, Workspace>>(new Map());
    const [now, setNow] = useState(Date.now());
    const currentWorkspace = useAtomValue(atoms.workspace);
    const rootRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const bellRef = useRef<HTMLButtonElement>(null);
    useEffect(() => startNotificationAutoRead(), []);
    useEffect(() => startAgentSeen(), []);
    useEffect(() => registerBuiltInGestures(), []);
    useEffect(() => startNotificationToasts(), []);
    useEffect(() => startHandoffSystemNotifications(), []);
    const [anchor, setAnchor] = useState<{ top: number; right: number }>(null);
    const archived = archivedEntries(entries);
    const active = activeEntries(listed);

    const placePanel = () => {
        const rect = bellRef.current?.getBoundingClientRect();
        if (rect != null) {
            setAnchor({ top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) });
        }
    };

    // A panel the user looked at is settled, as Notulia does: read, and the resolved ones archived.
    const close = () => {
        setPanelOpen(false);
        setTab("active");
        setHighlight(null);
        setSelfOpenedFor([]);
        setHighlightIds([]);
        model.settleSeen();
    };
    const closeRef = useRef(close);
    closeRef.current = close;

    const openForUser = () => {
        placePanel();
        Toasts.getInstance().clearNotificationToasts();
        setSelfOpenedFor([]);
        setHighlightIds([]);
        setPanelOpen(true);
    };

    useEffect(() => {
        if (count > lastCountRef.current) {
            setPulse((p) => p + 1);
        }
        lastCountRef.current = count;
    }, [count]);

    // A notification that needs an answer opens the panel on it (notification-toasts.ts decides which, #790). A panel
    // the user opened stays theirs: the entry is only highlighted.
    useEffect(() => {
        if (panelRequest == null || panelRequest.ids.length === 0) {
            return;
        }
        placePanel();
        Toasts.getInstance().clearNotificationToasts();
        setTab("active");
        setSelfOpenedFor((current) =>
            panelOpen && current.length === 0 ? current : [...new Set([...current, ...panelRequest.ids])]
        );
        setHighlightIds(panelRequest.ids);
        setPanelOpen(true);
    }, [panelRequest]);

    useEffect(() => {
        if (!panelOpen || selfOpenedFor.length === 0 || !checkAnswered(entries, selfOpenedFor)) {
            return;
        }
        closeRef.current();
    }, [panelOpen, selfOpenedFor, entries]);

    useEffect(() => {
        if (tab === "archived" && archived.length === 0) {
            setTab("active");
        }
    }, [tab, archived.length]);

    const tracking = panelOpen || work.length > 0;
    useEffect(() => {
        if (!tracking) {
            return;
        }
        setNow(Date.now());
        return TabActivity.getInstance().every(whileShown(AgeTickMs), () => setNow(Date.now()), "clock");
    }, [tracking]);

    useEffect(() => {
        if (!panelOpen) {
            return;
        }
        fireAndForget(async () => {
            const sources = await loadWorkspaceSources();
            const known = new Map(sources.map((s) => [s.workspace.oid, s.workspace]));
            if (currentWorkspace != null && !known.has(currentWorkspace.oid)) {
                known.set(currentWorkspace.oid, currentWorkspace);
            }
            setWorkspaces(known);
        });
        const onPointerDown = (e: PointerEvent) => {
            const target = e.target as Node;
            if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) {
                return;
            }
            closeRef.current();
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                closeRef.current();
            }
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("keydown", onKeyDown, true);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown, true);
            document.removeEventListener("keydown", onKeyDown, true);
        };
    }, [panelOpen]);

    const list = tab === "archived" ? archived : active;
    const shown = list.slice(0, MaxRenderedRows);
    const hidden = list.length - shown.length;
    const progress = overallProgress(work);
    const showWork = tab === "active" && work.length > 0;

    const bellLabel = [
        count > 0
            ? tc("notif.center.bellUnread", count)
            : open > 0
              ? tc("notif.center.bellOpen", open)
              : t("notif.center.title"),
        work.length > 0 ? t("notif.center.bellRunning", { count: work.length }) : null,
    ]
        .filter(Boolean)
        .join(" · ");
    return (
        <div
            ref={rootRef}
            className="molten-notification-center relative flex h-full items-center"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
            <button
                ref={bellRef}
                type="button"
                aria-label={bellLabel}
                title={bellLabel}
                data-testid="notification-bell"
                onClick={() => {
                    if (!panelOpen) {
                        openForUser();
                        return;
                    }
                    close();
                }}
                className={cn(
                    "relative flex h-7 w-7 cursor-pointer items-center justify-center rounded-6 transition-colors duration-120 ease-mt hover:bg-hover hover:text-primary",
                    count > 0 ? "text-primary" : "text-secondary"
                )}
            >
                {work.length > 0 ? <ProgressRing progress={progress} /> : null}
                <i className={cn("fa fa-bell", count > 0 ? "fa-solid" : "fa-regular")} />
                {/* The count keeps the accent of the bell's other signals: amber for waiting agents would read as one
                    more agent state next to the tabs' amber dots. */}
                {count > 0 ? (
                    <span
                        key={pulse}
                        data-testid="notification-count"
                        className={cn(
                            "molten-notification-count pointer-events-none absolute flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-12 leading-none font-semibold text-[var(--mt-accent-fg)] tabular-nums",
                            pulse > 0 && "molten-notification-count-arrive",
                            // The wider "9+" pill sits further right so it only overlaps the bell's corner; higher,
                            // the window's top edge would cut its ring.
                            count > 9 ? "-top-1 -right-3" : "-top-1 -right-2"
                        )}
                    >
                        {badgeCount(count)}
                    </span>
                ) : open > 0 ? (
                    <span className="absolute top-0.5 right-0.5 h-2 w-2 rounded-full bg-accent" />
                ) : null}
            </button>
            <DepSyncHost />
            {createPortal(<ToastStack onOpenCenter={openForUser} />, document.body)}
            {/* Portaled to the body: inside the tab bar the panel would sit under the blocks' stacking context. */}
            {panelOpen && anchor
                ? createPortal(
                      <div
                          ref={panelRef}
                          style={{ top: anchor.top, right: anchor.right }}
                          data-testid="notification-panel"
                          className="molten-notification-panel fixed z-[9500] flex max-h-[60vh] w-[380px] flex-col rounded-4 border border-border bg-surface-3 text-13 leading-5 text-primary shadow-command"
                      >
                          <div className="flex items-center gap-3 border-b border-border px-3 py-2">
                              <button
                                  type="button"
                                  onClick={() => setTab("active")}
                                  className={cn(
                                      "cursor-pointer font-semibold",
                                      tab === "active" ? "text-primary" : "text-muted hover:text-secondary"
                                  )}
                              >
                                  {t("notif.center.title")}
                              </button>
                              {archived.length > 0 ? (
                                  <button
                                      type="button"
                                      onClick={() => setTab("archived")}
                                      className={cn(
                                          "cursor-pointer text-12",
                                          tab === "archived"
                                              ? "font-semibold text-primary"
                                              : "text-muted hover:text-secondary"
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
                                      onClick={() => model.clearArchive()}
                                      className="cursor-pointer rounded-6 px-1.5 py-0.5 text-12 text-secondary hover:bg-hover hover:text-primary"
                                  >
                                      {t("notif.center.clear")}
                                  </button>
                              ) : tab === "active" && unread > 0 ? (
                                  <button
                                      type="button"
                                      onClick={() => model.markAllRead()}
                                      className="cursor-pointer rounded-6 px-1.5 py-0.5 text-12 text-secondary hover:bg-hover hover:text-primary"
                                  >
                                      {t("notif.center.markAllRead")}
                                  </button>
                              ) : null}
                              <button
                                  type="button"
                                  title={t("notif.center.settingsTitle")}
                                  aria-label={t("notif.center.settingsLabel")}
                                  onClick={() => {
                                      setHighlight(null);
                                      setTab(tab === "settings" ? "active" : "settings");
                                  }}
                                  className={cn(
                                      "cursor-pointer rounded-6 px-1 py-0.5 text-12 hover:bg-hover hover:text-primary",
                                      tab === "settings" ? "text-primary" : "text-muted"
                                  )}
                              >
                                  <i className="fa fa-solid fa-gear" />
                              </button>
                          </div>
                          <div className="overflow-y-auto">
                              {tab === "settings" ? <SettingsView highlight={highlight} /> : null}
                              {showWork ? (
                                  <div className="border-b border-border">
                                      <div className="px-3 pt-2 text-11 font-medium tracking-wide text-muted uppercase">
                                          {t("notif.center.runningHeading")}
                                      </div>
                                      {work.map((item) => (
                                          <WorkRow
                                              key={`${item.kind}:${item.id}`}
                                              item={item}
                                              label={workspaceLabel(
                                                  item.workspaceid,
                                                  workspaces,
                                                  currentWorkspace?.oid
                                              )}
                                              now={now}
                                          />
                                      ))}
                                  </div>
                              ) : null}
                              {tab !== "settings" && shown.length === 0 && !showWork ? (
                                  <div className="px-3 py-6 text-center text-secondary">
                                      {t(tab === "archived" ? "notif.center.emptyArchived" : "notif.center.empty")}
                                  </div>
                              ) : null}
                              {tab !== "settings"
                                  ? shown.map((entry) => (
                                        <RowBoundary key={entry.id}>
                                            <NotificationRow
                                                entry={entry}
                                                label={workspaceLabel(
                                                    entry.workspaceid,
                                                    workspaces,
                                                    currentWorkspace?.oid
                                                )}
                                                now={now}
                                                archived={tab === "archived"}
                                                highlighted={highlightIds.includes(entry.id)}
                                                running={running}
                                                error={errors[entry.id]}
                                                onOpen={() => {
                                                    setPanelOpen(false);
                                                    fireAndForget(() => model.open(entry));
                                                }}
                                                onAction={(action) => {
                                                    if (action.kind === "open") {
                                                        setPanelOpen(false);
                                                    }
                                                    fireAndForget(() => model.runAction(entry, action));
                                                }}
                                                onArchive={() => model.archive([entry.id])}
                                                onSilence={(subject) => {
                                                    setHighlight(subject);
                                                    setTab("settings");
                                                }}
                                            />
                                        </RowBoundary>
                                    ))
                                  : null}
                              {tab !== "settings" && hidden > 0 ? (
                                  <div className="px-3 py-2 text-center text-12 text-muted">
                                      {t("notif.center.more", { count: hidden })}
                                  </div>
                              ) : null}
                          </div>
                      </div>,
                      document.body
                  )
                : null}
        </div>
    );
}
