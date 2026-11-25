// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A panel dragged by its header over the sidebar (FR-SHELL-080, #2548): the sidebar's sections light up as drop zones,
// and a release on one makes a view that holds a copy of the panel there. Dragging a panel onto another panel is the
// layout's own (TileLayout.tsx) and stays as it is. Mounted once, inside react-dnd's provider.

import { atoms, globalStore } from "@/app/store/global";
import type { LayoutNode } from "@/layout/lib/types";
import { fireAndForget } from "@/util/util";
import { useEffect } from "react";
import { useDragLayer, useDrop } from "react-dnd";
import { panelHitAt } from "./panel-view-hit";
import { destinationOfHit, PanelHit, PanelViewDestination, sameHit } from "./panel-view-model";
import { makeViewFromPanel, panelViewDragAtom } from "./panel-view-store";
import { currentProjectId, readProjects } from "./workspace-projects";

// Wave's tile drag (TileLayout.tsx).
export const TileItemType = "TILE_ITEM";

type Point = { x: number; y: number };

export function blockIdOf(item: LayoutNode): string {
    return item?.data?.blockId ?? null;
}

function destinationAt(hit: PanelHit): PanelViewDestination {
    const ws = globalStore.get(atoms.workspace);
    return destinationOfHit(hit, currentProjectId(ws) ?? "", readProjects(ws).length > 1);
}

// Whether a panel released at a point lands on a zone; away from every zone, on the panels or on the sidebar's free
// space, the drop is not this one's.
export function canDropOnSidebar(
    item: LayoutNode,
    at: Point,
    hitAt: (x: number, y: number) => PanelHit = panelHitAt,
    destination: (hit: PanelHit) => PanelViewDestination = destinationAt
): boolean {
    return at != null && blockIdOf(item) != null && destination(hitAt(at.x, at.y)) != null;
}

// The release: a view made from the panel, where it was released. true when it was taken.
export function dropOnSidebar(
    item: LayoutNode,
    at: Point,
    make: (blockId: string, destination: PanelViewDestination) => unknown = (id, dest) =>
        fireAndForget(() => makeViewFromPanel(id, dest)),
    hitAt: (x: number, y: number) => PanelHit = panelHitAt,
    destination: (hit: PanelHit) => PanelViewDestination = destinationAt
): boolean {
    const id = blockIdOf(item);
    const dest = at == null ? null : destination(hitAt(at.x, at.y));
    if (id == null || dest == null) {
        return false;
    }
    make(id, dest);
    return true;
}

export function SidebarPanelDrop({ asideRef }: { asideRef: React.RefObject<HTMLElement> }) {
    const { dragging, item, offset } = useDragLayer((monitor) => ({
        dragging: monitor.isDragging() && monitor.getItemType() === TileItemType,
        item: monitor.getItem<LayoutNode>(),
        offset: monitor.getClientOffset(),
    }));
    const blockId = blockIdOf(item);
    useEffect(() => {
        const now = globalStore.get(panelViewDragAtom);
        if (!dragging || blockId == null || offset == null) {
            if (now != null) {
                globalStore.set(panelViewDragAtom, null);
            }
            return;
        }
        const hit = panelHitAt(offset.x, offset.y);
        if (now != null && now.blockId === blockId && sameHit(now.hit, hit)) {
            return;
        }
        globalStore.set(panelViewDragAtom, { blockId, hit });
    }, [dragging, blockId, offset?.x, offset?.y]);
    useEffect(() => () => globalStore.set(panelViewDragAtom, null), []);
    const [, drop] = useDrop(
        () => ({
            accept: TileItemType,
            canDrop: (dragged: LayoutNode, monitor) => canDropOnSidebar(dragged, monitor.getClientOffset()),
            drop: (dragged: LayoutNode, monitor) =>
                dropOnSidebar(dragged, monitor.getClientOffset()) ? { molten: "panel-view" } : undefined,
        }),
        []
    );
    useEffect(() => {
        drop(asideRef);
    }, [drop, asideRef]);
    return null;
}
