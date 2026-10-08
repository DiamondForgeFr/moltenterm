// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Dragging a rail item to reorder the workspaces (FR-MC-031, DS-MC-025). A press is a click until the pointer moved
// past the threshold; from then on the item follows the pointer, a line shows where it lands and the rail scrolls near
// its edges. Only the item's own button starts a drag: the pencil is a sibling button (#354).
// Product groups (FR-MC-027, DS-MC-018): what drags and where it may land is a scope. A rail unit (a workspace, or a
// whole product as a block) drops among the other units; a product's workspace drops among its siblings only, and past
// its product there is no drop target.
// Local groups (FR-MC-032): a local member past its group lands among the rail's units (the scope's outer scope) and
// leaves the group. In connect mode the target's box is a join zone: a workspace released over it joins it, and the
// drop line gives way to the target's "drop to group" mark.

import { useCallback, useEffect, useRef, useState } from "react";
import { RailMove } from "./workspace-order";
import { autoScrollStep, dropLineY, dropSlot, passedDragThreshold, RailItemBox } from "./workspace-rail-drag";

export type RailDragView = {
    id: string;
    // How far the item is drawn from its place, in px.
    offsetY: number;
    // The drop line, in the rail's content coordinates; null when the item would land where it is, or nowhere.
    lineY: number;
    // Over the connect target's box: a release joins it.
    joining: boolean;
    // The line is among the rail's units, out of the item's group.
    outer: boolean;
};

export type RailDragScope = {
    // What the dragged item drops among, itself included, in rail order.
    ids: string[];
    // The element that holds an item, whose box the drop slots are read from.
    element: (nav: HTMLElement, id: string) => HTMLElement;
    // The move for a slot among the others (0 = before all of them); null when it would not move.
    moveFor: (slot: number) => RailMove;
    // Past the first and the last item there is no drop target (a product's workspace stays in its product)...
    bounded: boolean;
    // ...unless the pointer is past them into this scope (a local member leaving its group).
    outer?: RailDragScope;
};

export type RailDragJoin = {
    // The connect target's box for a dragged item that may join it; null when it may not (FR-MC-032-AC3).
    zone: (id: string) => HTMLElement;
    onJoin: (id: string) => void;
};

// Past a bounded scope by more than this, the pointer is outside it.
const BoundedScopeMarginPx = 6;

type Session = {
    id: string;
    pointerId: number;
    button: HTMLElement;
    startY: number;
    lastY: number;
    startScroll: number;
    started: boolean;
    // Escape ends the drag, but the button is still pressed: its release must not switch workspace.
    cancelled: boolean;
    // null when the pointer is outside a bounded scope.
    slot: number;
    // The slot is in the scope's outer scope.
    outer: boolean;
    joining: boolean;
    // The offset of the last view, the one the item is drawn at.
    drawnOffset: number;
    frame: number;
};

// The dragged item is drawn offsetY away from its place; its box is read back at its place, so a bounded scope keeps
// the dragged item's own slot inside it (a local member leaves its group only past it, #368).
function readBoxes(nav: HTMLElement, scope: RailDragScope, draggedId: string, offsetY: number): RailItemBox[] {
    const boxes: RailItemBox[] = [];
    for (const id of scope.ids) {
        const el = scope.element(nav, id);
        if (el == null) {
            continue;
        }
        const rect = el.getBoundingClientRect();
        const shift = id === draggedId ? offsetY : 0;
        boxes.push({ id, top: rect.top - shift, bottom: rect.bottom - shift });
    }
    return boxes;
}

// The slot the pointer is over, or null outside a bounded scope.
export function scopeSlot(boxes: RailItemBox[], bounded: boolean, id: string, y: number): number {
    if (bounded && boxes.length > 0) {
        const top = boxes[0].top - BoundedScopeMarginPx;
        const bottom = boxes[boxes.length - 1].bottom + BoundedScopeMarginPx;
        if (y < top || y > bottom) {
            return null;
        }
    }
    return dropSlot(boxes, id, y);
}

