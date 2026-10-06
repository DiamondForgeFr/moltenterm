// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The notification center (FR-SHELL-002, FR-MC-010, FR-MC-019): a bell in the tab bar gathers what needs the user's
// attention in every workspace, newest first. A notification opens where it comes from, carries up to two actions,
// shows when its situation is resolved, and can be archived; the Archived tab keeps them until cleared. As in Notulia,
// a warning or an error opens the panel by itself for a few seconds, each subject says only what the user chose, and
// the work running in every project shows on top, with a progress ring on the bell.

import { atoms, getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { Component, ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
    attentionArrivals,
    AttentionCoalesceMs,
    attentionDuration,
    Delivery,
    DeliveryLabels,
    MaxRenderedRows,
    NotificationSubject,
    NotificationSubjects,
    subjectOf,
} from "./notification-rules";
import { workspaceLabel, WorkspaceLabel } from "./notification-workspace";
import { WorkspaceChip } from "./notification-workspace-chip";
import {
    activeEntries,
    archivedEntries,
    checkUnread,
    formatAge,
    MoltentermNotification,
    NotificationAction,
    visibleActions,
} from "./notifications-model";
import { MoltentermNotifications, registerNotificationGesture, startNotificationAutoRead } from "./notifications-store";
import { showProjectTab } from "./project/project-tab";
import { canStop, overallProgress, stopWork, useRunningWork, WorkItem } from "./running-work";
import { pathParent } from "./workspace-project";
import { loadWorkspaceSources } from "./workspace-rail";

const KindIcons: Record<MoltentermNotification["kind"], string> = {
    info: "circle-info",
    success: "circle-check",
    warning: "triangle-exclamation",
    error: "circle-exclamation",
};

const AgeTickMs = 30000;

const MainActionClass =
    "cursor-pointer rounded border border-border px-2 py-0.5 text-xs text-primary hover:bg-hover disabled:cursor-default disabled:opacity-50";
const OtherActionClass =
    "cursor-pointer rounded px-2 py-0.5 text-xs text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";

// Actions every window knows; features register their own (the gold update registers "update:review").
function registerBuiltInGestures(): () => void {
    const unregister = [
        registerNotificationGesture("path:reveal", async (args) => {
            if (typeof args.path !== "string" || args.path === "") {
                return { ok: false, error: "no path to show" };
            }
            getApi().openNativePath(pathParent(args.path) || args.path);
            return { ok: true };
        }),
    ];
    return () => unregister.forEach((fn) => fn());
}

function NotificationRow({
    entry,
    label,
    now,
    archived,
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
    running: Record<string, boolean>;
    error: string;
    onOpen: () => void;
    onAction: (action: NotificationAction) => void;
    onArchive: () => void;
    onSilence: (subject: NotificationSubject) => void;
}) {
    const unread = checkUnread(entry);
    const resolved = entry.resolved != null;
    const actions = visibleActions(entry);
    const anyRunning = actions.some((a) => running[`${entry.id}:${a.id}`]);
    const hasOrigin = !!(entry.workspaceid || entry.tabid || entry.blockid);
    const subject = subjectOf(entry.source);
    return (
        <div
            className={cn(
                "group flex w-full items-start gap-2 border-b border-border px-3 py-2 text-left",
                unread && "bg-accent/7",
                resolved && "opacity-60",
                hasOrigin && "cursor-pointer hover:bg-hover"
            )}
            onClick={hasOrigin ? onOpen : undefined}
            role={hasOrigin ? "button" : undefined}
        >
            <i
                className={cn(
                    "fa fa-solid mt-0.5 w-4 text-center",
                    `fa-${KindIcons[entry.kind]}`,
                    entry.kind === "error" ? "text-error" : entry.kind === "warning" ? "text-warning" : "text-accent"
                )}
            />
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                    <span className={cn("truncate", unread && "font-semibold")}>{entry.title}</span>
                    {unread ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" /> : null}
                    {!archived ? (
                        <button
                            type="button"
                            title="Archive this notification"
                            aria-label="Archive this notification"
                            onClick={(e) => {
                                e.stopPropagation();
                                onArchive();
                            }}
                            className="ml-auto shrink-0 cursor-pointer rounded px-1 text-muted opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-primary focus-visible:opacity-100"
                        >
                            <i className="fa fa-solid fa-box-archive text-[11px]" />
                        </button>
                    ) : null}
                </div>
                {entry.message ? (
                    <div className="mt-0.5 line-clamp-3 text-xs text-secondary">{entry.message}</div>
                ) : null}
                <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted">
                    {label ? (
                        <>
                            <WorkspaceChip label={label} onGo={onOpen} />
                            <span>·</span>
                        </>
                    ) : null}
                    {resolved ? (
                        <>
                            <span className="shrink-0">✓ Resolved</span>
                            <span>·</span>
                        </>
                    ) : null}
                    <span className="shrink-0">{entry.source}</span>
                    <span>·</span>
                    <span className="shrink-0 tabular-nums">{formatAge(entry.updated, now)}</span>
                    {entry.kind === "info" && subject != null && !archived ? (
                        <button
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation();
                                onSilence(subject);
                            }}
                            className="ml-auto cursor-pointer rounded px-1 text-muted opacity-0 group-hover:opacity-100 hover:text-primary focus-visible:opacity-100"
                        >
                            Don't tell me again…
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
                                {running[`${entry.id}:${action.id}`] ? "Running…" : action.label}
                            </button>
                        ))}
                    </div>
                ) : null}
                {error ? <div className="mt-1 text-xs text-error">{error}</div> : null}
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
                <div className="border-b border-border px-3 py-2 text-xs text-muted">
                    This notification could not be shown.
                </div>
            );
        }
        return this.props.children;
    }
}

