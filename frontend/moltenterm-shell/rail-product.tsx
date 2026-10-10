// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A product in the workspace rail (FR-MC-027, DS-MC-018): one entry for a group of two members or more. A click opens
// or closes it like a folder. Closed, it carries the worst member state, its members' unread dot and most urgent agent
// state, and the active mark when one of them is active.
// #399 (FR-SHELL-045, DS-SHELL-082): its tile shows its first four members' icons in a 2x2 grid framed in the group's
// colour, where #381 showed one member's icon with a corner chevron; expanded, its workspaces follow it inline in the
// rail, indented along a guide in the group's colour, instead of a column floating over the content. Hovering it shows
// its tray with the name and the member count.
// A local group (FR-MC-032) is drawn the same way, named after its first member until renamed; its More holds Add
// workspaces…, Rename group… and Ungroup, and none of a project group's strip, dependencies or Sync.

import { makeORef, useWaveObjectValue } from "@/app/store/wos";
import { cn } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { mostUrgentAgentState } from "./agent-state-model";
import { AgentStates } from "./agent-state-store";
import { AgentStateDot } from "./agent-state-ui";
import { ProductCoffeeDrop } from "./keepawake-ui";
import { productGridEntries, productIconEntry, RailProductUnit, UnitMoves, worstLabel } from "./rail-groups";
import { RailTray, showRailMenu, useRailTrayHost } from "./rail-tray";
import { railGroupMenu, railMoreLabel } from "./rail-tray-model";
import { RailBadgeClass, WorkspaceIcon } from "./workspace-icon";
import { workspaceIconSource } from "./workspace-icon-model";
import { RailMove } from "./workspace-order";
import { railMoveKey } from "./workspace-rail-drag";
import { WorkspaceRailEntry } from "./workspace-rail-model";

// Connect mode on a rail item or a local product (FR-MC-032-AC2): the target, and whether a dragged workspace is over it.
export type RailConnectState = { target: boolean; dropping: boolean };

// What a local product adds (FR-MC-032-AC6, AC7).
export type RailLocalActions = {
    onGroupWith: () => void;
    renaming: boolean;
    onRenameStart: () => void;
    // The field's value; the rail trims it and an empty one gives back the default name.
    onRename: (name: string) => void;
    onRenameCancel: () => void;
    onUngroup: () => void;
};

// The + of "drop to group" over the target while a dragged workspace is over it.
export function RailDropToGroup() {
    return (
        <span
            className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-6 bg-[color-mix(in_srgb,var(--color-accent)_35%,transparent)]"
            aria-hidden
        >
            <i className="fa fa-solid fa-plus text-icon-14 text-primary" />
        </span>
    );
}

function RenameField({
    anchor,
    initial,
    onSave,
    onCancel,
}: {
    anchor: React.RefObject<HTMLElement>;
    initial: string;
    onSave: (name: string) => void;
    onCancel: () => void;
}) {
    const [value, setValue] = useState(initial);
    const [place, setPlace] = useState<{ top: number; left: number }>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    useLayoutEffect(() => {
        const rect = anchor.current?.getBoundingClientRect();
        if (rect != null) {
            setPlace({ top: rect.top + rect.height / 2, left: rect.right + 8 });
        }
    }, [anchor]);
    // Focused once placed: a hidden field cannot take the focus.
    const placed = place != null;
    useEffect(() => {
        if (!placed) {
            return;
        }
        inputRef.current?.focus();
        inputRef.current?.select();
    }, [placed]);
    return (
        <div
            className="fixed z-[9500] -translate-y-1/2 rounded-10 border border-border bg-surface-3 p-1 shadow-e2"
            style={{ top: place?.top ?? 0, left: place?.left ?? 0, visibility: place == null ? "hidden" : undefined }}
        >
            <input
                ref={inputRef}
                aria-label="Group name (empty: the first workspace's name)"
                value={value}
                placeholder="Name of the first workspace"
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") {
                        e.preventDefault();
                        onSave(value);
                    } else if (e.key === "Escape") {
                        e.preventDefault();
                        onCancel();
                    }
                }}
                onBlur={onCancel}
                className="w-44 rounded-4 border border-border bg-transparent px-2 py-1 text-12 text-primary outline-none focus:border-accent"
            />
        </div>
    );
}

