// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The workspace rail (FR-SHELL-001, DS-SHELL-002): every workspace at a glance on the left, one click to switch, as
// in Notulia. It replaces the switcher of the tab bar and reuses Wave's workspace calls; a workspace is edited in
// MoltenTerm's sheet (FR-SHELL-030), from its hover tray's Edit (FR-SHELL-045, rail-tray.tsx), its menu or a
// double-click. The user orders it by drag and drop from anywhere on an item, as tabs, and Alt+Shift+Up/Down
// (FR-MC-031, #365); wavesrv keeps the order and sorts Wave's list by it.
// Workspaces whose projects form a product (FR-MC-027) are drawn under one collapsible product entry (rail-product.tsx).
// The user groups any saved workspaces from More › Group with…, or `molten rail group` (FR-MC-032): a local group is
// drawn as a product too; in connect mode (rail-connect.ts) a click on a workspace, or a drag onto the target, joins it.

import { atoms, getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { WorkspaceService } from "@/app/store/services";
import { getWaveObjectAtom, makeORef, useWaveObjectValue } from "@/app/store/wos";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agentStateTitle } from "./agent-state-model";
import { AgentStates } from "./agent-state-store";
import { AgentRailDot } from "./agent-state-ui";
import { coffeeCondition, coffeeSupported, coffeeTooltip, computerName, railCoffeeLabel } from "./keepawake-model";
import { KeepAwakeModel } from "./keepawake-store";
import { RailCoffeeDrop, usePlatform } from "./keepawake-ui";
import { unreadByWorkspace } from "./notifications-model";
import { MoltentermNotifications } from "./notifications-store";
import { ProjectLinkDetector } from "./project-link-modal";
import { openProjectTab, ProjectTabKeeper } from "./project/project-tab";
import { installConnectExits, RailConnectModel, RailConnectTarget, sameConnectTarget } from "./rail-connect";
import { RailConnectBanner } from "./rail-connect-ui";
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
    joinRailGroup,
    leaveRailGroup,
    localGroupName,
    localGroupOf,
    MaxGroupNameLength,
    projectGroupRefusal,
    renameRailGroup,
    ungroupRailGroup,
} from "./rail-local-groups";
import { RailConnectState, RailDropToGroup, RailProduct, WorstDot } from "./rail-product";
import { RailTools } from "./rail-tools";
import { installRailTrayExits, RailTray, RailTrayPrimary, showRailMenu, useRailTrayHost } from "./rail-tray";
import {
    railEditLabel,
    railMoreLabel,
    railNavIndex,
    railTabStop,
    RailTrayModel,
    railWorkspaceMenu,
} from "./rail-tray-model";
import { PaneFocusKeeper } from "./sessions/pane-focus";
import { handOverWorkspaceEdit, openWorkspaceEditor, recordSwitchClick, takeSwitchClick } from "./workspace-edit";
import { WorkspaceEditHost } from "./workspace-edit-sheet";
import { RailBadgeClass, WorkspaceIcon } from "./workspace-icon";
import { workspaceIconSource } from "./workspace-icon-model";
import { moveWorkspace, RailMove, slotMove, sortByOrder } from "./workspace-order";
import { readWorkspaceProject } from "./workspace-project";
import { RailDragScope, useRailDrag } from "./workspace-rail-dnd";
import { railMoveKey } from "./workspace-rail-drag";
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
            className="pointer-events-none fixed z-[9500] -translate-y-1/2 rounded-10 border border-border bg-surface-3 px-2 py-1 text-12 whitespace-pre text-primary shadow-e2"
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
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
    // True for the click that ends a drag of this item.
    takeSuppressedClick: () => boolean;
    onMove: (move: RailMove, refocus: boolean) => void;
};

// What a saved workspace outside any project product offers for local groups (FR-MC-032): Group with… and connect
// mode's state, and Remove from group.
type RailItemGrouping = {
    // Starts connect mode on the workspace, or on its local group; a second time ends it.
    onGroupWith: () => void;
    connecting: boolean;
    connect: RailConnectState;
    // Set for a member of a local group.
    onRemoveFromGroup?: () => void;
};

