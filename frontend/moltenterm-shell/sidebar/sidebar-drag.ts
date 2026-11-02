// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Dragging views in the sidebar (FR-SHELL-081): tiles and top-row blocks reorder among their row, a tile or a
// temporary view dropped on the top row is pinned everywhere, a temporary view dropped on the tiles is pinned in the
// workspace, a top-row block dropped on the tiles is pinned only there, and a tile or a top-row block dropped on the
// temporary list becomes temporary (#1244). The rows that would move the view show their scope caption; the row being reordered hides its own. Moved blocks
// glide to their new place.

import { globalStore } from "@/app/store/jotaiStore";
import { fireAndForget } from "@/util/util";
import * as jotai from "jotai";
import { useLayoutEffect, useRef } from "react";
import { MotionClass, prefersReducedMotion } from "../molten-motion";
import { DragKind, dropAction, dropsAfter, DropZone, isMoveAction } from "./view-menu-model";
import { ViewPins } from "./view-pins-store";

export const DragThresholdPx = 4;
const ZoneAttr = "data-sb-zone";
const KeyAttr = "data-sb-key";

export type SidebarDrag = {
    kind: DragKind;
    // The tab of a tile or a row, the pin of a top-row block.
    id: string;
    zone: DropZone;
    // The block the pointer is on in that zone, and its side.
    key: string;
    after: boolean;
    // False for a view a drop must not pin (MoltenTerm's own Project tab): it only reorders.
    pinnable: boolean;
};

// A zone the dragged view may land on: one whose drop does something, and never a move for a view that keeps its
// state (the Project tab, #1244).
export function usableHit(kind: DragKind, hit: ZoneHit, pinnable: boolean): ZoneHit {
    const action = hit == null ? null : dropAction(kind, hit.zone);
    if (action == null || (!pinnable && isMoveAction(action))) {
        return null;
    }
    return hit;
}

export const sidebarDragAtom = jotai.atom(null) as jotai.PrimitiveAtom<SidebarDrag>;

export type ZoneHit = { zone: DropZone; key: string; after: boolean };

// The row and the block under the pointer.
export function zoneAt(x: number, y: number): ZoneHit {
    const el = document.elementFromPoint(x, y);
    const zoneEl = el?.closest<HTMLElement>(`[${ZoneAttr}]`);
    if (zoneEl == null) {
        return null;
    }
    const zone = zoneEl.getAttribute(ZoneAttr) as DropZone;
    const block = el.closest<HTMLElement>(`[${KeyAttr}]`);
    if (block == null || !zoneEl.contains(block)) {
        return { zone, key: null, after: false };
    }
    return { zone, key: block.getAttribute(KeyAttr), after: dropsAfter(x, block.getBoundingClientRect()) };
}

export function zoneProps(zone: DropZone): Record<string, string> {
    return { [ZoneAttr]: zone };
}

export function keyProps(key: string): Record<string, string> {
    return { [KeyAttr]: key };
}

// What a drop does; true when the drop was taken.
export function finishDrop(kind: DragKind, id: string, hit: ZoneHit, name: string): boolean {
    if (hit == null) {
        return false;
    }
    const action = dropAction(kind, hit.zone);
    const pins = ViewPins.getInstance();
    if (action === "reorder-tiles" || action === "reorder-top") {
        if (hit.key == null || hit.key === id) {
            return true;
        }
        fireAndForget(() =>
            action === "reorder-tiles"
                ? pins.reorderTiles(id, hit.key, hit.after)
                : pins.reorderTop(id, hit.key, hit.after)
        );
        return true;
    }
    if (action === "pin-here") {
        fireAndForget(() => pins.pinHere(id, name));
        return true;
    }
    if (action === "pin-everywhere") {
        fireAndForget(() => pins.pinEverywhere(id, name));
        return true;
    }
    // A top-row block's id is its pin's; a tile's is its tab's.
    const ref = kind === "top" ? { pinId: id } : { tabId: id };
    if (action === "pin-only-here") {
        fireAndForget(() => pins.moveView(ref, "workspace"));
        return true;
    }
    if (action === "make-temporary") {
        fireAndForget(() => pins.moveView(ref, "temporary"));
        return true;
    }
    return false;
}

