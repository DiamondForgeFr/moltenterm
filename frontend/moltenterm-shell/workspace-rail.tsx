// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The workspace rail (FR-SHELL-001, DS-SHELL-002): every workspace at a glance on the left, one click to switch, as
// in Notulia. It replaces the switcher of the tab bar and reuses Wave's workspace calls and editor.

import { ContextMenuModel } from "@/app/store/contextmenu";
import { atoms, getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { WorkspaceService } from "@/app/store/services";
import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { WorkspaceEditor } from "@/app/tab/workspaceeditor";
import { cn, fireAndForget, makeIconClass } from "@/util/util";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { unreadByWorkspace } from "./notifications-model";
import { MoltentermNotifications } from "./notifications-store";
import { makeWorkspaceRailEntries, WorkspaceRailEntry, WorkspaceRailSource } from "./workspace-rail-model";

export async function loadWorkspaceSources(): Promise<WorkspaceRailSource[]> {
    const list = await WorkspaceService.ListWorkspaces();
    const sources: WorkspaceRailSource[] = [];
    for (const entry of list ?? []) {
        // Wave's switcher does the same: the object atom must exist before the editor writes through it.
        globalStore.get(getWaveObjectAtom(makeORef("workspace", entry.workspaceid)));
        sources.push({ workspace: await WorkspaceService.GetWorkspace(entry.workspaceid), windowId: entry.windowid });
    }
    return sources;
}

type Anchor = { top: number; left: number };

function RailTooltip({ label, anchor }: { label: string; anchor: Anchor }) {
    if (anchor == null) {
        return null;
    }
    return (
        <div
            className="pointer-events-none fixed z-[9500] -translate-y-1/2 rounded border border-border bg-modalbg px-2 py-1 text-xs whitespace-nowrap text-primary shadow-lg"
            style={{ top: anchor.top, left: anchor.left }}
        >
            {label}
        </div>
    );
}

function WorkspaceEditPanel({
    entry,
    anchor,
    onClose,
}: {
    entry: WorkspaceRailEntry;
    anchor: Anchor;
    onClose: () => void;
}) {
    const panelRef = useRef<HTMLDivElement>(null);
    const [draft, setDraft] = useState({ name: entry.name, icon: entry.icon, color: entry.color });
    useEffect(() => {
        const onPointerDown = (e: PointerEvent) => {
            if (!panelRef.current?.contains(e.target as Node)) {
                onClose();
            }
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                onClose();
            }
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("keydown", onKeyDown, true);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown, true);
            document.removeEventListener("keydown", onKeyDown, true);
        };
    }, [onClose]);
    const update = (next: typeof draft) => {
        setDraft(next);
        if (next.name === "") {
            return;
        }
        fireAndForget(() => WorkspaceService.UpdateWorkspace(entry.id, next.name, next.icon, next.color, false));
    };
    return (
        <div
            ref={panelRef}
            className="workspace-switcher-content fixed z-[9500] w-[280px] rounded border border-border bg-modalbg p-2 shadow-lg"
            style={{ top: anchor.top, left: anchor.left }}
        >
            <WorkspaceEditor
                title={draft.name}
                icon={draft.icon}
                color={draft.color}
                focusInput={true}
                onTitleChange={(name) => update({ ...draft, name })}
                onColorChange={(color) => update({ ...draft, color })}
                onIconChange={(icon) => update({ ...draft, icon })}
                onDeleteWorkspace={() => {
                    onClose();
                    getApi().deleteWorkspace(entry.id);
                }}
            />
        </div>
    );
}

