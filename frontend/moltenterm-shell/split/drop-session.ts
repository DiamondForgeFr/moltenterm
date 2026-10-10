// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// One drag to split at a time (FR-SHELL-060): what is dragged, the panel and zone under the pointer, the drop and the
// Escape that cancels it. The page is reached through deps (drop-zones.ts), so the session is tested without the app.

import {
    centerOffered,
    DragItem,
    DropAction,
    dropAction,
    DropTarget,
    DropZone,
    dropZoneAt,
    targetAllowed,
} from "./drop-model";

export type DropState = {
    item: DragItem;
    x: number;
    y: number;
    target: DropTarget;
    zone: DropZone;
};

export type DropSessionDeps = {
    // The panel of the shown tab under the point, null outside every panel.
    hitTest: (x: number, y: number) => DropTarget;
    activeTabId: () => string;
    perform: (action: DropAction) => Promise<void>;
};

export class DropSession {
    state: DropState = null;
    deps: DropSessionDeps;
    listeners = new Set<(state: DropState) => void>();

    constructor(deps: DropSessionDeps) {
        this.deps = deps;
    }

    subscribe(fn: (state: DropState) => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    setState(next: DropState) {
        const prev = this.state;
        if (
            prev === next ||
            (prev != null &&
                next != null &&
                prev.item === next.item &&
                prev.zone === next.zone &&
                prev.target?.blockId === next.target?.blockId &&
                rectEq(prev.target?.rect, next.target?.rect) &&
                prev.x === next.x &&
                prev.y === next.y)
        ) {
            return;
        }
        this.state = next;
        for (const fn of this.listeners) {
            fn(next);
        }
    }

    active(): boolean {
        return this.state != null;
    }

    begin(item: DragItem, x?: number, y?: number) {
        if (item == null) {
            return;
        }
        this.setState({ item, x: x ?? -1, y: y ?? -1, target: null, zone: null });
        if (x != null && y != null) {
            this.move(x, y);
        }
    }

    // Follows the pointer; returns the zone under it (null: nothing to drop there).
    move(x: number, y: number): DropZone {
        const state = this.state;
        if (state == null) {
            return null;
        }
        const allowed = targetAllowed(state.item, this.deps.activeTabId());
        const target = allowed ? this.deps.hitTest(x, y) : null;
        const zone = target == null ? null : dropZoneAt(x, y, target.rect, centerOffered(state.item, target));
        this.setState({ ...state, x, y, target, zone });
        return zone;
    }

    // The drag ended without a drop (released elsewhere, Escape, a native drag cancelled).
    cancel() {
        this.setState(null);
    }

    // Escape during the drag cancels it without change (FR-SHELL-060-AC3). True when the key was the session's.
    handleKey(key: string): boolean {
        if (this.state == null || key !== "Escape") {
            return false;
        }
        this.cancel();
        return true;
    }

    // Drops where the pointer is; returns what was done (null: nothing, the drag just ends).
    drop(x?: number, y?: number): DropAction {
        if (this.state == null) {
            return null;
        }
        if (x != null && y != null) {
            this.move(x, y);
        }
        const { item, target, zone } = this.state;
        const action = dropAction(item, zone, target);
        this.setState(null);
        if (action != null) {
            this.deps.perform(action).catch((e) => console.log("drag to split: drop failed", e));
        }
        return action;
    }
}

function rectEq(a: DropTarget["rect"], b: DropTarget["rect"]): boolean {
    if (a == null || b == null) {
        return a === b;
    }
    return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}
