// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Drag to reorder in the template editor (FR-SHELL-106): a press that moves a few pixels picks the item up, the item
// under the pointer is where it lands, and the release drops it there. Pointer events rather than HTML drag and drop,
// as the sidebar does (sidebar-drag.ts): no drag image, and the press inside a field still selects text.

import { useEffect, useRef, useState } from "react";

// How far the pointer moves before a press becomes a drag, so a click stays a click.
const DragThresholdPx = 4;

export type ReorderDrag = { from: number; over: number };

// The index an element of the list carries, read from its data attribute; null outside the list.
export function reorderIndexAt(el: Element, attr: string, container: Element): number {
    const item = el?.closest(`[${attr}]`);
    if (item == null || container == null || !container.contains(item)) {
        return null;
    }
    const n = Number(item.getAttribute(attr));
    return Number.isInteger(n) ? n : null;
}

// What a press on an item does: nothing when it starts on a field or a button inside it, which keep their own gesture.
export function startsReorder(target: Element): boolean {
    return target?.closest("input, textarea, select, button, [data-no-drag]") == null;
}

export function usePointerReorder(attr: string, onDrop: (from: number, to: number) => void) {
    const containerRef = useRef<HTMLElement>(null);
    const [drag, setDrag] = useState<ReorderDrag>(null);
    const dropRef = useRef(onDrop);
    dropRef.current = onDrop;
    const cleanupRef = useRef<() => void>(null);
    useEffect(() => () => cleanupRef.current?.(), []);

    const onPointerDown = (e: React.PointerEvent, index: number) => {
        if (e.button !== 0 || !startsReorder(e.target as Element)) {
            return;
        }
        const startX = e.clientX;
        const startY = e.clientY;
        let current: ReorderDrag = null;
        const move = (ev: PointerEvent) => {
            if (current == null && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DragThresholdPx) {
                return;
            }
            ev.preventDefault();
            const over = reorderIndexAt(document.elementFromPoint(ev.clientX, ev.clientY), attr, containerRef.current);
            current = { from: index, over: over ?? current?.over ?? index };
            setDrag(current);
        };
        const end = (ev: PointerEvent) => {
            cleanup();
            if (current == null) {
                return;
            }
            ev.preventDefault();
            setDrag(null);
            if (current.over !== current.from) {
                dropRef.current(current.from, current.over);
            }
        };
        const cancel = (ev: KeyboardEvent) => {
            if (ev.key === "Escape" && current != null) {
                ev.preventDefault();
                ev.stopPropagation();
                cleanup();
                setDrag(null);
            }
        };
        const cleanup = () => {
            window.removeEventListener("pointermove", move, true);
            window.removeEventListener("pointerup", end, true);
            window.removeEventListener("keydown", cancel, true);
            cleanupRef.current = null;
        };
        cleanupRef.current?.();
        cleanupRef.current = cleanup;
        window.addEventListener("pointermove", move, true);
        window.addEventListener("pointerup", end, true);
        window.addEventListener("keydown", cancel, true);
    };

    return { containerRef, drag, onPointerDown };
}