// A workspace drawn inside an expanded group (FR-MC-027-AC5, DS-SHELL-082): its own badge, state and tray, at 32 px.
type RailMemberInfo = {
    worst: string;
    stateText: string;
};

// The rail's roving tab stop (DS-SHELL-081): one item is in the tab order, the arrows move between them.
export type RailNavProps = { key: string; tabIndex: number; onFocused: () => void };

// The rail item's box, and a group member's (DS-SHELL-082).
const RailItemPx = 36;
const RailMemberPx = 32;

function RailButton({
    entry,
    closable,
    unread,
    onHover,
    moves,
    unitId,
    member,
    grouping,
    nav,
    connectClick,
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
    nav: RailNavProps;
    // In connect mode, a click on a workspace groups it with the target; true when the click was taken.
    connectClick: (workspaceId: string) => boolean;
}) {
    const ref = useRef<HTMLButtonElement>(null);
    // Read live: the icon can change from the editor or from molten while the rail's list is not refreshed.
    const [workspace] = useWaveObjectValue<Workspace>(makeORef("workspace", entry.id));
    const coffee = useAtomValue(KeepAwakeModel.getInstance().coffeeAtom(entry.id));
    const agent = useAtomValue(AgentStates.getInstance().workspaceAtom(entry.id));
    const { isOpen, hostProps } = useRailTrayHost(entry.id, entry.saved);
    const platform = usePlatform();
    const projectDir = readWorkspaceProject(workspace).dir;
    const iconSource =
        workspace != null
            ? workspaceIconSource(workspace)
            : { icon: entry.icon, color: entry.color, image: "", logo: "" };
    // The item itself is the opener: the tray's buttons are hidden once the sheet is open.
    const edit = () => {
        onHover(null, null);
        RailTrayModel.getInstance().closeAll();
        openWorkspaceEditor(entry.id, ref.current);
    };
    const setCoffee = (on: boolean) => {
        onHover(null, null);
        fireAndForget(async () => {
            try {
                await KeepAwakeModel.getInstance().setCoffee(entry.id, on);
            } catch (err) {
                console.log("keep-awake coffee:", err);
            }
        });
    };
    const onClick = (e: React.MouseEvent) => {
        if (moves.takeSuppressedClick()) {
            return;
        }
        if (connectClick(entry.id)) {
            return;
        }
        if (!entry.saved && entry.active) {
            // Saving gives the workspace a default name and icon; the user then names it in the sheet.
            edit();
            return;
        }
        if (!entry.active) {
            recordSwitchClick(entry.id);
            getApi().switchWorkspace(entry.id);
            return;
        }
        // A double-click, or the second click of one that started on this item in the tab view the window just left.
        if (e.detail >= 2 || takeSwitchClick(entry.id)) {
            edit();
        }
    };
    const onDoubleClick = () => {
        // The first click is already switching the window to that workspace's tab view: that one opens the sheet.
        if (entry.saved && !entry.active) {
            handOverWorkspaceEdit(entry.id);
        }
    };
    const menuItems = (): ContextMenuItem[] =>
        railWorkspaceMenu({
            onEdit: edit,
            coffee: coffeeSupported(platform)
                ? {
                      label: `Keep ${computerName(platform)} awake while it works`,
                      on: coffee != null,
                      onToggle: () => setCoffee(coffee == null),
                  }
                : undefined,
            group:
                grouping != null
                    ? {
                          connecting: grouping.connecting,
                          onGroupWith: grouping.onGroupWith,
                          onRemove: grouping.onRemoveFromGroup,
                      }
                    : undefined,
            // The Project tab of the workspace this window shows, made again if the user closed it (FR-SHELL-015).
            onProjectTab: entry.active && projectDir ? () => fireAndForget(openProjectTab) : undefined,
            onReset: () => askResetWorkspace(entry.id),
            remove: {
                enabled: closable,
                reason: LastWorkspaceReason,
                onDelete: () => getApi().deleteWorkspace(entry.id),
            },
        });
    const onContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        if (!entry.saved) {
            return;
        }
        onHover(null, null);
        showRailMenu(entry.id, menuItems(), e);
    };
    const onKeyDown = (e: React.KeyboardEvent) => {
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
    const connect = grouping?.connect;
    const coffeeText = coffee != null ? ` · kept awake ${coffeeCondition(coffee, Date.now())}` : "";
    const stateText = (member?.stateText ? ` · ${member.stateText}` : "") + coffeeText;
    const size = member != null ? RailMemberPx : RailItemPx;
    const primary: RailTrayPrimary =
        coffee != null
            ? {
                  kind: "coffee",
                  label: railCoffeeLabel(entry.name, true, platform),
                  tooltip: coffeeTooltip(coffee, entry.name, platform, Date.now()),
                  pressed: true,
                  onActivate: () => setCoffee(false),
              }
            : { kind: "edit", label: railEditLabel(entry.name), onActivate: edit };
    const dot =
        unread > 0
            ? { className: "bg-primary", label: `${unread} unread` }
            : agent?.state === "waiting"
              ? { className: "bg-[var(--mt-state-waiting)]", label: agentStateTitle(agent) }
              : undefined;
    return (
        <div
            {...hostProps}
            data-rail-unit={unitId}
            data-rail-member={member != null ? "" : undefined}
            data-rail-host={entry.id}
            onContextMenu={onContextMenu}
            className={cn("molten-rail-host relative shrink-0", dragging && "molten-rail-dragging z-10")}
            style={dragging ? { transform: `translateY(${moves.dragOffsetY}px)` } : undefined}
        >
            <button
                ref={ref}
                type="button"
                tabIndex={nav.tabIndex}
                aria-label={`${entry.saved ? entry.name : "Unsaved workspace"}${stateText}${unread > 0 ? `, ${unread} unread` : ""}`}
                aria-current={entry.active ? "true" : undefined}
                data-workspace-id={entry.id}
                data-rail-nav={nav.key}
                onClick={onClick}
                onDoubleClick={onDoubleClick}
                onKeyDown={onKeyDown}
                onFocus={nav.onFocused}
                onPointerDown={moves.onPointerDown}
                onMouseEnter={(e) => {
                    if (entry.saved) {
                        return;
                    }
                    const rect = e.currentTarget.getBoundingClientRect();
                    onHover("Unsaved workspace: click to save it", {
                        top: rect.top + rect.height / 2,
                        left: rect.right + 8,
                    });
                }}
                onMouseLeave={() => onHover(null, null)}
                className={cn(
                    "molten-rail-item molten-rail-anchor cursor-pointer transition-colors duration-120 ease-mt hover:bg-hover",
                    RailBadgeClass,
                    member != null && "h-8 w-8 text-icon-14",
                    entry.active && "bg-hover",
                    !entry.active && entry.open && "outline outline-1 -outline-offset-1 outline-border",
                    connect?.target && "molten-rail-connect-target"
                )}
                data-connect-drop={connect?.dropping ? "" : undefined}
            >
                {entry.active ? <span className="molten-rail-active-bar" aria-hidden /> : null}
                {entry.saved ? (
                    <WorkspaceIcon source={iconSource} />
                ) : (
                    <i className="fa fa-solid fa-floppy-disk text-secondary" />
                )}
                {unread > 0 ? (
                    <span
                        className="molten-rail-dot absolute top-1 right-1 h-2 w-2 rounded-full bg-primary ring-2 ring-[var(--color-background)]"
                        aria-hidden
                    />
                ) : null}
                {member != null ? <WorstDot worst={member.worst} /> : null}
                <AgentRailDot workspaceId={entry.id} />
                {entry.saved ? <RailCoffeeDrop workspaceId={entry.id} /> : null}
                {connect?.dropping ? <RailDropToGroup /> : null}
            </button>
            {entry.saved ? (
                <RailTray
                    open={isOpen}
                    name={entry.name}
                    lead={size}
                    dot={dot}
                    primary={primary}
                    moreLabel={railMoreLabel(entry.name)}
                    onMore={(button) => {
                        onHover(null, null);
                        showRailMenu(entry.id, menuItems(), null, button);
                    }}
                    nameProps={{ onClick, onDoubleClick, onPointerDown: moves.onPointerDown }}
                    onTooltip={onHover}
                />
            ) : null}
        </div>
    );
}

