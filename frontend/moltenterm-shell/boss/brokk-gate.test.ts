// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
    AfterActionMs,
    AfterLeaveMs,
    EmptyGate,
    gateAfter,
    GateEvent,
    gateHold,
    gateOpensAt,
    GateState,
    mayArriveNow,
} from "./brokk-gate";

// The gate is driven by a clock the test moves by hand: nothing here waits for real time.
const T = 1_000_000;

function after(events: [GateEvent, number][], gate: GateState = EmptyGate): GateState {
    return events.reduce((current, [event, now]) => gateAfter(current, event, now), gate);
}

describe("when Brokk may arrive (FR-BOSS-009, AC8)", () => {
    it("may arrive when nothing happens in the sidebar", () => {
        expect(mayArriveNow(EmptyGate, false, T)).toBe(true);
        expect(gateHold(EmptyGate, false, T)).toBeNull();
    });

    it("may not while the pointer is over the sidebar, however long it stays", () => {
        const gate = after([[{ type: "enter" }, T]]);
        for (const elapsed of [0, AfterLeaveMs, AfterActionMs, 3_600_000]) {
            expect(mayArriveNow(gate, false, T + elapsed), String(elapsed)).toBe(false);
            expect(gateHold(gate, false, T + elapsed)).toBe("pointer");
        }
    });

    it("may arrive 1 s after the pointer left, not before", () => {
        const gate = after([
            [{ type: "enter" }, T],
            [{ type: "leave" }, T + 500],
        ]);
        expect(mayArriveNow(gate, false, T + 500)).toBe(false);
        expect(mayArriveNow(gate, false, T + 500 + AfterLeaveMs - 1)).toBe(false);
        expect(gateHold(gate, false, T + 500 + AfterLeaveMs - 1)).toBe("leaving");
        expect(mayArriveNow(gate, false, T + 500 + AfterLeaveMs)).toBe(true);
    });

    it("may not for 2 s after a click, a scroll or a keystroke, which are all one gesture to it", () => {
        const gate = after([[{ type: "act" }, T]]);
        expect(mayArriveNow(gate, false, T)).toBe(false);
        expect(mayArriveNow(gate, false, T + AfterActionMs - 1)).toBe(false);
        expect(gateHold(gate, false, T + AfterActionMs - 1)).toBe("action");
        expect(mayArriveNow(gate, false, T + AfterActionMs)).toBe(true);
    });

    it("starts the 2 s again at each gesture", () => {
        const gate = after([
            [{ type: "act" }, T],
            [{ type: "act" }, T + 1500],
        ]);
        expect(mayArriveNow(gate, false, T + AfterActionMs)).toBe(false);
        expect(mayArriveNow(gate, false, T + 1500 + AfterActionMs)).toBe(true);
    });

    it("may not during a drag, however long, and for 2 s after it ends", () => {
        const dragging = after([[{ type: "dragstart" }, T]]);
        expect(mayArriveNow(dragging, false, T + 600_000)).toBe(false);
        expect(gateHold(dragging, false, T + 600_000)).toBe("drag");
        const dropped = gateAfter(dragging, { type: "dragend" }, T + 600_000);
        expect(mayArriveNow(dropped, false, T + 600_000 + AfterActionMs - 1)).toBe(false);
        expect(mayArriveNow(dropped, false, T + 600_000 + AfterActionMs)).toBe(true);
    });

    it("may not while the search field has the focus, and 2 s after it lost it", () => {
        const focused = after([[{ type: "search", focused: true }, T]]);
        expect(mayArriveNow(focused, false, T + 600_000)).toBe(false);
        expect(gateHold(focused, false, T + 600_000)).toBe("search");
        const blurred = gateAfter(focused, { type: "search", focused: false }, T + 600_000);
        expect(mayArriveNow(blurred, false, T + 600_000 + AfterActionMs - 1)).toBe(false);
        expect(mayArriveNow(blurred, false, T + 600_000 + AfterActionMs)).toBe(true);
    });

    it("may not while a menu or a dialog is open, and may when it closes", () => {
        const open = after([[{ type: "overlay", open: true }, T]]);
        expect(mayArriveNow(open, false, T + 600_000)).toBe(false);
        expect(gateHold(open, false, T + 600_000)).toBe("overlay");
        expect(mayArriveNow(gateAfter(open, { type: "overlay", open: false }, T + 600_000), false, T + 600_000)).toBe(
            true
        );
    });

    it("may not during quiet hours, whatever the sidebar does", () => {
        expect(mayArriveNow(EmptyGate, true, T)).toBe(false);
        expect(gateHold(EmptyGate, true, T)).toBe("quiet");
    });

    it("may not while the sidebar is not on screen, and may once it shows (FR-BOSS-009, AC14)", () => {
        const hidden = after([[{ type: "hidden", hidden: true }, T]]);
        expect(mayArriveNow(hidden, false, T + 600_000)).toBe(false);
        expect(gateHold(hidden, false, T + 600_000)).toBe("hidden");
        const shown = gateAfter(hidden, { type: "hidden", hidden: false }, T + 600_000);
        expect(mayArriveNow(shown, false, T + 600_000)).toBe(true);
        expect(gateAfter(hidden, { type: "hidden", hidden: true }, T)).toBe(hidden);
    });

    it("holds for the first reason found, but for all of them together", () => {
        const gate = after([
            [{ type: "enter" }, T],
            [{ type: "search", focused: true }, T],
            [{ type: "overlay", open: true }, T],
        ]);
        expect(gateHold(gate, false, T)).toBe("pointer");
        const withoutPointer = gateAfter(gate, { type: "leave" }, T + 10_000);
        expect(gateHold(withoutPointer, false, T + 20_000)).toBe("search");
        const withoutSearch = gateAfter(withoutPointer, { type: "search", focused: false }, T + 20_000);
        expect(gateHold(withoutSearch, false, T + 20_100)).toBe("overlay");
        const closed = gateAfter(withoutSearch, { type: "overlay", open: false }, T + 20_200);
        expect(gateHold(closed, false, T + 20_200)).toBe("action");
        expect(gateHold(closed, false, T + 20_000 + AfterActionMs)).toBeNull();
    });

    it("waits for the later of the two delays when a gesture and a departure overlap", () => {
        const gate = after([
            [{ type: "enter" }, T],
            [{ type: "act" }, T + 100],
            [{ type: "leave" }, T + 200],
        ]);
        expect(mayArriveNow(gate, false, T + 200 + AfterLeaveMs)).toBe(false);
        expect(mayArriveNow(gate, false, T + 100 + AfterActionMs - 1)).toBe(false);
        expect(mayArriveNow(gate, false, T + 100 + AfterActionMs)).toBe(true);
    });

    it("ignores a departure of a pointer that was not in", () => {
        const gate = gateAfter(EmptyGate, { type: "leave" }, T);
        expect(gate).toBe(EmptyGate);
        expect(mayArriveNow(gate, false, T)).toBe(true);
    });

    it("returns the very same state when an event changes nothing", () => {
        const entered = gateAfter(EmptyGate, { type: "enter" }, T);
        expect(gateAfter(entered, { type: "enter" }, T + 1)).toBe(entered);
        const overlay = gateAfter(EmptyGate, { type: "overlay", open: true }, T);
        expect(gateAfter(overlay, { type: "overlay", open: true }, T + 1)).toBe(overlay);
        const dragging = gateAfter(EmptyGate, { type: "dragstart" }, T);
        expect(gateAfter(dragging, { type: "dragstart" }, T + 1)).toBe(dragging);
        expect(gateAfter(EmptyGate, { type: "search", focused: false }, T)).toBe(EmptyGate);
    });
});