// The bell's ring while work runs: the measured progress, or a turning arc when nothing is measured.
function ProgressRing({ progress }: { progress: number }) {
    const radius = 13;
    const length = 2 * Math.PI * radius;
    const shown = progress == null ? 0.25 : Math.max(0.04, Math.min(1, progress));
    return (
        <svg
            aria-hidden
            viewBox="0 0 30 30"
            className={cn(
                "pointer-events-none absolute inset-0 h-full w-full -rotate-90",
                progress == null && "animate-spin"
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
    const [confirming, setConfirming] = useState(false);
    const [error, setError] = useState<string>(null);
    const measured = item.progress >= 0;
    const elapsed = item.startedat ? formatAge(item.startedat, now) : "";
    return (
        <div className="border-b border-border px-3 py-2" data-testid="running-work">
            <div className="flex items-center gap-2">
                <i className="fa fa-solid fa-circle-notch fa-spin w-4 text-center text-[11px] text-accent" />
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                {measured ? (
                    <span className="text-xs text-muted tabular-nums">{Math.round(item.progress * 100)}%</span>
                ) : null}
                {canStop(item) && !confirming ? (
                    <button
                        type="button"
                        onClick={() => setConfirming(true)}
                        className="cursor-pointer rounded px-1.5 py-0.5 text-xs text-secondary hover:bg-hover hover:text-primary"
                    >
                        Stop
                    </button>
                ) : null}
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-hover">
                <div
                    className={cn("h-full rounded-full bg-accent", !measured && "w-1/3 animate-pulse")}
                    style={measured ? { width: `${Math.round(item.progress * 100)}%` } : undefined}
                />
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted">
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
                {item.detail ? <span className="min-w-0 truncate">{item.detail}</span> : null}
                {item.detail && elapsed ? <span>·</span> : null}
                {elapsed ? <span className="shrink-0 tabular-nums">started {elapsed}</span> : null}
            </div>
            {confirming ? (
                <div className="mt-1.5 flex items-center justify-end gap-2 text-xs">
                    <span className="mr-auto text-secondary">Stop {item.title}?</span>
                    <button
                        type="button"
                        onClick={() => setConfirming(false)}
                        className="cursor-pointer rounded px-1.5 py-0.5 text-secondary hover:bg-hover hover:text-primary"
                    >
                        Keep it
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
                        className="cursor-pointer rounded border border-error/50 px-1.5 py-0.5 text-error hover:bg-error/10"
                    >
                        Stop
                    </button>
                </div>
            ) : null}
            {error ? <div className="mt-1 text-xs text-error">{error}</div> : null}
        </div>
    );
}

function SettingsView({ highlight }: { highlight: NotificationSubject }) {
    const model = MoltentermNotifications.getInstance();
    const prefs = useAtomValue(model.prefsAtom, { store: globalStore });
    return (
        <div className="flex flex-col gap-1 px-3 py-2" data-testid="notification-settings">
            <div className="pb-1 text-xs text-secondary">
                What each subject may tell. Errors are always told; a warning is at worst kept quietly.
            </div>
            {NotificationSubjects.map((subject) => {
                const chosen = prefs[subject.id] ?? "notify";
                return (
                    <div
                        key={subject.id}
                        className={cn(
                            "flex items-center gap-2 rounded px-2 py-1.5",
                            highlight === subject.id && "bg-accent/10 ring-1 ring-accent/40"
                        )}
                    >
                        <span className="min-w-0 flex-1 truncate text-primary">{subject.label}</span>
                        <div
                            role="radiogroup"
                            aria-label={subject.label}
                            className="flex rounded border border-border p-0.5"
                        >
                            {(["notify", "quiet", "off"] as Delivery[]).map((delivery) => (
                                <button
                                    key={delivery}
                                    type="button"
                                    role="radio"
                                    aria-checked={chosen === delivery}
                                    onClick={() => model.setDelivery(subject.id, delivery)}
                                    className={cn(
                                        "cursor-pointer rounded px-2 py-0.5 text-xs",
                                        chosen === delivery ? "bg-hover text-primary" : "text-muted hover:text-primary"
                                    )}
                                >
                                    {DeliveryLabels[delivery]}
                                </button>
                            ))}
                        </div>
                    </div>
                );
            })}
            <div className="pt-1 text-[11px] text-muted">
                Quiet keeps the message here, already read: no badge, and the panel does not open for it. Off does not
                keep it.
            </div>
        </div>
    );
}

// An appearance the panel made by itself (`auto`), showing only `only`; touched once the user reaches for it.
type Episode = { auto: boolean; touched: boolean; only: string[] };
const UserEpisode: Episode = { auto: false, touched: false, only: [] };

export function NotificationCenter() {
    const model = MoltentermNotifications.getInstance();
    const entries = useAtomValue(model.entriesAtom, { store: globalStore });
    const unread = useAtomValue(model.unreadCountAtom, { store: globalStore });
    const open = useAtomValue(model.openCountAtom, { store: globalStore });
    const running = useAtomValue(model.runningAtom, { store: globalStore });
    const errors = useAtomValue(model.errorsAtom, { store: globalStore });
    const work = useRunningWork();
    const [panelOpen, setPanelOpen] = useState(false);
    const [episode, setEpisode] = useState<Episode>(UserEpisode);
    const [tab, setTab] = useState<"active" | "archived" | "settings">("active");
    const [highlight, setHighlight] = useState<NotificationSubject>(null);
    const [workspaces, setWorkspaces] = useState<Map<string, Workspace>>(new Map());
    const [now, setNow] = useState(Date.now());
    const currentWorkspace = useAtomValue(atoms.workspace);
    const rootRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const bellRef = useRef<HTMLButtonElement>(null);
    useEffect(() => startNotificationAutoRead(), []);
    useEffect(() => registerBuiltInGestures(), []);
    const [anchor, setAnchor] = useState<{ top: number; right: number }>(null);
    const archived = archivedEntries(entries);
    const active = activeEntries(entries);

    // The timers and what the arrivals subscription reads belong to the appearance, not to a render of it.
    const seen = useRef<Map<string, number>>(null);
    const pending = useRef<string[]>([]);
    const coalesce = useRef<ReturnType<typeof setTimeout>>(null);
    const dismiss = useRef<ReturnType<typeof setTimeout>>(null);
    const panelOpenRef = useRef(false);
    const episodeRef = useRef<Episode>(UserEpisode);
    panelOpenRef.current = panelOpen;
    episodeRef.current = episode;

    const clearTimer = (timer: React.RefObject<ReturnType<typeof setTimeout>>) => {
        if (timer.current != null) {
            clearTimeout(timer.current);
            timer.current = null;
        }
    };

    const placePanel = () => {
        const rect = bellRef.current?.getBoundingClientRect();
        if (rect != null) {
            setAnchor({ top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) });
        }
    };

    // An appearance closing by itself leaves what it showed unread; a panel the user looked at is settled, as Notulia
    // does: read, and the resolved ones archived.
    const close = (reason: "user" | "auto") => {
        clearTimer(dismiss);
        clearTimer(coalesce);
        pending.current = [];
        setPanelOpen(false);
        setTab("active");
        setHighlight(null);
        setEpisode(UserEpisode);
        if (reason === "user") {
            model.settleSeen();
        }
    };
    const closeRef = useRef(close);
    closeRef.current = close;

    const openForUser = () => {
        clearTimer(dismiss);
        placePanel();
        setEpisode(UserEpisode);
        setPanelOpen(true);
    };

    const touch = () => {
        if (!episodeRef.current.auto || episodeRef.current.touched) {
            return;
        }
        clearTimer(dismiss);
        setEpisode({ ...episodeRef.current, touched: true });
    };

    // Shows what piled up; a panel the user opened is never interrupted, the arrival is already in its list.
    const showArrivals = () => {
        const only = pending.current;
        if (only.length === 0) {
            return;
        }
        if (panelOpenRef.current && !episodeRef.current.auto) {
            pending.current = [];
            return;
        }
        placePanel();
        const touched = episodeRef.current.auto && episodeRef.current.touched;
        setEpisode({ auto: true, touched, only });
        setTab("active");
        setPanelOpen(true);
        clearTimer(dismiss);
        if (!touched) {
            dismiss.current = setTimeout(() => closeRef.current("auto"), attentionDuration(only.length));
        }
    };

    useEffect(() => {
        if (seen.current == null) {
            seen.current = new Map(entries.map((e) => [e.id, e.updated]));
            return;
        }
        const arrivals = attentionArrivals(entries, seen.current);
        seen.current = new Map(entries.map((e) => [e.id, e.updated]));
        if (arrivals.length === 0 || document.visibilityState !== "visible") {
            return;
        }
        pending.current = [...new Set([...pending.current, ...arrivals])];
        if (panelOpenRef.current) {
            showArrivals();
            return;
        }
        clearTimer(coalesce);
        coalesce.current = setTimeout(() => {
            coalesce.current = null;
            showArrivals();
        }, AttentionCoalesceMs);
    }, [entries]);

    useEffect(
        () => () => {
            clearTimer(coalesce);
            clearTimer(dismiss);
        },
        []
    );

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
        const timer = setInterval(() => setNow(Date.now()), AgeTickMs);
        return () => clearInterval(timer);
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
            // Working elsewhere while an untouched appearance shows does not count as reading it.
            closeRef.current(episodeRef.current.auto && !episodeRef.current.touched ? "auto" : "user");
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                closeRef.current("user");
            }
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("keydown", onKeyDown, true);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown, true);
            document.removeEventListener("keydown", onKeyDown, true);
        };
    }, [panelOpen]);

    const list =
        tab === "archived"
            ? archived
            : episode.auto && episode.only.length > 0
              ? active.filter((e) => episode.only.includes(e.id))
              : active;
    const shown = list.slice(0, MaxRenderedRows);
    const hidden = list.length - shown.length;
    const progress = overallProgress(work);
    const showWork = tab === "active" && !(episode.auto && episode.only.length > 0) && work.length > 0;

    const bellLabel = [
        unread > 0
            ? `Notifications, ${unread} unread`
            : open > 0
              ? `Notifications, ${open} still open`
              : "Notifications",
        work.length > 0 ? `${work.length} running` : null,
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
                    // Reaching for the bell during an appearance shows the whole list rather than closing it.
                    if (episode.auto) {
                        clearTimer(dismiss);
                        setEpisode({ auto: false, touched: true, only: [] });
                        return;
                    }
                    close("user");
                }}
                className="relative flex h-7 w-7 cursor-pointer items-center justify-center rounded text-secondary transition-colors hover:bg-hover hover:text-primary"
            >
                {work.length > 0 ? <ProgressRing progress={progress} /> : null}
                <i className="fa fa-regular fa-bell" />
                {unread > 0 ? (
                    <span className="molten-notification-count absolute -top-0.5 -right-0.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-[var(--mt-accent-fg)]">
                        {unread > 99 ? "99+" : unread}
                    </span>
                ) : open > 0 ? (
                    <span className="absolute top-0.5 right-0.5 h-2 w-2 rounded-full bg-accent" />
                ) : null}
            </button>
            {/* Portaled to the body: inside the tab bar the panel would sit under the blocks' stacking context. */}
            {panelOpen && anchor
                ? createPortal(
                      <div
                          ref={panelRef}
                          style={{ top: anchor.top, right: anchor.right }}
                          onPointerDown={touch}
                          onPointerEnter={touch}
                          data-testid="notification-panel"
                          data-auto={episode.auto && !episode.touched ? "true" : undefined}
                          className="molten-notification-panel fixed z-[9500] flex max-h-[60vh] w-[380px] flex-col rounded border border-border bg-modalbg text-sm text-primary shadow-lg"
                      >
                          <div className="flex items-center gap-3 border-b border-border px-3 py-2">
                              <button
                                  type="button"
                                  onClick={() => {
                                      setTab("active");
                                      setEpisode(UserEpisode);
                                  }}
                                  className={cn(
                                      "cursor-pointer font-semibold",
                                      tab === "active" ? "text-primary" : "text-muted hover:text-secondary"
                                  )}
                              >
                                  Notifications
                              </button>
                              {archived.length > 0 ? (
                                  <button
                                      type="button"
                                      onClick={() => setTab("archived")}
                                      className={cn(
                                          "cursor-pointer text-xs",
                                          tab === "archived"
                                              ? "font-semibold text-primary"
                                              : "text-muted hover:text-secondary"
                                      )}
                                  >
                                      Archived
                                  </button>
                              ) : null}
                              <span className="flex-1" />
                              {tab === "archived" ? (
                                  <button
                                      type="button"
                                      title="Deletes the archived notifications for good."
                                      onClick={() => model.clearArchive()}
                                      className="cursor-pointer rounded px-1.5 py-0.5 text-xs text-secondary hover:bg-hover hover:text-primary"
                                  >
                                      Clear
                                  </button>
                              ) : tab === "active" && unread > 0 ? (
                                  <button
                                      type="button"
                                      onClick={() => model.markAllRead()}
                                      className="cursor-pointer rounded px-1.5 py-0.5 text-xs text-secondary hover:bg-hover hover:text-primary"
                                  >
                                      Mark all as read
                                  </button>
                              ) : null}
                              <button
                                  type="button"
                                  title="What each subject may tell"
                                  aria-label="Notification settings"
                                  onClick={() => {
                                      setHighlight(null);
                                      setTab(tab === "settings" ? "active" : "settings");
                                  }}
                                  className={cn(
                                      "cursor-pointer rounded px-1 py-0.5 text-xs hover:bg-hover hover:text-primary",
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
                                      <div className="px-3 pt-2 text-[11px] font-medium tracking-wide text-muted uppercase">
                                          Running
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
                                      {tab === "archived" ? "Nothing archived." : "Nothing needs your attention."}
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
                                  <div className="px-3 py-2 text-center text-xs text-muted">+{hidden} more</div>
                              ) : null}
                          </div>
                      </div>,
                      document.body
                  )
                : null}
        </div>
    );
}
