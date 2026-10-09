// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The workspace rail (FR-SHELL-001, DS-SHELL-002): every workspace at a glance on the left, one click to switch, as
// in Notulia. It replaces the switcher of the tab bar and reuses Wave's workspace calls; a workspace is edited in
// MoltenTerm's sheet (FR-SHELL-030), from its context menu, its pencil or a double-click. The user orders it by drag
// and drop from anywhere on an item, as tabs, and Alt+Shift+Up/Down (FR-MC-031, #365); wavesrv keeps the order and
// sorts Wave's list by it.
// Workspaces whose projects form a product (FR-MC-027) are drawn under one collapsible product entry (rail-product.tsx).
// The user groups any saved workspaces from an item's link bud, its menu or `molten rail group` (FR-MC-032): a local
// group is drawn as a product too; connect mode (rail-connect.ts) makes the dragged workspaces join it.

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
import { coffeeCondition, coffeeSupported, coffeeTooltip, railCoffeeLabel } from "./keepawake-model";
import { KeepAwakeModel } from "./keepawake-store";
import { RailCoffeeDrop, usePlatform } from "./keepawake-ui";
import { unreadByWorkspace } from "./notifications-model";
import { MoltentermNotifications } from "./notifications-store";
import { ProjectLinkDetector } from "./project-link-modal";
import { openProjectTab, ProjectTabKeeper } from "./project/project-tab";
import { installConnectExits, RailConnectModel, RailConnectTarget, sameConnectTarget } from "./rail-connect";
import { RailConnectPopover } from "./rail-connect-ui";
import {
    applyGroupedMove,
    leaveSlotMove,
    makeRailUnits,
    memberMoves,
    memberStateText,
    productKeysOf,
    ProductUnitPrefix,
    RailProductUnit,
    RailUnit,
    railUnitKeys,
    unitMoves,
    unitSlotMove,
    workspaceMemberState,
} from "./rail-groups";
import { useRailGroups, useStoredLocalGroups, useWorkspaceLinksKey } from "./rail-groups-store";
import {
    cleanGroupName,
    effectiveLocalGroups,
    GroupWithChoice,
    groupWithChoices,
    joinRailGroup,
    leaveRailGroup,
    localGroupOf,
    MaxGroupNameLength,
    projectGroupRefusal,
    renameRailGroup,
    ungroupRailGroup,
} from "./rail-local-groups";
import { RailConnectState, RailDropToGroup, RailProduct, WorstDot } from "./rail-product";
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
import {
    budTooltipAnchor,
    RailBudChain,
    RailBudFilter,
    RailBudPitchPx,
    RailBudSpec,
    railEditLabel,
    railLinkLabel,
} from "./workspace-rail-edit";
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

// The first bud's target spans 24 px right of the item's edge, each later one 28 px more.
const RailBudTooltipOffsetPx = 30;

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

// What a saved workspace outside any project product offers for local groups (FR-MC-032): the link bud, connect mode's
// state, Group with ▸ and Remove from group.
type RailItemGrouping = {
    onLink: () => void;
    linkPressed: boolean;
    connect: RailConnectState;
    // Read when the menu opens: the rail renders on every drag frame.
    groupWith: () => GroupWithChoice[];
    onGroupWith: (choice: GroupWithChoice) => void;
    // Set for a member of a local group.
    onRemoveFromGroup?: () => void;
};

