// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The workspace rail (FR-SHELL-001, DS-SHELL-002): every workspace at a glance on the left, one click to switch, as
// in Notulia. It replaces the switcher of the tab bar and reuses Wave's workspace calls; a workspace is edited in
// MoltenTerm's sheet (FR-SHELL-030), from its context menu, its pencil or a double-click. The user orders it by drag
// and drop, Move up / Move down and Alt+Shift+Up/Down (FR-MC-031); wavesrv keeps the order and sorts Wave's list by it.
// Workspaces whose projects form a product (FR-MC-027) are drawn under one collapsible product entry (rail-product.tsx).

import { ContextMenuModel } from "@/app/store/contextmenu";
import { atoms, getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { WorkspaceService } from "@/app/store/services";
import { getWaveObjectAtom, makeORef, useWaveObjectValue } from "@/app/store/wos";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentRailDot } from "./agent-state-ui";
import { unreadByWorkspace } from "./notifications-model";
import { MoltentermNotifications } from "./notifications-store";
import { ProjectLinkDetector } from "./project-link-modal";
import { openProjectTab, ProjectTabKeeper } from "./project/project-tab";
import {
    applyGroupedMove,
    makeRailUnits,
    memberMoves,
    memberOfWorkspace,
    memberStateText,
    productKeysOf,
    RailProductUnit,
    RailUnit,
    unitMoves,
    unitSlotMove,
} from "./rail-groups";
import { setProductCollapsed, useCollapsedProducts, useRailGroups, useWorkspaceLinksKey } from "./rail-groups-store";
import { RailProduct, WorstDot } from "./rail-product";
import { RailTools } from "./rail-tools";
import { PaneFocusKeeper } from "./sessions/pane-focus";
import { handOverWorkspaceEdit, openWorkspaceEditor, recordSwitchClick, takeSwitchClick } from "./workspace-edit";
import { WorkspaceEditHost } from "./workspace-edit-sheet";
import { RailBadgeClass, WorkspaceIcon } from "./workspace-icon";
import { workspaceIconSource } from "./workspace-icon-model";
import { moveWorkspace, RailMove, slotMove, sortByOrder } from "./workspace-order";
import { readWorkspaceProject } from "./workspace-project";
import { RailDragScope, useRailDrag } from "./workspace-rail-dnd";
import { railMoveKey } from "./workspace-rail-drag";
import { RailEditButton } from "./workspace-rail-edit";
import { makeWorkspaceRailEntries, WorkspaceRailEntry, WorkspaceRailSource } from "./workspace-rail-model";
import { askResetWorkspace, WorkspaceResetHost } from "./workspace-reset";
import { canCloseWorkspace, LastWorkspaceReason } from "./workspace-reset-model";
import { WorktreeCloseHost } from "./worktree-close";

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
            className="pointer-events-none fixed z-[9500] -translate-y-1/2 rounded border border-border bg-modalbg px-2 py-1 text-xs whitespace-pre text-primary shadow-lg"
            style={{ top: anchor.top, left: anchor.left }}
        >
            {label}
        </div>
    );
}

type RailItemMoves = {
    up: RailMove;
    down: RailMove;
    // How far a drag draws the item from its place; null when it is not dragged.
    dragOffsetY: number;
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => void;
    // True for the click that ends a drag of this item.
    takeSuppressedClick: () => boolean;
    onMove: (move: RailMove, refocus: boolean) => void;
};

// A workspace drawn inside a product (FR-MC-027-AC5): its own badge and state, a smaller box, arrows walking the product.
type RailMemberInfo = {
    worst: string;
    stateText: string;
    // True when it moved the focus.
    onArrow: (direction: -1 | 1) => boolean;
};