function RailButton({
    entry,
    unread,
    onHover,
    onEdit,
}: {
    entry: WorkspaceRailEntry;
    unread: number;
    onHover: (label: string, anchor: Anchor) => void;
    onEdit: (entry: WorkspaceRailEntry, anchor: Anchor) => void;
}) {
    const ref = useRef<HTMLButtonElement>(null);
    const anchorOf = (): Anchor => {
        const rect = ref.current.getBoundingClientRect();
        return { top: rect.top + rect.height / 2, left: rect.right + 8 };
    };
    const onClick = () => {
        if (!entry.saved && entry.active) {
            // Saving gives the workspace a default name and icon; the user then names it in the editor.
            fireAndForget(async () => {
                await WorkspaceService.UpdateWorkspace(entry.id, "", "", "", true);
                const ws = await WorkspaceService.GetWorkspace(entry.id);
                onEdit({ ...entry, name: ws.name, icon: ws.icon, color: ws.color, saved: true }, anchorOf());
            });
            return;
        }
        if (!entry.active) {
            getApi().switchWorkspace(entry.id);
        }
    };
    const onContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        if (!entry.saved) {
            return;
        }
        ContextMenuModel.getInstance().showContextMenu(
            [
                { label: "Edit workspace…", click: () => onEdit(entry, anchorOf()) },
                { type: "separator" },
                { label: "Delete workspace", click: () => getApi().deleteWorkspace(entry.id) },
            ],
            e
        );
    };
    return (
        <button
            ref={ref}
            type="button"
            aria-label={entry.name}
            aria-current={entry.active ? "true" : undefined}
            data-workspace-id={entry.id}
            onClick={onClick}
            onContextMenu={onContextMenu}
            onMouseEnter={() =>
                onHover(
                    (entry.saved ? entry.name : "Unsaved workspace: click to save it") +
                        (unread > 0 ? ` · ${unread} unread` : ""),
                    anchorOf()
                )
            }
            onMouseLeave={() => onHover(null, null)}
            className={cn(
                "molten-rail-item relative flex h-9 w-9 cursor-pointer items-center justify-center rounded text-[17px] transition-colors hover:bg-hover",
                entry.active && "bg-hover",
                !entry.active && entry.open && "outline outline-1 -outline-offset-1 outline-border"
            )}
        >
            {entry.active ? (
                <span className="absolute top-1.5 bottom-1.5 -left-1.5 w-[2px] rounded bg-accent" aria-hidden />
            ) : null}
            {entry.saved ? (
                <i className={makeIconClass(entry.icon, false)} style={{ color: entry.color }} />
            ) : (
                <i className="fa fa-solid fa-floppy-disk text-secondary" />
            )}
            {unread > 0 ? (
                <span
                    className="molten-rail-dot absolute top-1 right-1 h-2 w-2 rounded-full bg-orange-500 ring-2 ring-[var(--color-background)]"
                    aria-label={`${unread} unread`}
                />
            ) : null}
        </button>
    );
}

export function WorkspaceRail() {
    const active = useAtomValue(atoms.workspace);
    const [sources, setSources] = useState<WorkspaceRailSource[]>([]);
    const [tooltip, setTooltip] = useState<{ label: string; anchor: Anchor }>(null);
    const [editing, setEditing] = useState<{ entry: WorkspaceRailEntry; anchor: Anchor }>(null);

    const refresh = useCallback(() => {
        fireAndForget(async () => setSources(await loadWorkspaceSources()));
    }, []);
    useEffect(() => {
        refresh();
        return waveEventSubscribeSingle({ eventType: "workspace:update", handler: refresh });
    }, [refresh]);
    useEffect(refresh, [active?.oid, active?.name, active?.icon, active?.color, refresh]);

    const entries = makeWorkspaceRailEntries(sources, active);
    const notifications = useAtomValue(MoltentermNotifications.getInstance().entriesAtom);
    const unread = unreadByWorkspace(notifications);
    const closeEditor = useCallback(() => setEditing(null), []);
    return (
        <nav
            aria-label="Workspaces"
            className="molten-workspace-rail flex h-full w-12 shrink-0 flex-col items-center gap-1 border-r border-border py-2"
        >
            {entries.map((entry) => (
                <RailButton
                    key={entry.id}
                    entry={entry}
                    unread={unread.get(entry.id) ?? 0}
                    onHover={(label, anchor) => setTooltip(label == null ? null : { label, anchor })}
                    onEdit={(e, anchor) => {
                        setTooltip(null);
                        setEditing({ entry: e, anchor });
                    }}
                />
            ))}
            <button
                type="button"
                aria-label="Create workspace"
                className="mt-1 flex h-9 w-9 cursor-pointer items-center justify-center rounded text-secondary transition-colors hover:bg-hover hover:text-primary"
                onClick={() => getApi().createWorkspace()}
                onMouseEnter={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setTooltip({
                        label: "Create workspace",
                        anchor: { top: rect.top + rect.height / 2, left: rect.right + 8 },
                    });
                }}
                onMouseLeave={() => setTooltip(null)}
            >
                <i className="fa fa-solid fa-plus" />
            </button>
            <RailTooltip label={tooltip?.label} anchor={tooltip?.anchor} />
            {editing ? (
                <WorkspaceEditPanel entry={editing.entry} anchor={editing.anchor} onClose={closeEditor} />
            ) : null}
        </nav>
    );
}