describe("when the gate opens by itself", () => {
    it("names the moment a delay ends, and nothing when it is open", () => {
        expect(gateOpensAt(EmptyGate, T)).toBeNull();
        const acted = after([[{ type: "act" }, T]]);
        expect(gateOpensAt(acted, T)).toBe(T + AfterActionMs);
        expect(gateOpensAt(acted, T + AfterActionMs)).toBeNull();
        const left = after([
            [{ type: "enter" }, T],
            [{ type: "leave" }, T + 10],
        ]);
        expect(gateOpensAt(left, T + 10)).toBe(T + 10 + AfterLeaveMs);
    });

    it("names the later of the two delays", () => {
        const gate = after([
            [{ type: "enter" }, T],
            [{ type: "act" }, T + 100],
            [{ type: "leave" }, T + 200],
        ]);
        expect(gateOpensAt(gate, T + 300)).toBe(T + 100 + AfterActionMs);
    });

    it("names nothing while only an event can open it: the pointer, the focus, a menu, a drag", () => {
        for (const event of [
            { type: "enter" },
            { type: "search", focused: true },
            { type: "overlay", open: true },
            { type: "dragstart" },
            { type: "hidden", hidden: true },
        ] as GateEvent[]) {
            expect(gateOpensAt(after([[event, T]]), T), event.type).toBeNull();
        }
    });
});
