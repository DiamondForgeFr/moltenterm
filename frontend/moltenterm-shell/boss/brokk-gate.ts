// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The calibration gate (FR-BOSS-009, AC8, #2001): when Brokk may arrive. He never comes under the pointer, so that no
// button moves under the cursor: he waits while the pointer is over the sidebar, for a moment after any gesture in it,
// while its search field has focus, while a menu or a dialog is open, and during quiet hours; and he comes only once the
// pointer has been away for a moment. The two durations are fixed: they protect the pointer, and a setting would only
// serve to break them. Pure and driven by the clock it is handed, so the rules are tested without a wait.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

// After a click, a scroll, a keystroke or a drag in the sidebar.
export const AfterActionMs = 2000;
// After the pointer left the sidebar.
export const AfterLeaveMs = 1000;

export type GateState = {
    pointerIn: boolean;
    // When the pointer last left the sidebar, null when it never has.
    leftAt: number;
    // The last click, scroll, keystroke or end of a drag in the sidebar.
    actedAt: number;
    dragging: boolean;
    searchFocused: boolean;
    // A menu or a dialog is open anywhere in the window.
    overlayOpen: boolean;
};

export const EmptyGate: GateState = {
    pointerIn: false,
    leftAt: null,
    actedAt: null,
    dragging: false,
    searchFocused: false,
    overlayOpen: false,
};

// The surface tells what happens in the sidebar: `act` is a click, a scroll or a keystroke there.
export type GateEvent =
    | { type: "enter" }
    | { type: "leave" }
    | { type: "act" }
    | { type: "dragstart" }
    | { type: "dragend" }
    | { type: "search"; focused: boolean }
    | { type: "overlay"; open: boolean };

export function gateAfter(gate: GateState, event: GateEvent, now: number): GateState {
    switch (event.type) {
        case "enter":
            return gate.pointerIn ? gate : { ...gate, pointerIn: true };
        case "leave":
            return gate.pointerIn ? { ...gate, pointerIn: false, leftAt: now } : gate;
        case "act":
            return { ...gate, actedAt: now };
        case "dragstart":
            return gate.dragging ? gate : { ...gate, dragging: true };
        case "dragend":
            return { ...gate, dragging: false, actedAt: now };
        case "search":
            return gate.searchFocused === event.focused
                ? gate
                : { ...gate, searchFocused: event.focused, actedAt: event.focused ? gate.actedAt : now };
        case "overlay":
            return gate.overlayOpen === event.open ? gate : { ...gate, overlayOpen: event.open };
        default:
            return gate;
    }
}

export type GateHold = "quiet" | "pointer" | "search" | "overlay" | "drag" | "action" | "leaving";

// Why he may not arrive now, or null when he may. The first reason found in this order.
export function gateHold(gate: GateState, quiet: boolean, now: number): GateHold {
    if (quiet) {
        return "quiet";
    }
    if (gate.pointerIn) {
        return "pointer";
    }
    if (gate.searchFocused) {
        return "search";
    }
    if (gate.overlayOpen) {
        return "overlay";
    }
    if (gate.dragging) {
        return "drag";
    }
    if (gate.actedAt != null && now - gate.actedAt < AfterActionMs) {
        return "action";
    }
    if (gate.leftAt != null && now - gate.leftAt < AfterLeaveMs) {
        return "leaving";
    }
    return null;
}

export function mayArriveNow(gate: GateState, quiet: boolean, now: number): boolean {
    return gateHold(gate, quiet, now) == null;
}

// When the gate opens by itself, as time passes: null when it is held by something only an event can end (the pointer,
// the focus, an open menu, a drag), or is open.
export function gateOpensAt(gate: GateState, now: number): number {
    if (gate.pointerIn || gate.searchFocused || gate.overlayOpen || gate.dragging) {
        return null;
    }
    const at = Math.max(
        gate.actedAt == null ? 0 : gate.actedAt + AfterActionMs,
        gate.leftAt == null ? 0 : gate.leftAt + AfterLeaveMs
    );
    return at > now ? at : null;
}
