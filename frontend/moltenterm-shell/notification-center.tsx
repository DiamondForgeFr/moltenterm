// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The notification center (FR-SHELL-002, FR-MC-010): a bell in the tab bar gathers what needs the user's attention in
// every workspace, newest first. A notification opens where it comes from, carries up to two actions, shows when its
// situation is resolved, and can be archived; the Archived tab keeps them until cleared.

import { getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
import { WorkspaceIcon } from "./workspace-icon";
import { pathParent, readWorkspaceProject } from "./workspace-project";
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
    workspace,
    now,
    archived,
    running,
    error,
    onOpen,
    onAction,
    onArchive,
}: {
    entry: MoltentermNotification;
    workspace: Workspace;
    now: number;
    archived: boolean;
    running: Record<string, boolean>;
    error: string;
    onOpen: () => void;
    onAction: (action: NotificationAction) => void;
    onArchive: () => void;
}) {
    const unread = checkUnread(entry);
    const resolved = entry.resolved != null;
    const actions = visibleActions(entry);
    const anyRunning = actions.some((a) => running[`${entry.id}:${a.id}`]);
    const hasOrigin = !!(entry.workspaceid || entry.tabid || entry.blockid);
    return (
        <div
            className={cn(
                "group flex w-full items-start gap-2 border-b border-border px-3 py-2 text-left",
                unread && "molten-notification-unread",
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
                    {resolved ? (
                        <>
                            <span>✓ Resolved</span>
                            <span>·</span>
                        </>
                    ) : null}
                    {workspace ? (
                        <>
                            <WorkspaceIcon
                                icon={workspace.icon}
                                color={workspace.color}
                                logo={readWorkspaceProject(workspace).logo}
                            />
                            <span className="truncate">{workspace.name}</span>
                            <span>·</span>
                        </>
                    ) : null}
                    <span>{entry.source}</span>
                    <span>·</span>
                    <span className="tabular-nums">{formatAge(entry.updated, now)}</span>
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

export function NotificationCenter() {
    const model = MoltentermNotifications.getInstance();
    const entries = useAtomValue(model.entriesAtom, { store: globalStore });
    const unread = useAtomValue(model.unreadCountAtom, { store: globalStore });
    const open = useAtomValue(model.openCountAtom, { store: globalStore });
    const running = useAtomValue(model.runningAtom, { store: globalStore });
    const errors = useAtomValue(model.errorsAtom, { store: globalStore });
    const [panelOpen, setPanelOpen] = useState(false);
    const [tab, setTab] = useState<"active" | "archived">("active");
    const [workspaces, setWorkspaces] = useState<Map<string, Workspace>>(new Map());
    const [now, setNow] = useState(Date.now());
    const rootRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    useEffect(() => startNotificationAutoRead(), []);
    useEffect(() => registerBuiltInGestures(), []);
    const [anchor, setAnchor] = useState<{ top: number; right: number }>(null);
    const archived = archivedEntries(entries);
    const active = activeEntries(entries);
    const shown = tab === "archived" ? archived : active;

    // Closing a panel the user looked at settles it, as Notulia does: read, and the resolved ones archived.
    const close = () => {
        setPanelOpen(false);
        setTab("active");
        model.settleSeen();
    };

    useEffect(() => {
        if (tab === "archived" && archived.length === 0) {
            setTab("active");
        }
    }, [tab, archived.length]);

    useEffect(() => {
        if (!panelOpen) {
            return;
        }
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), AgeTickMs);
        fireAndForget(async () => {
            const sources = await loadWorkspaceSources();
            setWorkspaces(new Map(sources.map((s) => [s.workspace.oid, s.workspace])));
        });
        const onPointerDown = (e: PointerEvent) => {
            const target = e.target as Node;
            if (!rootRef.current?.contains(target) && !panelRef.current?.contains(target)) {
                close();
            }
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                close();
            }
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("keydown", onKeyDown, true);
        return () => {
            clearInterval(timer);
            document.removeEventListener("pointerdown", onPointerDown, true);
            document.removeEventListener("keydown", onKeyDown, true);
        };
    }, [panelOpen]);

    const bellLabel =
        unread > 0
            ? `Notifications, ${unread} unread`
            : open > 0
              ? `Notifications, ${open} still open`
              : "Notifications";
    return (
        <div
            ref={rootRef}
            className="molten-notification-center relative flex h-full items-center"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
            <button
                type="button"
                aria-label={bellLabel}
                title="Notifications"
                onClick={(e) => {
                    if (panelOpen) {
                        close();
                        return;
                    }
                    const rect = e.currentTarget.getBoundingClientRect();
                    setAnchor({ top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) });
                    setPanelOpen(true);
                }}
                className="relative flex h-7 w-7 cursor-pointer items-center justify-center rounded text-secondary transition-colors hover:bg-hover hover:text-primary"
            >
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
                          className="molten-notification-panel fixed z-[9500] flex max-h-[60vh] w-[380px] flex-col rounded border border-border bg-modalbg text-sm text-primary shadow-lg"
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
                              ) : unread > 0 ? (
                                  <button
                                      type="button"
                                      onClick={() => model.markAllRead()}
                                      className="cursor-pointer rounded px-1.5 py-0.5 text-xs text-secondary hover:bg-hover hover:text-primary"
                                  >
                                      Mark all as read
                                  </button>
                              ) : null}
                          </div>
                          <div className="overflow-y-auto">
                              {shown.length === 0 ? (
                                  <div className="px-3 py-6 text-center text-secondary">
                                      {tab === "archived" ? "Nothing archived." : "Nothing needs your attention."}
                                  </div>
                              ) : (
                                  shown.map((entry) => (
                                      <NotificationRow
                                          key={entry.id}
                                          entry={entry}
                                          workspace={workspaces.get(entry.workspaceid)}
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
                                      />
                                  ))
                              )}
                          </div>
                      </div>,
                      document.body
                  )
                : null}
        </div>
    );
}
