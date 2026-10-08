// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The rules of a rail item's drag (FR-MC-031, DS-MC-025), apart from the component so they can be tested.

// The tab bar persists a drag only past 50 px, more than one 40 px rail slot: the rail starts its drag much sooner, and
// a press that moves less is a click.
export const RailDragThresholdPx = 5;
// Near the rail's top or bottom edge the rail scrolls, faster nearer the edge.
export const RailAutoScrollZonePx = 24;
export const RailAutoScrollMaxPx = 12;

export type RailItemBox = { id: string; top: number; bottom: number };

export function passedDragThreshold(startY: number, y: number): boolean {
    return Math.abs(y - startY) >= RailDragThresholdPx;
}

// The slot among the other items where the pointer would drop the dragged one: the number of other items whose middle
// is above the pointer.
export function dropSlot(boxes: RailItemBox[], draggedId: string, y: number): number {
    let slot = 0;
    for (const box of boxes) {
        if (box.id === draggedId) {
            continue;
        }
        if ((box.top + box.bottom) / 2 < y) {
            slot++;
        }
    }
    return slot;
}

// Where the drop line goes for a slot: halfway in the gap between the two other items around it, or just past the
// first or the last one.
export function dropLineY(boxes: RailItemBox[], draggedId: string, slot: number): number {
    const others = boxes.filter((box) => box.id !== draggedId);
    if (others.length === 0) {
        return null;
    }
    if (slot <= 0) {
        return others[0].top - 2;
    }
    if (slot >= others.length) {
        return others[others.length - 1].bottom + 2;
    }
    return (others[slot - 1].bottom + others[slot].top) / 2;
}

// Pixels to scroll the rail for one frame: negative near the top, positive near the bottom, 0 elsewhere.
export function autoScrollStep(y: number, top: number, bottom: number): number {
    if (y < top + RailAutoScrollZonePx) {
        const depth = Math.min(1, (top + RailAutoScrollZonePx - y) / RailAutoScrollZonePx);
        return -Math.ceil(RailAutoScrollMaxPx * depth);
    }
    if (y > bottom - RailAutoScrollZonePx) {
        const depth = Math.min(1, (y - (bottom - RailAutoScrollZonePx)) / RailAutoScrollZonePx);
        return Math.ceil(RailAutoScrollMaxPx * depth);
    }
    return 0;
}

// Alt+Shift+↑ or ↓ on a focused rail item moves it; no MoltenTerm or Wave binding uses these keys.
export function railMoveKey(e: Pick<KeyboardEvent, "key" | "altKey" | "shiftKey" | "ctrlKey" | "metaKey">): -1 | 1 {
    if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) {
        return null;
    }
    if (e.key === "ArrowUp") {
        return -1;
    }
    if (e.key === "ArrowDown") {
        return 1;
    }
    return null;
}