export type RailAnchor = { top: number; left: number };

export const WorstDotClasses: Record<string, string> = {
    red: "bg-error",
    amber: "bg-warning",
};

// The badge of a member's worst state (red over amber), top-left: the unread dot holds the top-right corner, the agent
// state the bottom-right and the coffee the bottom-left.
export function WorstDot({ worst, className }: { worst: string; className?: string }) {
    const color = WorstDotClasses[worst];
    if (color == null) {
        return null;
    }
    return (
        <span
            className={cn(
                "molten-rail-worst pointer-events-none absolute top-0.5 left-0.5 h-2 w-2 rounded-full ring-2 ring-[var(--color-background)]",
                color,
                className
            )}
            role="img"
            aria-label={worstLabel(worst)}
        />
    );
}

function ProductAgentDot({ workspaceIds }: { workspaceIds: string[] }) {
    const idsKey = workspaceIds.join(" ");
    const stateAtom = useMemo(() => {
        const store = AgentStates.getInstance();
        const ids = idsKey ? idsKey.split(" ") : [];
        return atom((get) => mostUrgentAgentState(ids.map((id) => get(store.workspaceAtom(id)))));
    }, [idsKey]);
    const info = useAtomValue(stateAtom);
    if (info == null) {
        return null;
    }
    return (
        <AgentStateDot
            info={info}
            className="molten-rail-agent-dot absolute right-1 bottom-1 ring-2 ring-[var(--color-background)]"
        />
    );
}

// One member's icon in the group tile's grid, read live like a rail item's.
function RailGroupCell({ entry }: { entry: WorkspaceRailEntry }) {
    const [workspace] = useWaveObjectValue<Workspace>(makeORef("workspace", entry.id));
    const source =
        workspace != null
            ? workspaceIconSource(workspace)
            : { icon: entry.icon, color: entry.color, image: "", logo: "" };
    return (
        <span className="molten-rail-group-cell flex items-center justify-center">
            <WorkspaceIcon source={source} className="h-3 w-3 text-11" />
        </span>
    );
}

// The group's colour: its icon member's, as the rail drew the group before (FR-MC-027-AC7).
function useGroupColor(unit: RailProductUnit): string {
    const iconEntry = productIconEntry(unit);
    const [workspace] = useWaveObjectValue<Workspace>(makeORef("workspace", iconEntry?.id));
    return workspace?.color || iconEntry?.color || "";
}

