// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Connect mode (FR-MC-032-AC2 to AC4, DS-MC-029): the link bud puts a workspace, or its local group, in connect mode;
// workspaces dragged onto it join it. One target per window, never stored. It ends on Escape, on a press outside the
// target and its buds (the press still does its normal job), on a second click of the link bud, or when the target
// is gone. A press on another rail item may start the drag that brings a workspace in: that one ends connect mode only
// when it turns out to be a click.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import { announceHoldHint } from "./hold-to-confirm";

export const RailConnectHint = "Drag workspaces here to group them · Esc to finish";
export const RailConnectMessageMs = 4000;
const RailConnectDragClickMs = 300;

// A saved workspace not in any group, or a local group (its id).
export type RailConnectTarget = { kind: "workspace" | "group"; id: string };

// What a refused join or a failed group command says, beside the item it concerns.
export type RailConnectMessage = { text: string; anchor: string };

export function sameConnectTarget(a: RailConnectTarget, b: RailConnectTarget): boolean {
    return a != null && b != null && a.kind === b.kind && a.id === b.id;
}

// The element a target is drawn by: its rail item's host (the button and its buds), or its local product's unit.
export function connectTargetSelector(target: RailConnectTarget): string {
    if (target == null) {
        return null;
    }
    if (target.kind === "group") {
        return `[data-rail-local="${CSS.escape(target.id)}"]`;
    }
    return `[data-rail-host="${CSS.escape(target.id)}"]`;
}

export class RailConnectModel {
    private static instance: RailConnectModel = null;

    targetAtom = atom(null) as PrimitiveAtom<RailConnectTarget>;
    messageAtom = atom(null) as PrimitiveAtom<RailConnectMessage>;
    // A drag of a rail item is running: Escape is its cancel, and the click that ends it is no click outside.
    dragging = false;
    dragEndedAt = 0;
    messageTimer: ReturnType<typeof setTimeout> = null;

    private constructor() {}

    static getInstance(): RailConnectModel {
        if (RailConnectModel.instance == null) {
            RailConnectModel.instance = new RailConnectModel();
        }
        return RailConnectModel.instance;
    }

    static resetInstance(): void {
        RailConnectModel.instance = null;
    }

    getTarget(): RailConnectTarget {
        return globalStore.get(this.targetAtom);
    }

    // The link bud: a click enters connect mode on its item, a second one leaves it.
    toggle(target: RailConnectTarget) {
        if (sameConnectTarget(this.getTarget(), target)) {
            this.end();
            return;
        }
        globalStore.set(this.targetAtom, target);
        announceHoldHint(RailConnectHint);
    }

    end() {
        if (this.getTarget() == null) {
            return;
        }
        globalStore.set(this.targetAtom, null);
    }

    showMessage(text: string, anchor: string) {
        clearTimeout(this.messageTimer);
        globalStore.set(this.messageAtom, { text, anchor });
        announceHoldHint(text);
        this.messageTimer = setTimeout(() => globalStore.set(this.messageAtom, null), RailConnectMessageMs);
    }

    setDragging(dragging: boolean) {
        if (this.dragging && !dragging) {
            this.dragEndedAt = Date.now();
        }
        this.dragging = dragging;
    }

    // The click the browser sends right after a drag's release lands on the dragged item: it is not a click outside.
    endedDragJustNow(): boolean {
        return Date.now() - this.dragEndedAt < RailConnectDragClickMs;
    }
}

// Where a press lands, for the exits: inside the target (and its buds), on another rail item (a click or the start of
// a drag), or elsewhere.
export type ConnectPressPlace = "target" | "rail-item" | "outside";

export function connectPressPlace(element: Element, target: RailConnectTarget): ConnectPressPlace {
    const selector = connectTargetSelector(target);
    if (element == null || selector == null) {
        return "outside";
    }
    if (element.closest(selector) != null) {
        return "target";
    }
    if (element.closest("button[data-workspace-id], button[data-rail-product]") != null) {
        return "rail-item";
    }
    return "outside";
}

// Installs the exits of connect mode on the document; returns the uninstall.
export function installConnectExits(model: RailConnectModel): () => void {
    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key !== "Escape" || model.getTarget() == null || model.dragging) {
            return;
        }
        // Escape ends connect mode and nothing else: a terminal must not receive it.
        e.preventDefault();
        e.stopPropagation();
        model.end();
    };
    const onPointerDown = (e: PointerEvent) => {
        const target = model.getTarget();
        if (target == null) {
            return;
        }
        if (connectPressPlace(e.target as Element, target) === "outside") {
            model.end();
        }
    };
    const onClick = (e: MouseEvent) => {
        const target = model.getTarget();
        if (target == null || model.endedDragJustNow()) {
            return;
        }
        if (connectPressPlace(e.target as Element, target) === "rail-item") {
            model.end();
        }
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("click", onClick, true);
    return () => {
        document.removeEventListener("keydown", onKeyDown, true);
        document.removeEventListener("pointerdown", onPointerDown, true);
        document.removeEventListener("click", onClick, true);
    };
}
