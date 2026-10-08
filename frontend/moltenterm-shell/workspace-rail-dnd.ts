// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Dragging a rail item to reorder the workspaces (FR-MC-031, DS-MC-025). A press is a click until the pointer moved
// past the threshold; from then on the item follows the pointer, a line shows where it lands and the rail scrolls near
// its edges. Only the item's own button starts a drag: the pencil is a sibling button (#354).

import { useCallback, useEffect, useRef, useState } from "react";
import { RailMove, slotMove } from "./workspace-order";
import { autoScrollStep, dropLineY, dropSlot, passedDragThreshold, RailItemBox } from "./workspace-rail-drag";

export type RailDragView = {
    id: string;
    // How far the item is drawn from its place, in px.
    offsetY: number;
    // The drop line, in the rail's content coordinates; null when the item would land where it is.
    lineY: number;
};

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
    slot: number;
    frame: number;
};

function readBoxes(nav: HTMLElement, ids: string[]): RailItemBox[] {
    const boxes: RailItemBox[] = [];
    for (const id of ids) {
        const el = nav.querySelector<HTMLElement>(`button[data-workspace-id="${CSS.escape(id)}"]`);
        if (el == null) {
            continue;
        }
        const rect = el.getBoundingClientRect();
        boxes.push({ id, top: rect.top, bottom: rect.bottom });
    }
    return boxes;
}

export function useRailDrag(
    navRef: React.RefObject<HTMLElement>,
    movableIds: string[],
    onMove: (move: RailMove) => void
) {
    const [view, setView] = useState<RailDragView>(null);
    const sessionRef = useRef<Session>(null);
    const suppressedClickRef = useRef<string>(null);
    const idsRef = useRef(movableIds);
    idsRef.current = movableIds;
    const onMoveRef = useRef(onMove);
    onMoveRef.current = onMove;

    const update = useCallback(() => {
        const session = sessionRef.current;
        const nav = navRef.current;
        if (session == null || !session.started || session.cancelled || nav == null) {
            return;
        }
        const ids = idsRef.current;
        const boxes = readBoxes(nav, ids);
        session.slot = dropSlot(boxes, session.id, session.lastY);
        const navRect = nav.getBoundingClientRect();
        const lands = slotMove(ids, session.id, session.slot) != null;
        const lineViewportY = lands ? dropLineY(boxes, session.id, session.slot) : null;
        setView({
            id: session.id,
            offsetY: session.lastY - session.startY + (nav.scrollTop - session.startScroll),
            lineY: lineViewportY == null ? null : lineViewportY - navRect.top + nav.scrollTop,
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
        const move = slotMove(idsRef.current, session.id, session.slot);
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
            if (e.button !== 0 || e.pointerType === "touch" || !idsRef.current.includes(id) || navRef.current == null) {
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
                slot: 0,
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
