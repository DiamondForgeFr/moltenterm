// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The last mouse pointer position in the window, for ⌘N (#1241). One passive listener stores two numbers per move;
// the panel under the pointer is only looked up when the key is pressed (findPanelUnderPointer).

import type { PointerHit } from "./new-panel-model";

type PointerState = { x: number; y: number; inside: boolean };

const pointer: PointerState = { x: 0, y: 0, inside: false };
let installed = false;

function onPointerMove(e: PointerEvent) {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.inside = true;
}

// relatedTarget null: the pointer left the window, not just one element for another.
function onPointerOut(e: PointerEvent) {
    if (e.relatedTarget == null) {
        pointer.inside = false;
    }
}

export function installPointerTracker(): void {
    if (installed || typeof window === "undefined") {
        return;
    }
    installed = true;
    window.addEventListener("pointermove", onPointerMove, { passive: true, capture: true });
    window.addEventListener("pointerout", onPointerOut, { passive: true, capture: true });
}

export function lastPointer(): PointerState {
    return { ...pointer };
}

// The panel under the last pointer position, with its box; null when the pointer is outside the window or over no
// panel (the sidebar, an overlay).
export function findPanelUnderPointer(): { hit: PointerHit; x: number } {
    if (!pointer.inside || typeof document === "undefined") {
        return null;
    }
    const elem = document.elementFromPoint(pointer.x, pointer.y);
    const block = elem?.closest?.("[data-blockid]") as HTMLElement;
    const blockId = block?.dataset?.blockid;
    if (!blockId) {
        return null;
    }
    const rect = block.getBoundingClientRect();
    return { hit: { blockId, left: rect.left, width: rect.width }, x: pointer.x };
}
