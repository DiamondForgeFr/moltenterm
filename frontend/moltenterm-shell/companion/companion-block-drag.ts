// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Carrying a block with a pointer while arranging (FR-SHELL-018, #2459, #2467). A press on a block's header is a click
// until the pointer moves a few pixels, then the block is carried: it follows the pointer, the others make room as the
// flow places the drafted order (companion-drag-model.ts says which rank the pointer is at), and the drop sets the rank.
// The usage block dropped on the main agent's block is attached; the handle of the usage attached to it carries the
// block out, which detaches it as soon as it is lifted, and Escape puts it back. Escape puts any block back where the drag
// found it. The listeners are the window's, so that a block picked up by a long press, whose first block was replaced by
// the arranging mode's, goes on being carried by the same pointer. Loaded with the arranging mode, out of the startup
// bundle.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useT } from "../i18n/i18n";
import { autoScrollStep } from "../workspace-rail-drag";
import { dropSection, flowEntries, moveRanked, positionOf, setUsageAttached } from "./companion-arrange-model";
import {
    dragCorner,
    dropIndexAt,
    passedDragStart,
    Point,
    pointInBox,
    startsPress,
    ZoneSlackPx,
} from "./companion-drag-model";
import { layoutIdOf } from "./companion-flow-model";
import { CompanionLayout, CompanionSectionId, CompanionSectionIds, usageOf } from "./companion-layout";
import { CloseTipsEvent } from "./companion-tips-model";

// What a long press on a block's icon hands to the arranging mode (#2459): the block it picked up, the pointer that holds
// it, where that pointer is, and where on the block it took hold. `released` says the pointer went up before the mode
// had mounted, so that nothing is carried that nobody holds.
export type Pickup = {
    id: CompanionSectionId;
    pointerId: number;
    x: number;
    y: number;
    grab: Point;
    released: boolean;
};

// What the arranging mode tells the main agent's block about the zone: the drag carries the usage block, over the zone or
// not. Whether the usage shows and is attached is read from the draft.
export type ZoneState = { active: boolean; over: boolean };

export const SectionIdSet = new Set<string>(CompanionSectionIds);

// Where on the usage block a carried one is held when it was lifted out of the main agent's block: near its label.
const DetachGrab: Point = { x: 28, y: 14 };

function scrollParentOf(el: HTMLElement): HTMLElement {
    for (let p = el?.parentElement; p != null; p = p.parentElement) {
        const overflow = getComputedStyle(p).overflowY;
        if ((overflow === "auto" || overflow === "scroll") && p.scrollHeight > p.clientHeight) {
            return p;
        }
    }
    return null;
}

export type BlockDragOptions = {
    arranging: boolean;
    flowRef: React.RefObject<HTMLDivElement>;
    draftRef: React.RefObject<CompanionLayout>;
    setDraft: (layout: CompanionLayout) => void;
    onZone: (zone: Partial<ZoneState>) => void;
    announce: (text: string) => void;
    nameOf: (id: CompanionSectionId) => string;
    pickup: Pickup;
    onPickupDone: () => void;
};