export function setDrag(drag: SidebarDrag) {
    globalStore.set(sidebarDragAtom, drag);
}

let suppressedClick: string = null;

// A click that ends a drag does not open the block.
export function takeDragClick(id: string): boolean {
    const taken = suppressedClick === id;
    suppressedClick = null;
    return taken;
}

// Starts dragging a tile or a top-row block: past a few pixels it follows the pointer over the zones; on release it
// reorders or pins. name: the view's shown name, for a pin's toast.
export function startBlockDrag(e: React.MouseEvent, kind: "tile" | "top", id: string, name: string, pinnable = true) {
    if (e.button !== 0) {
        return;
    }
    const startX = e.clientX;
    const startY = e.clientY;
    let started = false;
    let hit: ZoneHit = null;
    const onMove = (ev: MouseEvent) => {
        if (!started) {
            if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DragThresholdPx) {
                return;
            }
            started = true;
        }
        hit = usableHit(kind, zoneAt(ev.clientX, ev.clientY), pinnable);
        setDrag({ kind, id, zone: hit?.zone ?? null, key: hit?.key ?? null, after: hit?.after ?? false, pinnable });
    };
    const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        setDrag(null);
        if (!started) {
            return;
        }
        suppressedClick = id;
        finishDrop(kind, id, hit, name);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
}

// The blocks under ref carrying data-sb-key glide from where they were to where a new order puts them (first, last,
// invert, play). Their places are read after every render, so a resize in between never makes them jump; a render that
// keeps the order reads them in the next frame's animation callback, never in the commit: a burst of renders (Clear's
// closes, #1253) costs at most one layout a frame instead of one a render.
export function useGlide(ref: React.RefObject<HTMLElement>, order: string) {
    const rects = useRef(new Map<string, DOMRect>());
    const lastOrder = useRef(order);
    const frame = useRef<number>(null);
    useLayoutEffect(() => () => cancelAnimationFrame(frame.current), []);
    useLayoutEffect(() => {
        const root = ref.current;
        const readRects = () => {
            const next = new Map<string, DOMRect>();
            for (const el of Array.from(root?.querySelectorAll<HTMLElement>(`[${KeyAttr}]`) ?? [])) {
                next.set(el.getAttribute(KeyAttr), el.getBoundingClientRect());
            }
            rects.current = next;
        };
        if (order === lastOrder.current) {
            if (frame.current == null) {
                frame.current = requestAnimationFrame(() => {
                    frame.current = null;
                    readRects();
                });
            }
            return;
        }
        cancelAnimationFrame(frame.current);
        frame.current = null;
        const els = Array.from(root?.querySelectorAll<HTMLElement>(`[${KeyAttr}]`) ?? []);
        const next = new Map<string, DOMRect>();
        const moved = !prefersReducedMotion(root?.ownerDocument);
        for (const el of els) {
            const key = el.getAttribute(KeyAttr);
            const rect = el.getBoundingClientRect();
            next.set(key, rect);
            const was = rects.current.get(key);
            if (!moved || was == null) {
                continue;
            }
            const dx = was.left - rect.left;
            const dy = was.top - rect.top;
            if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
                continue;
            }
            el.style.transition = "none";
            el.style.transform = `translate(${dx}px, ${dy}px)`;
            void el.getBoundingClientRect();
            el.style.transition = "";
            el.classList.add(MotionClass.move);
            el.addEventListener("transitionend", () => el.classList.remove(MotionClass.move), { once: true });
            el.style.transform = "";
        }
        lastOrder.current = order;
        rects.current = next;
    });
}
