// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The notification center (FR-SHELL-002): a bell in the tab bar gathers what needs the user's attention in every
// workspace, newest first; an entry opens where it comes from.

import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget, makeIconClass } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { formatAge, MoltentermNotification } from "./notifications-model";
import { MoltentermNotifications } from "./notifications-store";
import { loadWorkspaceSources } from "./workspace-rail";

const KindIcons: Record<MoltentermNotification["kind"], string> = {
    info: "circle-info",
    success: "circle-check",
    warning: "triangle-exclamation",
    error: "circle-exclamation",
};

function NotificationRow({
    entry,
    workspace,
    now,
    onOpen,
}: {
    entry: MoltentermNotification;
    workspace: Workspace;
    now: number;
    onOpen: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onOpen}
            className={cn(
                "flex w-full cursor-pointer items-start gap-2 border-b border-border px-3 py-2 text-left hover:bg-hover",
                !entry.read && "bg-accent/5"
            )}
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
                    <span className={cn("truncate", !entry.read && "font-semibold")}>{entry.title}</span>
                    {!entry.read ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" /> : null}
                </div>
                {entry.message ? (
                    <div className="mt-0.5 line-clamp-2 text-xs text-secondary">{entry.message}</div>
                ) : null}
                <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted">
                    {workspace ? (
                        <>
                            <i className={makeIconClass(workspace.icon, false)} style={{ color: workspace.color }} />
                            <span className="truncate">{workspace.name}</span>
                            <span>·</span>
                        </>
                    ) : null}
                    <span>{entry.source}</span>
                    <span>·</span>
                    <span>{formatAge(entry.time, now)}</span>
                </div>
            </div>
        </button>
    );
}

export function NotificationCenter() {
    const model = MoltentermNotifications.getInstance();
    const entries = useAtomValue(model.entriesAtom, { store: globalStore });
    const unread = useAtomValue(model.unreadCountAtom, { store: globalStore });
    const [open, setOpen] = useState(false);
    const [workspaces, setWorkspaces] = useState<Map<string, Workspace>>(new Map());
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) {
            return;
        }
        fireAndForget(async () => {
            const sources = await loadWorkspaceSources();
            setWorkspaces(new Map(sources.map((s) => [s.workspace.oid, s.workspace])));
        });
        const onPointerDown = (e: PointerEvent) => {
            if (!rootRef.current?.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                setOpen(false);
            }
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("keydown", onKeyDown, true);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown, true);
            document.removeEventListener("keydown", onKeyDown, true);
        };
    }, [open]);

    const now = Date.now();
    return (
        <div
            ref={rootRef}
            className="molten-notification-center relative flex h-full items-center"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
            <button
                type="button"
                aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
                title="Notifications"
                onClick={() => setOpen(!open)}
                className="relative flex h-7 w-7 cursor-pointer items-center justify-center rounded text-secondary transition-colors hover:bg-hover hover:text-primary"
            >
                <i className="fa fa-regular fa-bell" />
                {unread > 0 ? (
                    <span className="molten-notification-count absolute -top-0.5 -right-0.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-[var(--mt-accent-fg)]">
                        {unread > 99 ? "99+" : unread}
                    </span>
                ) : null}
            </button>
            {open ? (
                <div className="molten-notification-panel absolute top-full right-0 z-[9500] mt-1 flex max-h-[60vh] w-[380px] flex-col rounded border border-border bg-modalbg text-sm text-primary shadow-lg">
                    <div className="flex items-center border-b border-border px-3 py-2">
                        <span className="flex-1 font-semibold">Notifications</span>
                        <button
                            type="button"
                            disabled={unread === 0}
                            onClick={() => model.markAllRead()}
                            className="cursor-pointer rounded px-1.5 py-0.5 text-xs text-secondary hover:bg-hover hover:text-primary disabled:opacity-40"
                        >
                            Mark all as read
                        </button>
                    </div>
                    <div className="overflow-y-auto">
                        {entries.length === 0 ? (
                            <div className="px-3 py-6 text-center text-secondary">Nothing needs your attention.</div>
                        ) : (
                            entries.map((entry) => (
                                <NotificationRow
                                    key={entry.id}
                                    entry={entry}
                                    workspace={workspaces.get(entry.workspaceid)}
                                    now={now}
                                    onOpen={() => {
                                        setOpen(false);
                                        model.open(entry);
                                    }}
                                />
                            ))
                        )}
                    </div>
                </div>
            ) : null}
        </div>
    );
}