export function WorkspaceRail() {
    const active = useAtomValue(atoms.workspace);
    const [sources, setSources] = useState<WorkspaceRailSource[]>([]);
    const [tooltip, setTooltip] = useState<{ label: string; anchor: Anchor }>(null);
    // The local group whose name is being edited (Rename group…).
    const [renaming, setRenaming] = useState<string>(null);
    // The rail item that last held the focus: the rail's tab stop (DS-SHELL-081).
    const [lastNav, setLastNav] = useState<string>(null);

    const refresh = useCallback(() => {
        fireAndForget(async () => setSources(await loadWorkspaceSources()));
    }, []);
    useEffect(() => {
        refresh();
        return waveEventSubscribeSingle({ eventType: "workspace:update", handler: refresh });
    }, [refresh]);
    useEffect(refresh, [active?.oid, active?.name, active?.icon, active?.color, refresh]);
    // A workspace switch folds the tray (FR-SHELL-045-AC4).
    useEffect(() => RailTrayModel.getInstance().closeAll(), [active?.oid]);

    const entries = makeWorkspaceRailEntries(sources, active);
    const navRef = useRef<HTMLElement>(null);
    useEffect(() => installRailTrayExits(navRef.current), []);
    const movableKey = entries
        .filter((e) => e.saved)
        .map((e) => e.id)
        .join(" ");
    const movableIds = useMemo(() => (movableKey ? movableKey.split(" ") : []), [movableKey]);
    // The product groups (FR-MC-027), asked again when the rail's workspaces, their order or their links change.
    const linksKey = useWorkspaceLinksKey(movableIds);
    const groups = useRailGroups(linksKey);
    // The one product expanded in the rail, like an open folder; its members follow it inline (DS-SHELL-082).
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

    // Connect mode (FR-MC-032-AC2 to AC4, DS-SHELL-081): one target per window, started from More › Group with….
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
    const groupNameOf = (groupId: string) => {
        const group = localGroups.find((g) => g.id === groupId);
        return group == null ? null : localGroupName(group, nameOf);
    };
    const connectName =
        connectTarget == null
            ? null
            : connectTarget.kind === "group"
              ? groupNameOf(connectTarget.id)
              : nameOf(connectTarget.id);
    // A workspace that may join the target: saved, outside the products, neither the target nor one of its members.
    const mayJoin = (workspaceId: string): boolean => {
        const target = connectModel.getTarget();
        if (target == null || !movableIds.includes(workspaceId)) {
            return false;
        }
        if (target.kind === "workspace") {
            return target.id !== workspaceId;
        }
        return !localGroups.find((g) => g.id === target.id)?.members.includes(workspaceId);
    };
    // The box a dragged workspace joins the target over, when it may.
    const joinZone = (draggedId: string): HTMLElement => {
        const target = connectModel.getTarget();
        const nav = navRef.current;
        if (target == null || nav == null || draggedId.startsWith(ProductUnitPrefix) || !mayJoin(draggedId)) {
            return null;
        }
        if (target.kind === "workspace") {
            return nav.querySelector<HTMLElement>(`button[data-workspace-id="${CSS.escape(target.id)}"]`);
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
    // A click on a workspace in connect mode groups it with the target (DS-SHELL-081); a click on the target, one of
    // its members or an unsaved workspace ends connect mode and does its normal job.
    const connectClick = (workspaceId: string): boolean => {
        if (connectModel.getTarget() == null) {
            return false;
        }
        if (projectKeys.has(workspaceId) || mayJoin(workspaceId)) {
            onJoin(workspaceId);
            return true;
        }
        connectModel.end();
        return false;
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
        (dragging) => {
            connectModel.setDragging(dragging);
            RailTrayModel.getInstance().setDragging(dragging);
        }
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
    const joining = drag.view?.joining ?? false;
    const connectState = (target: RailConnectTarget): RailConnectState => {
        const on = isTarget(target);
        return { target: on, dropping: on && joining };
    };
    // A saved workspace outside the project products: Group with… and Remove from group (FR-MC-032-AC1, AC10).
    const itemGrouping = (entry: WorkspaceRailEntry): RailItemGrouping => {
        if (!entry.saved || projectKeys.has(entry.id)) {
            return undefined;
        }
        const own = localGroupOf(localGroups, entry.id);
        const target: RailConnectTarget =
            own != null ? { kind: "group", id: own.id } : { kind: "workspace", id: entry.id };
        const anchor = hostSelector(entry.id);
        return {
            onGroupWith: () => connectModel.toggle(target, own != null ? groupNameOf(own.id) : entry.name),
            connecting: isTarget(target),
            connect: own != null ? { target: false, dropping: false } : connectState(target),
            onRemoveFromGroup:
                own != null
                    ? () => runGroupCommand(() => leaveRailGroup({ workspaceid: entry.id }), anchor)
                    : undefined,
        };
    };
    // The roving tab stop (DS-SHELL-081): the rail's items in order, an expanded group's members after it.
    const navKeys: string[] = [];
    let activeNav: string = null;
    for (const unit of units) {
        navKeys.push(unit.id);
        if (unit.kind === "workspace") {
            if (unit.entry.active) {
                activeNav = unit.id;
            }
            continue;
        }
        const expanded = openProduct === unit.key;
        for (const entry of unit.entries) {
            if (expanded) {
                navKeys.push(entry.id);
            }
            if (entry.active) {
                activeNav = expanded ? entry.id : unit.id;
            }
        }
    }
    const tabStop = railTabStop(navKeys, lastNav, activeNav);
    const navOf = (key: string): RailNavProps => ({
        key,
        tabIndex: key === tabStop ? 0 : -1,
        onFocused: () => setLastNav(key),
    });
    // Up and Down walk the rail's items, Home and End go to its ends; from a tray's button, from its item.
    const onNavKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
        if (e.altKey || e.shiftKey || e.ctrlKey || e.metaKey) {
            return;
        }
        const target = e.target as HTMLElement;
        const from =
            target.closest("[data-rail-tray-host]")?.querySelector<HTMLElement>("[data-rail-nav]") ??
            target.closest<HTMLElement>("[data-rail-nav]");
        if (from == null) {
            return;
        }
        const items = Array.from(navRef.current?.querySelectorAll<HTMLElement>("[data-rail-nav]") ?? []);
        const next = railNavIndex(items.indexOf(from), e.key, items.length);
        if (next == null) {
            return;
        }
        e.preventDefault();
        items[next]?.focus();
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
                    nav={navOf(unit.id)}
                    connectClick={connectClick}
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
                connect={local != null ? connectState({ kind: "group", id: local.id }) : undefined}
                nav={navOf(unit.id)}
                local={
                    local == null
                        ? undefined
                        : {
                              onGroupWith: () =>
                                  connectModel.toggle({ kind: "group", id: local.id }, groupNameOf(local.id)),
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
                {isCollapsed
                    ? null
                    : unit.entries.map((entry) => {
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
                                  }}
                                  nav={navOf(entry.id)}
                                  connectClick={connectClick}
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
            onKeyDown={onNavKeyDown}
            className="molten-workspace-rail relative flex h-full w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border py-2"
        >
            {units.map(renderUnit)}
            {drag.view?.lineY != null ? (
                <span
                    className="molten-rail-drop-line pointer-events-none absolute right-1 left-1 z-20 h-[2px] -translate-y-1/2 rounded-4 bg-accent"
                    style={{ top: drag.view.lineY }}
                    aria-hidden
                />
            ) : null}
            {drag.view?.memberLine != null ? (
                <span
                    className="molten-rail-drop-line pointer-events-none fixed z-[470] h-[2px] -translate-y-1/2 rounded-4 bg-accent"
                    style={drag.view.memberLine}
                    aria-hidden
                />
            ) : null}
            <button
                type="button"
                aria-label="Create workspace"
                className="mt-1 flex h-9 w-9 cursor-pointer items-center justify-center rounded-6 text-secondary transition-colors duration-120 ease-mt hover:bg-hover hover:text-primary"
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
            <RailConnectBanner navRef={navRef} name={connectName} />
            <ProjectLinkDetector />
            <ProjectTabKeeper />
            <PaneFocusKeeper />
            <WorktreeCloseHost />
            <WorkspaceResetHost />
            <WorkspaceEditHost entries={entries} />
        </nav>
    );
}