function RailButton({
    entry,
    closable,
    unread,
    onHover,
    moves,
    unitId,
    member,
}: {
    entry: WorkspaceRailEntry;
    // Deleting it lands the user on another workspace (#222); otherwise it is reset instead.
    closable: boolean;
    unread: number;
    onHover: (label: string, anchor: Anchor) => void;
    moves: RailItemMoves;
    // Set when the item is a rail unit of its own, the box a drag drops around.
    unitId?: string;
    member?: RailMemberInfo;
}) {
    const ref = useRef<HTMLButtonElement>(null);
    // Read live: the icon can change from the editor or from molten while the rail's list is not refreshed.
    const [workspace] = useWaveObjectValue<Workspace>(makeORef("workspace", entry.id));
    const projectDir = readWorkspaceProject(workspace).dir;
    const iconSource =
        workspace != null
            ? workspaceIconSource(workspace)
            : { icon: entry.icon, color: entry.color, image: "", logo: "" };
    const anchorOf = (): Anchor => {
        const rect = ref.current.getBoundingClientRect();
        return { top: rect.top + rect.height / 2, left: rect.right + 8 };
    };
    const edit = (opener: HTMLElement) => {
        onHover(null, null);
        openWorkspaceEditor(entry.id, opener);
    };
    const onClick = (e: React.MouseEvent) => {
        if (moves.takeSuppressedClick()) {
            return;
        }
        if (!entry.saved && entry.active) {
            // Saving gives the workspace a default name and icon; the user then names it in the sheet.
            edit(ref.current);
            return;
        }
        if (!entry.active) {
            recordSwitchClick(entry.id);
            getApi().switchWorkspace(entry.id);
            return;
        }
        // A double-click, or the second click of one that started on this item in the tab view the window just left.
        if (e.detail >= 2 || takeSwitchClick(entry.id)) {
            edit(ref.current);
        }
    };
    const onDoubleClick = () => {
        // The first click is already switching the window to that workspace's tab view: that one opens the sheet.
        if (entry.saved && !entry.active) {
            handOverWorkspaceEdit(entry.id);
        }
    };
    const onContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        if (!entry.saved) {
            return;
        }
        // The Project tab of the workspace this window shows, made again if the user closed it (FR-SHELL-015).
        const projectTab: ContextMenuItem[] =
            entry.active && projectDir
                ? [{ label: "Open the Project tab", click: () => fireAndForget(openProjectTab) }]
                : [];
        ContextMenuModel.getInstance().showContextMenu(
            [
                ...projectTab,
                { label: "Edit workspace…", click: () => edit(ref.current) },
                { type: "separator" },
                { label: "Move up", enabled: moves.up != null, click: () => moves.onMove(moves.up, false) },
                { label: "Move down", enabled: moves.down != null, click: () => moves.onMove(moves.down, false) },
                { type: "separator" },
                ...(closable ? [] : [{ label: "Reset workspace…", click: () => askResetWorkspace(entry.id) }]),
                {
                    label: "Delete workspace",
                    enabled: closable,
                    sublabel: closable ? undefined : LastWorkspaceReason,
                    click: () => getApi().deleteWorkspace(entry.id),
                },
            ],
            e
        );
    };
    const onKeyDown = (e: React.KeyboardEvent) => {
        const plainArrow = !e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey;
        if (member != null && plainArrow && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
            if (member.onArrow(e.key === "ArrowUp" ? -1 : 1)) {
                e.preventDefault();
            }
            return;
        }
        const direction = railMoveKey(e);
        if (direction == null || !entry.saved) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        const move = direction < 0 ? moves.up : moves.down;
        if (move != null) {
            moves.onMove(move, true);
        }
    };
    const dragging = moves.dragOffsetY != null;
    return (
        <div
            data-rail-unit={unitId}
            className={cn("group relative shrink-0", dragging && "molten-rail-dragging z-10")}
            style={dragging ? { transform: `translateY(${moves.dragOffsetY}px)` } : undefined}
        >
            <button
                ref={ref}
                type="button"
                aria-label={member?.worst ? `${entry.name}, ${member.stateText}` : entry.name}
                aria-current={entry.active ? "true" : undefined}
                data-workspace-id={entry.id}
                onClick={onClick}
                onDoubleClick={onDoubleClick}
                onContextMenu={onContextMenu}
                onKeyDown={onKeyDown}
                onPointerDown={moves.onPointerDown}
                onMouseEnter={() =>
                    onHover(
                        (entry.saved ? entry.name : "Unsaved workspace: click to save it") +
                            (member != null ? ` · ${member.stateText}` : "") +
                            (unread > 0 ? ` · ${unread} unread` : ""),
                        anchorOf()
                    )
                }
                onMouseLeave={() => onHover(null, null)}
                className={cn(
                    "molten-rail-item cursor-pointer transition-colors hover:bg-hover",
                    RailBadgeClass,
                    member != null && "h-8 w-8 text-[15px]",
                    entry.active && "bg-hover",
                    !entry.active && entry.open && "outline outline-1 -outline-offset-1 outline-border"
                )}
            >
                {entry.active ? (
                    <span className="absolute top-1.5 bottom-1.5 -left-1.5 w-[2px] rounded bg-accent" aria-hidden />
                ) : null}
                {entry.saved ? (
                    <WorkspaceIcon source={iconSource} />
                ) : (
                    <i className="fa fa-solid fa-floppy-disk text-secondary" />
                )}
                {unread > 0 ? (
                    <span
                        className="molten-rail-dot absolute top-1 right-1 h-2 w-2 rounded-full bg-primary ring-2 ring-[var(--color-background)]"
                        aria-label={`${unread} unread`}
                    />
                ) : null}
                {member != null ? <WorstDot worst={member.worst} /> : null}
                <AgentRailDot workspaceId={entry.id} />
            </button>
            {entry.saved ? (
                <RailEditButton
                    name={entry.name}
                    onEdit={(opener) => edit(opener)}
                    onHover={(opener) => {
                        const rect = opener.getBoundingClientRect();
                        onHover(`Edit ${entry.name}`, { top: rect.top + rect.height / 2, left: rect.right + 8 });
                    }}
                    onLeave={() => onHover(null, null)}
                />
            ) : null}
        </div>
    );
}

