// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Reordering the tabs of a browser panel by dragging them (#388). The drag is a native HTML drag, so two things matter:
// Chromium only starts it when the drag carries data, and Wave's react-dnd HTML5 backend listens on the window and
// cancels (preventDefault on dragstart) every drag it does not know. The handlers therefore put the tab id in a
// dedicated type and stop the drag events at the tab, so the backend never sees them (and never starts a block drag).

import { cn } from "@/util/util";
import { BrowserState, BrowserTab, moveTab } from "./browser-model";

export const TabDragType = "application/x-moltenterm-browser-tab";

export type DropTarget = { overId: string; after: boolean };

export type TabDragEvent = {
    clientX: number;
    currentTarget: { getBoundingClientRect(): { left: number; width: number } };
    dataTransfer: {
        types?: ArrayLike<string> | readonly string[];
        effectAllowed: string;
        dropEffect: string;
        setData(type: string, data: string): void;
        getData(type: string): string;
    } | null;
    preventDefault(): void;
    stopPropagation(): void;
};

// Where a tab dragged over another one would land: in its right half, after it, else before it.
export function dropSide(left: number, width: number, clientX: number): boolean {
    return clientX > left + width / 2;
}

// The index moveTab takes for a drop before or after the hovered tab, or null when the tab would stay where it is.
export function tabDropIndex(tabs: BrowserTab[], dragId: string, target: DropTarget): number | null {
    const from = tabs.findIndex((t) => t.id === dragId);
    const over = tabs.findIndex((t) => t.id === target.overId);
    if (from < 0 || over < 0) {
        return null;
    }
    const slot = over + (target.after ? 1 : 0);
    const index = from < slot ? slot - 1 : slot;
    return index === from ? null : index;
}

export function dropTabState(state: BrowserState, dragId: string, target: DropTarget): BrowserState {
    const index = tabDropIndex(state.tabs, dragId, target);
    return index == null ? state : moveTab(state, dragId, index);
}

export function startTabDrag(e: TabDragEvent, tabId: string): void {
    e.stopPropagation();
    if (e.dataTransfer == null) {
        return;
    }
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(TabDragType, tabId);
}

// The tab the drag is over, or null when this drag is not a tab of this strip (the event is then left alone).
export function overTab(e: TabDragEvent, dragId: string, overId: string): DropTarget | null {
    if (dragId == null) {
        return null;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer != null) {
        e.dataTransfer.dropEffect = "move";
    }
    const rect = e.currentTarget.getBoundingClientRect();
    return { overId, after: dropSide(rect.left, rect.width, e.clientX) };
}

export function dropOnTab(e: TabDragEvent, state: BrowserState, dragId: string, target: DropTarget): BrowserState {
    if (dragId == null || target == null) {
        return state;
    }
    e.preventDefault();
    e.stopPropagation();
    return dropTabState(state, dragId, target);
}

export function TabDropIndicator({ after }: { after: boolean }) {
    return (
        <span
            aria-hidden="true"
            data-dropindicator={after ? "after" : "before"}
            className={cn(
                "pointer-events-none absolute inset-y-0 z-10 w-0.5 rounded-4 bg-accent",
                after ? "right-0" : "left-0"
            )}
        />
    );
}
