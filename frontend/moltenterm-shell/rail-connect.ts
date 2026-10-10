// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Connect mode (FR-MC-032-AC2 to AC4, DS-MC-029): More › Group with… puts a workspace, or its local group, in connect
// mode; a workspace clicked (DS-SHELL-081, #399) or dragged onto the target joins it. One target per window, never
// stored. It ends on Escape, on a press outside the rail's workspaces (the press still does its normal job), on a
// click on a group, on Stop grouping, or when the target is gone. A press on another rail item may start the drag that
// brings a workspace in: a click on a group ends connect mode only when it turns out to be a click.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import { announceHoldHint } from "./hold-to-confirm";

// The banner under the tab bar (DS-SHELL-081); the name is the target's, a workspace's or a group's.
export function railConnectHint(name: string): string {
    return `Click a workspace to group it with ${name || "this workspace"}. Esc to cancel.`;
}

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

    // Group with…: enters connect mode on its item, Stop grouping leaves it.
    toggle(target: RailConnectTarget, name?: string) {
        if (sameConnectTarget(this.getTarget(), target)) {
            this.end();
            return;
        }
        globalStore.set(this.targetAtom, target);
        announceHoldHint(railConnectHint(name));
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

// Where a press lands, for the exits: inside the target (its item and its tray), on another workspace of the rail
// (its click joins it), on a group of the rail (a click or the start of a drag), in a menu, or elsewhere.
export type ConnectPressPlace = "target" | "workspace" | "rail-item" | "menu" | "outside";

export function connectPressPlace(element: Element, target: RailConnectTarget): ConnectPressPlace {
    const selector = connectTargetSelector(target);
    if (element == null || selector == null) {
        return "outside";
    }
    if (element.closest(selector) != null) {
        return "target";
    }
    if (element.closest("[data-rail-host]") != null) {
        return "workspace";
    }
    if (element.closest("button[data-rail-product], [data-rail-tray-host]") != null) {
        return "rail-item";
    }
    if (element.closest(".molten-menu-layer") != null) {
        return "menu";
    }
    return "outside";
}

// A field being edited (the group's rename field) or an open dialog (the edit sheet) takes its own Escape; connect
// mode waits for the next one.
export function escapeBelongsElsewhere(e: Pick<KeyboardEvent, "target">): boolean {
    const el = e.target as HTMLElement;
    if (el?.closest?.("input, textarea, select, [contenteditable=true], [role=dialog]") != null) {
        return el.closest(".xterm") == null;
    }
    return typeof document !== "undefined" && document.querySelector?.("[role=dialog]") != null;
}

// Installs the exits of connect mode on the document; returns the uninstall.
export function installConnectExits(model: RailConnectModel): () => void {
    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key !== "Escape" || model.getTarget() == null || model.dragging || escapeBelongsElsewhere(e)) {
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
