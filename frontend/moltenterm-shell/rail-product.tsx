// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A product in the workspace rail (FR-MC-027, DS-MC-018): one entry for a group of two members or more. Its icon is a
// member's (rail-groups.ts); a click expands or collapses it. Collapsed, it carries the worst member state, its
// members' unread dot and most urgent agent state, and the active mark when one of them is active. Expanded, its
// workspaces are drawn below it, indented along a thin guide; the rail renders them as ordinary rail items.

import { ContextMenuModel } from "@/app/store/contextmenu";
import { makeORef, useWaveObjectValue } from "@/app/store/wos";
import { cn } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import { useMemo, useRef } from "react";
import { mostUrgentAgentState } from "./agent-state-model";
import { AgentStates } from "./agent-state-store";
import { AgentStateDot } from "./agent-state-ui";
import { productHoverText, productIconEntry, RailProductUnit, UnitMoves, worstLabel } from "./rail-groups";
import { RailBadgeClass, WorkspaceIcon } from "./workspace-icon";
import { workspaceIconSource } from "./workspace-icon-model";
import { RailMove } from "./workspace-order";
import { railMoveKey } from "./workspace-rail-drag";

export type RailAnchor = { top: number; left: number };

export const WorstDotClasses: Record<string, string> = {
    red: "bg-error",
    amber: "bg-warning",
};

// The badge of a member's worst state (red over amber), top-left: the unread dot holds the top-right corner and the
// agent state the bottom-right; the pencil buds out beside the icon (#365).
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
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => void;
    takeSuppressedClick: () => boolean;
    // Its workspaces, as rail items.
    children: React.ReactNode;
}) {
    const ref = useRef<HTMLButtonElement>(null);
    const iconEntry = productIconEntry(unit);
    const [iconWorkspace] = useWaveObjectValue<Workspace>(makeORef("workspace", iconEntry?.id));
    const iconSource =
        iconWorkspace != null
            ? workspaceIconSource(iconWorkspace)
            : { icon: iconEntry?.icon, color: iconEntry?.color, image: "", logo: "" };
    const name = unit.group?.name || unit.key;
    const worst = unit.group?.worst ?? "";
    const memberActive = unit.entries.some((e) => e.active);
    const showActive = collapsed && memberActive;
    const workspaceIds = unit.entries.map((e) => e.id);
    const anchorOf = (): RailAnchor => {
        const rect = ref.current.getBoundingClientRect();
        return { top: rect.top + rect.height / 2, left: rect.right + 8 };
    };
    const onClick = () => {
        if (takeSuppressedClick()) {
            return;
        }
        onHover(null, null);
        onToggle();
    };
    const onContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        ContextMenuModel.getInstance().showContextMenu(
            [{ label: collapsed ? "Expand" : "Collapse", click: onToggle }],
            e
        );
    };
    const onKeyDown = (e: React.KeyboardEvent) => {
        const direction = railMoveKey(e);
        if (direction != null) {
            e.preventDefault();
            e.stopPropagation();
            const move = direction < 0 ? moves.up : moves.down;
            if (move != null) {
                onMove(move, true);
            }
            return;
        }
        if (e.key !== "ArrowDown" || collapsed || e.altKey || e.shiftKey || e.ctrlKey || e.metaKey) {
            return;
        }
        const first = ref.current
            ?.closest("[data-rail-unit]")
            ?.querySelector<HTMLElement>(`button[data-workspace-id="${CSS.escape(workspaceIds[0])}"]`);
        if (first != null) {
            e.preventDefault();
            first.focus();
        }
    };
    const dragging = dragOffsetY != null;
    const hover = productHoverText(unit) + (collapsed && unread > 0 ? `\n${unread} unread` : "");
    return (
        <div
            data-rail-unit={unit.id}
            className={cn("relative flex shrink-0 flex-col items-center", dragging && "molten-rail-dragging z-10")}
            style={dragging ? { transform: `translateY(${dragOffsetY}px)` } : undefined}
        >
            <div className="group relative shrink-0">
                <button
                    ref={ref}
                    type="button"
                    aria-label={`${name}, product of ${unit.entries.length} workspaces`}
                    aria-expanded={!collapsed}
                    aria-current={showActive ? "true" : undefined}
                    data-rail-product={unit.key}
                    onClick={onClick}
                    onContextMenu={onContextMenu}
                    onKeyDown={onKeyDown}
                    onPointerDown={onPointerDown}
                    onMouseEnter={() => onHover(hover, anchorOf())}
                    onMouseLeave={() => onHover(null, null)}
                    className={cn(
                        "molten-rail-item molten-rail-product cursor-pointer transition-colors hover:bg-hover",
                        RailBadgeClass,
                        showActive && "bg-hover"
                    )}
                >
                    {showActive ? (
                        <span className="absolute top-1.5 bottom-1.5 -left-1.5 w-[2px] rounded bg-accent" aria-hidden />
                    ) : null}
                    <WorkspaceIcon source={iconSource} />
                    <i
                        className={cn(
                            "fa fa-solid absolute bottom-0.5 left-0.5 text-[7px] text-secondary",
                            collapsed ? "fa-chevron-right" : "fa-chevron-down"
                        )}
                        aria-hidden
                    />
                    {collapsed ? <WorstDot worst={worst} className="h-2.5 w-2.5" /> : null}
                    {collapsed && unread > 0 ? (
                        <span
                            className="molten-rail-dot absolute top-1 right-1 h-2 w-2 rounded-full bg-primary ring-2 ring-[var(--color-background)]"
                            aria-label={`${unread} unread`}
                        />
                    ) : null}
                    {collapsed ? <ProductAgentDot workspaceIds={workspaceIds} /> : null}
                </button>
            </div>
            <div
                className={cn(
                    "molten-rail-members grid w-full transition-[grid-template-rows,opacity] duration-150 ease-out motion-reduce:transition-none",
                    collapsed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"
                )}
                inert={collapsed}
                aria-hidden={collapsed ? true : undefined}
            >
                <div
                    className={cn(
                        "relative flex min-h-0 flex-col items-center gap-1 pl-2",
                        collapsed ? "overflow-hidden" : "pt-1"
                    )}
                >
                    <span className="absolute top-1 bottom-1 left-[5px] w-px rounded bg-border" aria-hidden />
                    {children}
                </div>
            </div>
        </div>
    );
}