export function useBlockDrag(options: BlockDragOptions) {
    const t = useT();
    const [dragging, setDragging] = useState<CompanionSectionId>(null);
    const stop = useRef<() => void>(null);
    const followRef = useRef<() => void>(null);
    // The block goes under the pointer again once what the drag changed has taken its room (the zone, the slot).
    useLayoutEffect(() => followRef.current?.(), [dragging]);
    const latest = useRef(options);
    latest.current = options;
    const tRef = useRef(t);
    tRef.current = t;
    useEffect(() => () => stop.current?.(), []);

    const arm = useCallback((id: CompanionSectionId, pointerId: number, from: Point, grab: Point, carried: boolean) => {
        stop.current?.();
        const o = () => latest.current;
        const flow = o().flowRef.current;
        if (flow == null) {
            return;
        }
        const blockOf = (blockId: string) => flow.querySelector<HTMLElement>(`:scope > [data-flow-id="${blockId}"]`);
        const snapshot = o().draftRef.current;
        // The usage lifted out of the main agent's block leaves it as it is lifted, not as it is dropped.
        const lifted = id === "usage" && usageOf(snapshot).attached;
        const scroller = scrollParentOf(flow);
        const listeners: [string, EventListener, boolean?][] = [];
        let last = from;
        let begun = false;
        let over = false;
        let frame = 0;
        const setDraft = (next: CompanionLayout) => {
            o().draftRef.current = next;
            o().setDraft(next);
        };
        const follow = () => {
            const el = blockOf(id);
            const f = o().flowRef.current;
            if (el == null || f == null) {
                return;
            }
            const origin = f.getBoundingClientRect();
            const corner = dragCorner({ x: last.x - origin.left, y: last.y - origin.top }, grab);
            el.style.transform = `translate(${corner.x}px, ${corner.y}px)`;
            // The whole main agent's block takes the drop, so that a drop near the zone counts.
            const hero = id === "usage" ? f.closest(".mt-cdash")?.querySelector<HTMLElement>(".mt-cdash-hero") : null;
            const box = hero?.getBoundingClientRect();
            const nowOver =
                box != null &&
                pointInBox(last, { x: box.left, y: box.top, width: box.width, height: box.height }, ZoneSlackPx);
            if (nowOver !== over) {
                over = nowOver;
                o().onZone({ over });
            }
            const width = f.closest<HTMLElement>(".mt-cdash")?.clientWidth ?? 0;
            if (over || width <= 0) {
                return;
            }
            // The blocks the flow lays out, ghosts included, at the height they stand: the slots the pointer chooses
            // from are the ones the flow itself would give.
            const draft = o().draftRef.current;
            const blocks = flowEntries(draft, true)
                .filter((entry) => !entry.tail && blockOf(entry.id) != null)
                .map((entry) => ({
                    id: layoutIdOf(entry.id, blockOf(entry.id).dataset.ghost != null),
                    full: entry.full,
                    height: blockOf(entry.id).offsetHeight,
                }));
            const carried = layoutIdOf(id, el.dataset.ghost != null);
            const rank = dropIndexAt(blocks, carried, width, {
                x: corner.x + el.offsetWidth / 2,
                y: corner.y + el.offsetHeight / 2,
            });
            if (rank >= 0 && rank !== blocks.findIndex((b) => b.id === carried)) {
                setDraft(moveRanked(draft, id, rank));
            }
        };
        const tick = () => {
            frame = requestAnimationFrame(() => {
                const area = scroller?.getBoundingClientRect();
                const step = area == null ? 0 : autoScrollStep(last.y, area.top, area.bottom);
                if (step !== 0) {
                    scroller.scrollTop += step;
                    follow();
                }
                tick();
            });
        };
        const begin = () => {
            begun = true;
            document.dispatchEvent(new Event(CloseTipsEvent));
            const show = () => {
                if (lifted) {
                    setDraft(setUsageAttached(o().draftRef.current, false));
                }
                o().onZone({ active: id === "usage", over: false });
                setDragging(id);
            };
            // The zone takes room in the main agent's block, and a lifted usage block takes its place in the flow: both
            // are there before the block is placed under the pointer. A block picked up by a long press begins in a
            // layout effect, where nothing can be flushed.
            if (carried) {
                show();
            } else {
                flushSync(show);
            }
            o().announce(tRef.current("companion.arrange.picked", { name: o().nameOf(id) }));
            tick();
            follow();
        };
        followRef.current = follow;
        const release = () => {
            followRef.current = null;
            cancelAnimationFrame(frame);
            listeners.forEach(([type, fn, capture]) => window.removeEventListener(type, fn, capture));
            listeners.length = 0;
            stop.current = null;
        };
        const finish = (drop: boolean) => {
            release();
            if (!begun) {
                return;
            }
            // The click that ends a drag is not a click on whatever is under the pointer.
            const eat = (ev: Event) => {
                ev.stopPropagation();
                ev.preventDefault();
            };
            window.addEventListener("click", eat, true);
            setTimeout(() => window.removeEventListener("click", eat, true), 0);
            const name = o().nameOf(id);
            if (!drop) {
                setDraft(snapshot);
                o().announce(tRef.current("companion.arrange.putBack", { name }));
            } else {
                const draft = o().draftRef.current;
                const index = draft.findIndex((p) => p.id === id);
                if (over && id === "usage") {
                    // The rank the usage had before it was lifted is the one it keeps for the day it is detached: the
                    // ranks it passed on its way to the main agent's block were no choice of the developer's.
                    setDraft(dropSection(snapshot, id, { to: "attach" }));
                    o().announce(tRef.current("companion.arrange.attachOn", { name }));
                } else {
                    const dropped = dropSection(draft, id, { to: "list", index });
                    setDraft(dropped);
                    const { position, total } = positionOf(dropped, id);
                    o().announce(
                        lifted
                            ? tRef.current("companion.arrange.attachOff", { name })
                            : tRef.current("companion.arrange.moved", { name, position, total })
                    );
                }
            }
            setDragging(null);
            o().onZone({ active: false, over: false });
        };
        const watch = (type: string, fn: (ev: any) => void, capture?: boolean) => {
            listeners.push([type, fn, capture]);
            window.addEventListener(type, fn, capture);
        };
        watch("pointermove", (ev: PointerEvent) => {
            if (ev.pointerId !== pointerId) {
                return;
            }
            // A button released out of the window never came: nothing is carried that no hand holds.
            if (ev.pointerType === "mouse" && ev.buttons === 0) {
                finish(true);
                return;
            }
            last = { x: ev.clientX, y: ev.clientY };
            if (!begun && passedDragStart(from, last)) {
                begin();
                return;
            }
            if (begun) {
                follow();
            }
        });
        watch("pointerup", (ev: PointerEvent) => ev.pointerId === pointerId && finish(true));
        watch("pointercancel", (ev: PointerEvent) => ev.pointerId === pointerId && finish(false));
        watch(
            "keydown",
            (ev: KeyboardEvent) => {
                if (ev.key === "Escape" && begun) {
                    ev.stopPropagation();
                    ev.preventDefault();
                    finish(false);
                }
            },
            true
        );
        stop.current = release;
        if (carried) {
            begin();
        }
    }, []);

    // A block picked up by a long press: the mode has just mounted, the pointer is still down.
    useLayoutEffect(() => {
        const { pickup, flowRef, onPickupDone, arranging } = latest.current;
        if (pickup == null || !arranging) {
            return;
        }
        onPickupDone();
        const el = flowRef.current?.querySelector<HTMLElement>(`:scope > [data-flow-id="${pickup.id}"]`);
        if (el == null || pickup.released) {
            return;
        }
        const grab = { x: Math.min(pickup.grab.x, Math.max(0, el.offsetWidth - 12)), y: pickup.grab.y };
        arm(pickup.id, pickup.pointerId, { x: pickup.x, y: pickup.y }, grab, true);
    }, [options.pickup, options.arranging]);

    const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
        const target = e.target as Element;
        const block = target.closest<HTMLElement>("[data-flow-id]");
        const id = block?.dataset.flowId;
        // A hidden block's ghost holds no place to carry it from.
        if (
            block == null ||
            !SectionIdSet.has(id) ||
            block.hasAttribute("data-hidden") ||
            !startsPress(e.nativeEvent)
        ) {
            return;
        }
        // Anything of the block holds it but its own controls, which keep their click.
        const control =
            "button:not([data-arrange='handle']), a, input, select, textarea, fieldset, [role='radiogroup']";
        if (target.closest(control) != null) {
            return;
        }
        const box = block.getBoundingClientRect();
        arm(
            id as CompanionSectionId,
            e.pointerId,
            { x: e.clientX, y: e.clientY },
            { x: e.clientX - box.left, y: e.clientY - box.top },
            false
        );
    };

    // The handle of the usage attached to the main agent: a drag from it lifts the usage block out and carries it; a click
    // (the drag did not begin) is the handle's own.
    const onDetachDown = (e: React.PointerEvent<HTMLElement>) => {
        if (!startsPress(e.nativeEvent)) {
            return;
        }
        arm("usage", e.pointerId, { x: e.clientX, y: e.clientY }, DetachGrab, false);
    };
    return { dragging, onPointerDown, onDetachDown };
}