// Whether the pointer is over the join zone: the target's whole box, not the gaps between items.
export function overJoinZone(rect: { top: number; bottom: number }, y: number): boolean {
    return rect != null && y >= rect.top && y <= rect.bottom;
}

export function useRailDrag(
    navRef: React.RefObject<HTMLElement>,
    scopeOf: (id: string) => RailDragScope,
    onMove: (move: RailMove) => void,
    join?: RailDragJoin,
    onDragging?: (dragging: boolean) => void
) {
    const [view, setView] = useState<RailDragView>(null);
    const joinRef = useRef(join);
    joinRef.current = join;
    const onDraggingRef = useRef(onDragging);
    onDraggingRef.current = onDragging;
    const sessionRef = useRef<Session>(null);
    const suppressedClickRef = useRef<string>(null);
    const scopeOfRef = useRef(scopeOf);
    scopeOfRef.current = scopeOf;
    const onMoveRef = useRef(onMove);
    onMoveRef.current = onMove;

    const update = useCallback(() => {
        const session = sessionRef.current;
        const nav = navRef.current;
        if (session == null || !session.started || session.cancelled || nav == null) {
            return;
        }
        const scope = scopeOfRef.current(session.id);
        if (scope == null) {
            return;
        }
        const offsetY = session.lastY - session.startY + (nav.scrollTop - session.startScroll);
        const zone = joinRef.current?.zone(session.id);
        session.joining = zone != null && overJoinZone(zone.getBoundingClientRect(), session.lastY);
        if (session.joining) {
            session.slot = null;
            session.drawnOffset = offsetY;
            setView({ id: session.id, offsetY, lineY: null, joining: true, outer: false });
            return;
        }
        let used = scope;
        // The offset the item is drawn at, as last rendered.
        const drawnOffset = session.drawnOffset;
        let boxes = readBoxes(nav, scope, session.id, drawnOffset);
        session.slot = scopeSlot(boxes, scope.bounded, session.id, session.lastY);
        session.outer = false;
        if (session.slot == null && scope.outer != null) {
            used = scope.outer;
            boxes = readBoxes(nav, used, session.id, drawnOffset);
            session.slot = scopeSlot(boxes, used.bounded, session.id, session.lastY);
            session.outer = true;
        }
        const navRect = nav.getBoundingClientRect();
        const lands = session.slot != null && used.moveFor(session.slot) != null;
        const lineViewportY = lands ? dropLineY(boxes, session.id, session.slot) : null;
        session.drawnOffset = offsetY;
        setView({
            id: session.id,
            offsetY,
            lineY: lineViewportY == null ? null : lineViewportY - navRect.top + nav.scrollTop,
            joining: false,
            outer: session.outer,
        });
    }, [navRef]);

    const scrollFrame = useCallback(() => {
        const session = sessionRef.current;
        const nav = navRef.current;
        if (session == null || !session.started || session.cancelled || nav == null) {
            return;
        }
        const rect = nav.getBoundingClientRect();
        const step = autoScrollStep(session.lastY, rect.top, rect.bottom);
        if (step !== 0) {
            const before = nav.scrollTop;
            nav.scrollTop = before + step;
            if (nav.scrollTop !== before) {
                update();
            }
        }
        session.frame = requestAnimationFrame(scrollFrame);
    }, [navRef, update]);

    const stopListening = useRef<() => void>(null);

    const end = useCallback((drop: boolean) => {
        const session = sessionRef.current;
        sessionRef.current = null;
        stopListening.current?.();
        if (session == null) {
            return;
        }
        cancelAnimationFrame(session.frame);
        if (session.started) {
            onDraggingRef.current?.(false);
            try {
                session.button.releasePointerCapture(session.pointerId);
            } catch {
                // The capture is already gone when the pointer was lost.
            }
            // The click that ends a drag lands on the item: it must not switch workspace.
            suppressedClickRef.current = session.id;
            setTimeout(() => {
                if (suppressedClickRef.current === session.id) {
                    suppressedClickRef.current = null;
                }
            }, 0);
        }
        setView(null);
        if (!drop || !session.started || session.cancelled) {
            return;
        }
        if (session.joining) {
            joinRef.current?.onJoin(session.id);
            return;
        }
        if (session.slot == null) {
            return;
        }
        const scope = scopeOfRef.current(session.id);
        const move = (session.outer ? scope?.outer : scope)?.moveFor(session.slot);
        if (move != null) {
            onMoveRef.current(move);
        }
    }, []);

    const cancel = useCallback(() => {
        const session = sessionRef.current;
        if (session == null || !session.started) {
            end(false);
            return;
        }
        session.cancelled = true;
        cancelAnimationFrame(session.frame);
        setView(null);
    }, [end]);

    const onPointerDown = useCallback(
        (e: React.PointerEvent<HTMLElement>, id: string) => {
            if (e.button !== 0 || e.pointerType === "touch" || navRef.current == null) {
                return;
            }
            if (!scopeOfRef.current(id)?.ids.includes(id)) {
                return;
            }
            end(false);
            const session: Session = {
                id,
                pointerId: e.pointerId,
                button: e.currentTarget,
                startY: e.clientY,
                lastY: e.clientY,
                startScroll: navRef.current.scrollTop,
                started: false,
                cancelled: false,
                slot: null,
                outer: false,
                joining: false,
                drawnOffset: 0,
                frame: 0,
            };
            sessionRef.current = session;
            const onPointerMove = (ev: PointerEvent) => {
                if (ev.pointerId !== session.pointerId) {
                    return;
                }
                // A release the document never saw (over a webview, outside the window) ends the drag, as in the tab
                // bar (#81).
                if (ev.buttons === 0) {
                    end(true);
                    return;
                }
                session.lastY = ev.clientY;
                if (session.cancelled) {
                    return;
                }
                if (!session.started) {
                    if (!passedDragThreshold(session.startY, ev.clientY)) {
                        return;
                    }
                    session.started = true;
                    onDraggingRef.current?.(true);
                    try {
                        session.button.setPointerCapture(session.pointerId);
                    } catch {
                        // Without the capture the document still sees the moves and the release.
                    }
                    session.frame = requestAnimationFrame(scrollFrame);
                }
                update();
            };
            const onPointerUp = (ev: PointerEvent) => {
                if (ev.pointerId === session.pointerId) {
                    end(true);
                }
            };
            const onPointerCancel = (ev: PointerEvent) => {
                if (ev.pointerId === session.pointerId) {
                    end(false);
                }
            };
            const onKeyDown = (ev: KeyboardEvent) => {
                if (ev.key !== "Escape" || !session.started) {
                    return;
                }
                ev.preventDefault();
                ev.stopPropagation();
                cancel();
            };
            const onBlur = () => end(false);
            document.addEventListener("pointermove", onPointerMove);
            document.addEventListener("pointerup", onPointerUp);
            document.addEventListener("pointercancel", onPointerCancel);
            document.addEventListener("keydown", onKeyDown, true);
            window.addEventListener("blur", onBlur);
            stopListening.current = () => {
                document.removeEventListener("pointermove", onPointerMove);
                document.removeEventListener("pointerup", onPointerUp);
                document.removeEventListener("pointercancel", onPointerCancel);
                document.removeEventListener("keydown", onKeyDown, true);
                window.removeEventListener("blur", onBlur);
                stopListening.current = null;
            };
        },
        [navRef, end, cancel, update, scrollFrame]
    );

    useEffect(() => () => end(false), [end]);

    // True once for the click that ends a drag on this item.
    const takeSuppressedClick = useCallback((id: string) => {
        if (suppressedClickRef.current !== id) {
            return false;
        }
        suppressedClickRef.current = null;
        return true;
    }, []);

    return { view, onPointerDown, takeSuppressedClick };
}
