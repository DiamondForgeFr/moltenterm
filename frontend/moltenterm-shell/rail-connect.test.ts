// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    connectPressPlace,
    connectTargetSelector,
    escapeBelongsElsewhere,
    installConnectExits,
    railConnectHint,
    RailConnectMessageMs,
    RailConnectModel,
    sameConnectTarget,
} from "./rail-connect";
import { overJoinZone } from "./workspace-rail-dnd";

vi.mock("./hold-to-confirm", () => ({ announceHoldHint: vi.fn() }));

// An element that answers closest() for the selectors it matches.
function element(matches: string[]): Element {
    return { closest: (selector: string) => (matches.includes(selector) ? ({} as Element) : null) } as Element;
}

type Listener = (e: Event) => void;

function fakeDocument() {
    const listeners = new Map<string, Listener>();
    return {
        listeners,
        addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
        removeEventListener: (type: string) => listeners.delete(type),
    };
}

beforeEach(() => {
    vi.stubGlobal("CSS", { escape: (s: string) => s });
    RailConnectModel.resetInstance();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe("connect mode (FR-MC-032-AC2, AC4)", () => {
    it("is entered by Group with… and left by Stop grouping; one target per window", () => {
        const model = RailConnectModel.getInstance();
        model.toggle({ kind: "workspace", id: "b" });
        expect(model.getTarget()).toEqual({ kind: "workspace", id: "b" });
        model.toggle({ kind: "group", id: "g" });
        expect(model.getTarget()).toEqual({ kind: "group", id: "g" });
        model.toggle({ kind: "group", id: "g" });
        expect(model.getTarget()).toBeNull();
        expect(railConnectHint("Notulia")).toBe("Click a workspace to group it with Notulia. Esc to cancel.");
    });

    it("compares and finds its target", () => {
        expect(sameConnectTarget({ kind: "workspace", id: "b" }, { kind: "workspace", id: "b" })).toBe(true);
        expect(sameConnectTarget({ kind: "workspace", id: "g" }, { kind: "group", id: "g" })).toBe(false);
        expect(sameConnectTarget(null, null)).toBe(false);
        expect(connectTargetSelector({ kind: "workspace", id: "b" })).toBe('[data-rail-host="b"]');
        expect(connectTargetSelector({ kind: "group", id: "g" })).toBe('[data-rail-local="g"]');
    });

    it("tells a press on the target, another workspace, a group, a menu and elsewhere apart", () => {
        const target = { kind: "workspace" as const, id: "b" };
        expect(connectPressPlace(element(['[data-rail-host="b"]', "[data-rail-host]"]), target)).toBe("target");
        expect(connectPressPlace(element(["[data-rail-host]"]), target)).toBe("workspace");
        expect(connectPressPlace(element(["button[data-rail-product], [data-rail-tray-host]"]), target)).toBe(
            "rail-item"
        );
        expect(connectPressPlace(element([".molten-menu-layer"]), target)).toBe("menu");
        expect(connectPressPlace(element([]), target)).toBe("outside");
        expect(connectPressPlace(null, target)).toBe("outside");
    });

    it("ends on Escape (swallowed), a press outside (not swallowed) or a click on a group, not on a drag", () => {
        const doc = fakeDocument();
        vi.stubGlobal("document", doc);
        const model = RailConnectModel.getInstance();
        const uninstall = installConnectExits(model);
        const target = { kind: "workspace" as const, id: "b" };

        model.toggle(target);
        const escape = { key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() };
        model.setDragging(true);
        doc.listeners.get("keydown")(escape as unknown as Event);
        expect(model.getTarget()).toEqual(target);
        model.setDragging(false);
        doc.listeners.get("keydown")(escape as unknown as Event);
        expect(model.getTarget()).toBeNull();
        expect(escape.stopPropagation).toHaveBeenCalled();

        model.toggle(target);
        const press = { target: element([]), preventDefault: vi.fn(), stopPropagation: vi.fn() };
        doc.listeners.get("pointerdown")(press as unknown as Event);
        expect(model.getTarget()).toBeNull();
        expect(press.preventDefault).not.toHaveBeenCalled();
        expect(press.stopPropagation).not.toHaveBeenCalled();

        model.toggle(target);
        const onGroup = { target: element(["button[data-rail-product], [data-rail-tray-host]"]) };
        doc.listeners.get("pointerdown")(onGroup as unknown as Event);
        expect(model.getTarget()).toEqual(target);
        model.setDragging(true);
        model.setDragging(false);
        doc.listeners.get("click")(onGroup as unknown as Event);
        expect(model.getTarget()).toEqual(target);
        model.dragEndedAt = 0;
        doc.listeners.get("click")(onGroup as unknown as Event);
        expect(model.getTarget()).toBeNull();

        // A click on another workspace is the rail's to handle: it joins it to the target.
        model.toggle(target);
        const onWorkspace = { target: element(["[data-rail-host]"]) };
        doc.listeners.get("pointerdown")(onWorkspace as unknown as Event);
        doc.listeners.get("click")(onWorkspace as unknown as Event);
        expect(model.getTarget()).toEqual(target);

        // More's menu holds Stop grouping.
        doc.listeners.get("pointerdown")({ target: element([".molten-menu-layer"]) } as unknown as Event);
        expect(model.getTarget()).toEqual(target);

        doc.listeners.get("pointerdown")({ target: element(['[data-rail-host="b"]']) } as unknown as Event);
        expect(model.getTarget()).toEqual(target);

        uninstall();
        expect(doc.listeners.size).toBe(0);
    });

    it("shows a message for four seconds", () => {
        vi.useFakeTimers();
        const model = RailConnectModel.getInstance();
        model.showMessage("Site belongs to Notulia", '[data-rail-host="b"]');
        expect(globalStore.get(model.messageAtom)).toEqual({
            text: "Site belongs to Notulia",
            anchor: '[data-rail-host="b"]',
        });
        vi.advanceTimersByTime(RailConnectMessageMs);
        expect(globalStore.get(model.messageAtom)).toBeNull();
    });
});

describe("Escape belongs to a field or a dialog first", () => {
    it("leaves an edited field's or an open dialog's Escape alone, never a terminal's", () => {
        const target = (inField: boolean, inXterm: boolean) =>
            ({
                closest: (selector: string) => ((selector === ".xterm" ? inXterm : inField) ? ({} as Element) : null),
            }) as unknown as EventTarget;
        expect(escapeBelongsElsewhere({ target: target(true, false) })).toBe(true);
        expect(escapeBelongsElsewhere({ target: target(true, true) })).toBe(false);
        vi.stubGlobal("document", { querySelector: () => null });
        expect(escapeBelongsElsewhere({ target: target(false, false) })).toBe(false);
        vi.stubGlobal("document", { querySelector: () => ({}) });
        expect(escapeBelongsElsewhere({ target: target(false, false) })).toBe(true);
    });
});

describe("the join zone (FR-MC-032-AC3, DS-MC-029)", () => {
    it("is the target's whole box, not the gaps around it", () => {
        expect(overJoinZone({ top: 100, bottom: 136 }, 100)).toBe(true);
        expect(overJoinZone({ top: 100, bottom: 136 }, 136)).toBe(true);
        expect(overJoinZone({ top: 100, bottom: 136 }, 98)).toBe(false);
        expect(overJoinZone(null, 120)).toBe(false);
    });
});