// A workspace drawn inside a product (FR-MC-027-AC5): its own badge and state, arrows walking the product. Until #365 its
// box kept the full size, since the pencil's 24 px target would have covered most of a smaller one; with the buds out
// beside the icon, it is drawn at 32 px (#368, revision of FR-MC-027), the product entry staying at 36 px.
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
    grouping,
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
    grouping?: RailItemGrouping;
}) {
    const ref = useRef<HTMLButtonElement>(null);
    // Read live: the icon can change from the editor or from molten while the rail's list is not refreshed.
    const [workspace] = useWaveObjectValue<Workspace>(makeORef("workspace", entry.id));
    const coffee = useAtomValue(KeepAwakeModel.getInstance().coffeeAtom(entry.id));
    const platform = usePlatform();
    const projectDir = readWorkspaceProject(workspace).dir;
    const iconSource =
        workspace != null
            ? workspaceIconSource(workspace)
            : { icon: entry.icon, color: entry.color, image: "", logo: "" };
    const anchorOf = (): Anchor => {
        const rect = ref.current.getBoundingClientRect();
        // Past the buds, which bud out right of a saved item (DS-SHELL-061, DS-MC-029).
        const offset = entry.saved ? RailBudTooltipOffsetPx + Math.max(0, buds.length - 1) * RailBudPitchPx : 8;
        return { top: rect.top + rect.height / 2, left: rect.right + offset };
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
        const groupItems: ContextMenuItem[] = [];
        const choices = grouping?.groupWith() ?? [];
        if (choices.length > 0) {
            groupItems.push({
                label: "Group with",
                icon: "layer-group",
                type: "submenu",
                submenu: choices.map((choice) => ({
                    label: choice.label,
                    click: () => grouping.onGroupWith(choice),
                })),
            });
        }
        if (grouping?.onRemoveFromGroup != null) {
            groupItems.push({ label: "Remove from group", icon: "unlink", click: grouping.onRemoveFromGroup });
        }
        ContextMenuModel.getInstance().showContextMenu(
            [
                ...projectTab,
                { label: "Edit workspace…", icon: "pen", click: () => edit(ref.current) },
                ...(groupItems.length > 0 ? [{ type: "separator" } as ContextMenuItem, ...groupItems] : []),
                { type: "separator" },
                ...(closable
                    ? []
                    : [{ label: "Reset workspace…", icon: "rotate-left", click: () => askResetWorkspace(entry.id) }]),
                {
                    label: "Delete workspace",
                    icon: "trash",
                    destructive: true,
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
    const buds: RailBudSpec[] = [];
    if (entry.saved) {
        buds.push({ kind: "edit", label: railEditLabel(entry.name), onActivate: (opener) => edit(opener) });
    }
    if (entry.saved && grouping != null) {
        buds.push({
            kind: "link",
            label: railLinkLabel(entry.name),
            pressed: grouping.linkPressed,
            onActivate: () => {
                onHover(null, null);
                grouping.onLink();
            },
        });
    }
    // The coffee (FR-SHELL-023-AC8, DS-SHELL-062): the chain's last bud, on saved items, where MoltenTerm can keep the
    // computer awake.
    if (entry.saved && coffeeSupported(platform)) {
        buds.push({
            kind: "coffee",
            label: railCoffeeLabel(entry.name, coffee != null, platform),
            tooltip: coffee != null ? coffeeTooltip(coffee, entry.name, platform, Date.now()) : undefined,
            pressed: coffee != null,
            onActivate: () => {
                onHover(null, null);
                fireAndForget(async () => {
                    try {
                        await KeepAwakeModel.getInstance().setCoffee(entry.id, coffee == null);
                    } catch (err) {
                        console.log("keep-awake coffee:", err);
                    }
                });
            },
        });
    }
    const connect = grouping?.connect;
    const coffeeText = coffee != null ? ` · kept awake ${coffeeCondition(coffee, Date.now())}` : "";
    const stateText = (member?.stateText ? ` · ${member.stateText}` : "") + coffeeText;
    return (
        <div
            data-rail-unit={unitId}
            data-rail-member={member != null ? "" : undefined}
            data-rail-host={entry.id}
            data-buds-out={connect?.target ? "" : undefined}
            className={cn("molten-rail-budhost relative shrink-0", dragging && "molten-rail-dragging z-10")}
            style={dragging ? { transform: `translateY(${moves.dragOffsetY}px)` } : undefined}
        >
            <button
                ref={ref}
                type="button"
                aria-label={member?.worst && member.stateText ? `${entry.name}, ${member.stateText}` : entry.name}
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
                            stateText +
                            (unread > 0 ? ` · ${unread} unread` : ""),
                        anchorOf()
                    )
                }
                onMouseLeave={() => onHover(null, null)}
                className={cn(
                    "molten-rail-item molten-rail-anchor cursor-pointer transition-colors hover:bg-hover",
                    RailBadgeClass,
                    entry.active && "bg-hover",
                    !entry.active && entry.open && "outline outline-1 -outline-offset-1 outline-border",
                    connect?.target && "molten-rail-connect-target"
                )}
                data-connect-drop={connect?.dropping ? "" : undefined}
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
                {entry.saved ? <RailCoffeeDrop workspaceId={entry.id} /> : null}
                {connect?.dropping ? <RailDropToGroup /> : null}
            </button>
            <RailBudChain
                buds={buds}
                onHover={(label, opener) => onHover(label, budTooltipAnchor(opener))}
                onLeave={() => onHover(null, null)}
            />
        </div>
    );
}

export function WorkspaceRail() {
    const active = useAtomValue(atoms.workspace);
    const [sources, setSources] = useState<WorkspaceRailSource[]>([]);
    const [tooltip, setTooltip] = useState<{ label: string; anchor: Anchor }>(null);
    // The local group whose name is being edited (Rename group…).
    const [renaming, setRenaming] = useState<string>(null);

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
    // The one product whose column is out, like an open folder. Never remembered: an open column floats over the
    // content.
    const [openProduct, setOpenProduct] = useState<string>(null);
    const projectKeys = useMemo(() => productKeysOf(groups), [groups]);
    // The local groups (FR-MC-032), as the server would read them: a project product always wins.
    const storedLocal = useStoredLocalGroups();
    const localGroups = useMemo(
        () => effectiveLocalGroups(storedLocal, movableIds, projectKeys),
        [storedLocal, movableIds, projectKeys]
    );
    const units = makeRailUnits(entries, groups, localGroups);
    const productKeys = useMemo(() => railUnitKeys(groups, localGroups), [groups, localGroups]);
    const names = new Map(entries.map((e) => [e.id, e.name]));
    const nameOf = (id: string) => names.get(id);
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

    // Connect mode (FR-MC-032-AC2 to AC4): one target per window.
    const connectModel = RailConnectModel.getInstance();
    const connectTarget = useAtomValue(connectModel.targetAtom);
    useEffect(() => installConnectExits(connectModel), [connectModel]);
    useEffect(() => () => connectModel.end(), [connectModel]);
    // The target gone ends connect mode; a target workspace that just made a group goes on as that group, so several
    // workspaces can be added in a row.
    useEffect(() => {
        if (connectTarget == null) {
            return;
        }
        if (connectTarget.kind === "group") {
            if (!localGroups.some((g) => g.id === connectTarget.id)) {
                connectModel.end();
            }
            return;
        }
        if (!movableIds.includes(connectTarget.id) || projectKeys.has(connectTarget.id)) {
            connectModel.end();
            return;
        }
        const group = localGroupOf(localGroups, connectTarget.id);
        if (group != null) {
            globalStore.set(connectModel.targetAtom, { kind: "group", id: group.id });
        }
    }, [connectTarget, localGroups, movableIds, projectKeys, connectModel]);
    const tellFailure = (err: unknown, anchor: string) => {
        const text = (err as Error)?.message ?? String(err);
        connectModel.showMessage(text.replace(/^Error: /, ""), anchor);
    };
    const hostSelector = (id: string) => `[data-rail-host="${CSS.escape(id)}"]`;
    const runGroupCommand = (call: () => Promise<void>, anchor: string) => {
        fireAndForget(async () => {
            try {
                await call();
            } catch (err) {
                console.log("rail groups:", err);
                tellFailure(err, anchor);
            }
        });
    };
    const targetIdOf = (target: RailConnectTarget) => target.id;
    const isTarget = (target: RailConnectTarget) => sameConnectTarget(connectTarget, target);
    // The box a dragged workspace joins the target over, when it may (no product, not the target nor one of its
    // members, a saved workspace).
    const joinZone = (draggedId: string): HTMLElement => {
        const target = connectModel.getTarget();
        const nav = navRef.current;
        if (
            target == null ||
            nav == null ||
            draggedId.startsWith(ProductUnitPrefix) ||
            !movableIds.includes(draggedId)
        ) {
            return null;
        }
        if (target.kind === "workspace") {
            if (target.id === draggedId) {
                return null;
            }
            return nav.querySelector<HTMLElement>(`button[data-workspace-id="${CSS.escape(target.id)}"]`);
        }
        if (localGroups.find((g) => g.id === target.id)?.members.includes(draggedId)) {
            return null;
        }
        return nav.querySelector<HTMLElement>(`[data-rail-local="${CSS.escape(target.id)}"]`);
    };
    const onJoin = (draggedId: string) => {
        const target = connectModel.getTarget();
        if (target == null) {
            return;
        }
        const anchor =
            target.kind === "group" ? `[data-rail-local="${CSS.escape(target.id)}"]` : hostSelector(target.id);
        const productKey = projectKeys.get(draggedId);
        if (productKey != null) {
            const product = groups.find((g) => g.key === productKey)?.name || productKey;
            connectModel.showMessage(projectGroupRefusal(nameOf(draggedId) ?? draggedId, product), anchor);
            return;
        }
        runGroupCommand(() => joinRailGroup({ workspaceid: draggedId, targetid: targetIdOf(target) }), anchor);
    };

    // A rail unit drops among the units; a product's workspace among its siblings, while the product is expanded. A
    // local group's member past its group drops among the units, out of the group.
    const scopeOf = (id: string): RailDragScope => {
        const movableUnits = units.filter((u) => u.kind === "product" || u.entry.saved);
        const unitScope = (moveFor: (slot: number) => RailMove): RailDragScope => ({
            ids: movableUnits.map((u) => u.id),
            element: (nav, unitId) => nav.querySelector<HTMLElement>(`[data-rail-unit="${CSS.escape(unitId)}"]`),
            moveFor,
            bounded: false,
        });
        if (movableUnits.some((u) => u.id === id)) {
            return unitScope((slot) => unitSlotMove(units, id, slot));
        }
        const product = units.find(
            (u): u is RailProductUnit => u.kind === "product" && u.entries.some((e) => e.id === id)
        );
        if (product == null || openProduct !== product.key) {
            return null;
        }
        const ids = product.entries.map((e) => e.id);
        return {
            ids,
            element: (nav, wsId) => nav.querySelector<HTMLElement>(`button[data-workspace-id="${CSS.escape(wsId)}"]`),
            moveFor: (slot) => slotMove(ids, id, slot),
            bounded: true,
            outer: product.local != null ? unitScope((slot) => leaveSlotMove(units, product, id, slot)) : undefined,
        };
    };
    const drag = useRailDrag(
        navRef,
        scopeOf,
        (move) => applyMove(move, false),
        { zone: joinZone, onJoin },
        (dragging) => connectModel.setDragging(dragging)
    );
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
    const joining = drag.view?.joining ?? false;
    const connectState = (target: RailConnectTarget): RailConnectState => {
        const on = isTarget(target);
        return { target: on, dropping: on && joining };
    };
    // A saved workspace outside the project products: the link bud and the group menus (FR-MC-032-AC1, AC10).
    const itemGrouping = (entry: WorkspaceRailEntry): RailItemGrouping => {
        if (!entry.saved || projectKeys.has(entry.id)) {
            return undefined;
        }
        const own = localGroupOf(localGroups, entry.id);
        const target: RailConnectTarget =
            own != null ? { kind: "group", id: own.id } : { kind: "workspace", id: entry.id };
        const anchor = hostSelector(entry.id);
        return {
            onLink: () => connectModel.toggle(target),
            linkPressed: isTarget(target),
            connect: own != null ? { target: false, dropping: false } : connectState(target),
            groupWith: () => groupWithChoices(entry.id, movableIds, projectKeys, localGroups, nameOf),
            onGroupWith: (choice) =>
                runGroupCommand(() => joinRailGroup({ workspaceid: entry.id, targetid: choice.id }), anchor),
            onRemoveFromGroup:
                own != null
                    ? () => runGroupCommand(() => leaveRailGroup({ workspaceid: entry.id }), anchor)
                    : undefined,
        };
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
                    grouping={itemGrouping(entry)}
                />
            );
        }
        const isCollapsed = openProduct !== unit.key;
        const ids = unit.entries.map((e) => e.id);
        const local = unit.local;
        const localAnchor = local != null ? `[data-rail-local="${CSS.escape(local.id)}"]` : null;
        return (
            <RailProduct
                key={unit.id}
                unit={unit}
                collapsed={isCollapsed}
                unread={ids.reduce((sum, id) => sum + (unread.get(id) ?? 0), 0)}
                moves={unitMoves(units, unit.id)}
                dragOffsetY={drag.view?.id === unit.id ? drag.view.offsetY : null}
                onToggle={() => setOpenProduct(isCollapsed ? unit.key : null)}
                onHover={onHover}
                onMove={applyMove}
                onPointerDown={(e) => drag.onPointerDown(e, unit.id)}
                takeSuppressedClick={() => drag.takeSuppressedClick(unit.id)}
                projectGroups={groups}
                connect={local != null ? connectState({ kind: "group", id: local.id }) : undefined}
                local={
                    local == null
                        ? undefined
                        : {
                              onLink: () => connectModel.toggle({ kind: "group", id: local.id }),
                              renaming: renaming === local.id,
                              onRenameStart: () => setRenaming(local.id),
                              onRenameCancel: () => setRenaming(null),
                              onRename: (value) => {
                                  setRenaming(null);
                                  const name = cleanGroupName(value);
                                  if (name == null) {
                                      connectModel.showMessage(
                                          `A group name is at most ${MaxGroupNameLength} characters.`,
                                          localAnchor
                                      );
                                      return;
                                  }
                                  runGroupCommand(() => renameRailGroup(local.id, name), localAnchor);
                              },
                              onUngroup: () => runGroupCommand(() => ungroupRailGroup(local.id), localAnchor),
                          }
                }
            >
                {unit.entries.map((entry, index) => {
                    const state = workspaceMemberState(groups, entry.id);
                    return (
                        <RailButton
                            key={entry.id}
                            entry={entry}
                            closable={canCloseWorkspace(entries, entry.id)}
                            unread={unread.get(entry.id) ?? 0}
                            onHover={onHover}
                            moves={itemMoves(entry.id, memberMoves(unit, entry.id))}
                            grouping={local != null ? itemGrouping(entry) : undefined}
                            member={{
                                worst: state?.worst ?? "",
                                stateText: local != null && state == null ? "" : memberStateText(state),
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
    return (
        <nav
            ref={navRef}
            aria-label="Workspaces"
            className="molten-workspace-rail relative flex h-full w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border py-2"
        >
            {units.map(renderUnit)}
            {drag.view?.lineY != null ? (
                <span
                    className="molten-rail-drop-line pointer-events-none absolute right-1 left-1 z-20 h-[2px] -translate-y-1/2 rounded bg-accent"
                    style={{ top: drag.view.lineY }}
                    aria-hidden
                />
            ) : null}
            {drag.view?.memberLine != null ? (
                <span
                    className="molten-rail-drop-line pointer-events-none fixed z-[470] h-[2px] -translate-y-1/2 rounded bg-accent"
                    style={drag.view.memberLine}
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
            <RailConnectPopover navRef={navRef} revision={`${movableKey}|${localGroups.length}|${openProduct ?? ""}`} />
            <RailBudFilter />
            <ProjectLinkDetector />
            <ProjectTabKeeper />
            <PaneFocusKeeper />
            <WorktreeCloseHost />
            <WorkspaceResetHost />
            <WorkspaceEditHost entries={entries} />
        </nav>
    );
}