export function RailProduct({
    unit,
    collapsed,
    unread,
    moves,
    dragOffsetY,
    onToggle,
    onHover,
    onMove,
    onPointerDown,
    takeSuppressedClick,
    connect,
    local,
    nav,
    children,
}: {
    unit: RailProductUnit;
    collapsed: boolean;
    // Unread notifications of all its workspaces.
    unread: number;
    moves: UnitMoves;
    // How far a drag draws the product from its place; null when it is not dragged.
    dragOffsetY: number;
    onToggle: () => void;
    onHover: (label: string, anchor: RailAnchor) => void;
    onMove: (move: RailMove, refocus: boolean) => void;
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
    takeSuppressedClick: () => boolean;
    connect?: RailConnectState;
    local?: RailLocalActions;
    nav: { key: string; tabIndex: number; onFocused: () => void };
    // Its workspaces, as rail items; the rail passes them only while it is expanded.
    children: React.ReactNode;
}) {
    const ref = useRef<HTMLButtonElement>(null);
    const color = useGroupColor(unit);
    const { isOpen, hostProps } = useRailTrayHost(unit.id, true);
    const name = unit.group?.name || unit.key;
    const worst = unit.group?.worst ?? "";
    const memberActive = unit.entries.some((e) => e.active);
    const showActive = collapsed && memberActive;
    const workspaceIds = unit.entries.map((e) => e.id);
    const kindLabel = unit.local != null ? "group" : "product";
    const onClick = () => {
        if (takeSuppressedClick()) {
            return;
        }
        onHover(null, null);
        onToggle();
    };
    const menuItems = () =>
        railGroupMenu({
            collapsed,
            onToggle,
            local:
                local == null
                    ? undefined
                    : {
                          connecting: !!connect?.target,
                          onGroupWith: local.onGroupWith,
                          onRename: local.onRenameStart,
                          onUngroup: local.onUngroup,
                      },
        });
    const onContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        if ((e.target as Element).closest?.("[data-rail-member]") != null) {
            return;
        }
        onHover(null, null);
        showRailMenu(unit.id, menuItems(), e);
    };
    const onKeyDown = (e: React.KeyboardEvent) => {
        const direction = railMoveKey(e);
        if (direction == null) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        const move = direction < 0 ? moves.up : moves.down;
        if (move != null) {
            onMove(move, true);
        }
    };
    const dragging = dragOffsetY != null;
    const cells = productGridEntries(unit);
    const count = `${unit.entries.length}`;
    return (
        <div
            data-rail-unit={unit.id}
            data-rail-local={unit.local?.id}
            className={cn(
                "molten-rail-unit relative flex shrink-0 flex-col items-center gap-1",
                dragging && "molten-rail-dragging z-10"
            )}
            style={
                {
                    ...(dragging ? { transform: `translateY(${dragOffsetY}px)` } : {}),
                    "--mt-group-color": color || undefined,
                } as React.CSSProperties
            }
        >
            <div {...hostProps} className="molten-rail-host relative shrink-0" onContextMenu={onContextMenu}>
                <button
                    ref={ref}
                    type="button"
                    tabIndex={nav.tabIndex}
                    aria-label={`${name}, ${kindLabel} of ${unit.entries.length} workspaces${unread > 0 ? `, ${unread} unread` : ""}`}
                    aria-expanded={!collapsed}
                    aria-current={showActive ? "true" : undefined}
                    data-rail-product={unit.key}
                    data-rail-nav={nav.key}
                    onClick={onClick}
                    onKeyDown={onKeyDown}
                    onFocus={nav.onFocused}
                    onPointerDown={onPointerDown}
                    data-connect-drop={connect?.dropping ? "" : undefined}
                    className={cn(
                        "molten-rail-item molten-rail-anchor molten-rail-group cursor-pointer transition-colors duration-120 ease-mt hover:bg-hover",
                        RailBadgeClass,
                        showActive && "bg-hover",
                        connect?.target && "molten-rail-connect-target"
                    )}
                >
                    {showActive ? <span className="molten-rail-active-bar" aria-hidden /> : null}
                    <span className="molten-rail-group-grid" aria-hidden>
                        {cells.map((entry) => (
                            <RailGroupCell key={entry.id} entry={entry} />
                        ))}
                    </span>
                    {collapsed ? <WorstDot worst={worst} className="h-2.5 w-2.5" /> : null}
                    {collapsed && unread > 0 ? (
                        <span
                            className="molten-rail-dot absolute top-1 right-1 h-2 w-2 rounded-full bg-primary ring-2 ring-[var(--color-background)]"
                            aria-hidden
                        />
                    ) : null}
                    {collapsed ? <ProductAgentDot workspaceIds={workspaceIds} /> : null}
                    {collapsed ? <ProductCoffeeDrop workspaceIds={workspaceIds} /> : null}
                    {connect?.dropping ? <RailDropToGroup /> : null}
                </button>
                <RailTray
                    open={isOpen}
                    name={name}
                    detail={count}
                    lead={36}
                    moreLabel={railMoreLabel(name)}
                    onMore={(button) => {
                        onHover(null, null);
                        showRailMenu(unit.id, menuItems(), null, button);
                    }}
                    nameProps={{ onClick, onPointerDown }}
                    onTooltip={onHover}
                />
                {local?.renaming ? (
                    <RenameField
                        anchor={ref}
                        initial={unit.local?.name ?? ""}
                        onSave={local.onRename}
                        onCancel={local.onRenameCancel}
                    />
                ) : null}
            </div>
            {collapsed ? null : (
                <div className="molten-rail-members" role="group" aria-label={`Workspaces of ${name}`}>
                    {children}
                </div>
            )}
        </div>
    );
}