export function WorkspaceRail() {
    const active = useAtomValue(atoms.workspace);
    const [sources, setSources] = useState<WorkspaceRailSource[]>([]);
    const [tooltip, setTooltip] = useState<{ label: string; anchor: Anchor }>(null);

    const refresh = useCallback(() => {
        fireAndForget(async () => setSources(await loadWorkspaceSources()));
    }, []);
    useEffect(() => {
        refresh();
        return waveEventSubscribeSingle({ eventType: "workspace:update", handler: refresh });
    }, [refresh]);
    useEffect(refresh, [active?.oid, active?.name, active?.icon, active?.color, refresh]);

    const entries = makeWorkspaceRailEntries(sources, active);
    const navRef = useRef<HTMLElement>(null);
    const movableKey = entries
        .filter((e) => e.saved)
        .map((e) => e.id)
        .join(" ");
    const movableIds = useMemo(() => (movableKey ? movableKey.split(" ") : []), [movableKey]);
    // The product groups (FR-MC-027), asked again when the rail's workspaces, their order or their links change.
    const linksKey = useWorkspaceLinksKey(movableIds);
    const groups = useRailGroups(linksKey);
    const collapsed = useCollapsedProducts();
    const units = makeRailUnits(entries, groups);
    const productKeys = useMemo(() => productKeysOf(groups), [groups]);
    // The rail shows the move at once; the server's workspace:update confirms it, or the refresh undoes it.
    const applyMove = useCallback(
        (move: RailMove, refocus: boolean) => {
            const order = applyGroupedMove(movableIds, productKeys, move);
            setSources((prev) => sortByOrder(prev, (s) => s.workspace?.oid, order));
            if (refocus) {
                const selector = move.block
                    ? `button[data-rail-product="${CSS.escape(productKeys.get(move.workspaceid) ?? "")}"]`
                    : `button[data-workspace-id="${CSS.escape(move.workspaceid)}"]`;
                requestAnimationFrame(() => {
                    navRef.current?.querySelector<HTMLElement>(selector)?.focus();
                });
            }
            fireAndForget(async () => {
                try {
                    await moveWorkspace(move);
                } catch (err) {
                    console.log("moving workspace in the rail:", err);
                    refresh();
                }
            });
        },
        [movableIds, productKeys, refresh]
    );
    // A rail unit drops among the units; a product's workspace among its siblings, while the product is expanded.
    const scopeOf = (id: string): RailDragScope => {
        const movableUnits = units.filter((u) => u.kind === "product" || u.entry.saved);
        if (movableUnits.some((u) => u.id === id)) {
            return {
                ids: movableUnits.map((u) => u.id),
                element: (nav, unitId) => nav.querySelector<HTMLElement>(`[data-rail-unit="${CSS.escape(unitId)}"]`),
                moveFor: (slot) => unitSlotMove(units, id, slot),
                bounded: false,
            };
        }
        const product = units.find(
            (u): u is RailProductUnit => u.kind === "product" && u.entries.some((e) => e.id === id)
        );
        if (product == null || collapsed.has(product.key)) {
            return null;
        }
        const ids = product.entries.map((e) => e.id);
        return {
            ids,
            element: (nav, wsId) => nav.querySelector<HTMLElement>(`button[data-workspace-id="${CSS.escape(wsId)}"]`),
            moveFor: (slot) => slotMove(ids, id, slot),
            bounded: true,
        };
    };
    const drag = useRailDrag(navRef, scopeOf, (move) => applyMove(move, false));
    useEffect(() => {
        if (drag.view != null) {
            setTooltip(null);
        }
    }, [drag.view]);
    const notifications = useAtomValue(MoltentermNotifications.getInstance().entriesAtom);
    const unread = unreadByWorkspace(notifications);
    const onHover = (label: string, anchor: Anchor) =>
        setTooltip(label == null || drag.view != null ? null : { label, anchor });
    const itemMoves = (id: string, moves: { up: RailMove; down: RailMove }): RailItemMoves => ({
        up: moves.up,
        down: moves.down,
        dragOffsetY: drag.view?.id === id ? drag.view.offsetY : null,
        onPointerDown: (e) => drag.onPointerDown(e, id),
        takeSuppressedClick: () => drag.takeSuppressedClick(id),
        onMove: applyMove,
    });
    const focusIn = (selector: string): boolean => {
        const target = selector ? navRef.current?.querySelector<HTMLElement>(selector) : null;
        if (target == null) {
            return false;
        }
        target.focus();
        return true;
    };
    const renderUnit = (unit: RailUnit) => {
        if (unit.kind === "workspace") {
            const entry = unit.entry;
            return (
                <RailButton
                    key={unit.id}
                    entry={entry}
                    unitId={entry.saved ? unit.id : undefined}
                    closable={canCloseWorkspace(entries, entry.id)}
                    unread={unread.get(entry.id) ?? 0}
                    onHover={onHover}
                    moves={itemMoves(entry.id, entry.saved ? unitMoves(units, unit.id) : { up: null, down: null })}
                />
            );
        }
        const isCollapsed = collapsed.has(unit.key);
        const ids = unit.entries.map((e) => e.id);
        return (
            <RailProduct
                key={unit.id}
                unit={unit}
                collapsed={isCollapsed}
                unread={ids.reduce((sum, id) => sum + (unread.get(id) ?? 0), 0)}
                moves={unitMoves(units, unit.id)}
                dragOffsetY={drag.view?.id === unit.id ? drag.view.offsetY : null}
                onToggle={() => setProductCollapsed(unit.key, !isCollapsed)}
                onHover={onHover}
                onMove={applyMove}
                onPointerDown={(e) => drag.onPointerDown(e, unit.id)}
                takeSuppressedClick={() => drag.takeSuppressedClick(unit.id)}
            >
                {unit.entries.map((entry, index) => {
                    const state = memberOfWorkspace(unit.group, entry.id)?.state;
                    return (
                        <RailButton
                            key={entry.id}
                            entry={entry}
                            closable={canCloseWorkspace(entries, entry.id)}
                            unread={unread.get(entry.id) ?? 0}
                            onHover={onHover}
                            moves={itemMoves(entry.id, memberMoves(unit, entry.id))}
                            member={{
                                worst: state?.worst ?? "",
                                stateText: memberStateText(state),
                                onArrow: (direction) => {
                                    const next = ids[index + direction];
                                    return focusIn(
                                        next != null
                                            ? `button[data-workspace-id="${CSS.escape(next)}"]`
                                            : direction < 0
                                              ? `button[data-rail-product="${CSS.escape(unit.key)}"]`
                                              : null
                                    );
                                },
                            }}
                        />
                    );
                })}
            </RailProduct>
        );
    };
    const memberDragged =
        drag.view != null && productKeys.has(drag.view.id) && !units.some((u) => u.id === drag.view.id);
    return (
        <nav
            ref={navRef}
            aria-label="Workspaces"
            className="molten-workspace-rail relative flex h-full w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border py-2"
        >
            {units.map(renderUnit)}
            {drag.view?.lineY != null ? (
                <span
                    className={cn(
                        "molten-rail-drop-line pointer-events-none absolute right-1 z-20 h-[2px] -translate-y-1/2 rounded bg-accent",
                        memberDragged ? "left-3" : "left-1"
                    )}
                    style={{ top: drag.view.lineY }}
                    aria-hidden
                />
            ) : null}
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
            <RailTools onHover={(label, anchor) => setTooltip(label == null ? null : { label, anchor })} />
            <RailTooltip label={tooltip?.label} anchor={tooltip?.anchor} />
            <ProjectLinkDetector />
            <ProjectTabKeeper />
            <PaneFocusKeeper />
            <WorktreeCloseHost />
            <WorkspaceResetHost />
            <WorkspaceEditHost entries={entries} />
        </nav>
    );
}
