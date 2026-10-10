// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    railGroupMenu,
    railNavIndex,
    railTabStop,
    RailTrayDwellMs,
    RailTrayModel,
    RailTrayWarmMs,
    railWorkspaceMenu,
    RailWorkspaceMenu,
    trayArrowIndex,
} from "./rail-tray-model";

beforeEach(() => {
    vi.useFakeTimers();
    RailTrayModel.resetInstance();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("the tray's one state (FR-SHELL-045-AC1, AC4, DS-SHELL-081)", () => {
    it("opens after the pointer rests 250 ms on an item, not before, and not when it left", () => {
        const model = RailTrayModel.getInstance();
        model.pointerEnter("a", 10_000);
        vi.advanceTimersByTime(RailTrayDwellMs - 1);
        expect(model.getOpen()).toBeNull();
        vi.advanceTimersByTime(1);
        expect(model.getOpen()).toEqual({ key: "a", via: "pointer" });

        model.pointerLeave("a", 20_000);
        model.pointerEnter("b", 30_000);
        model.pointerLeave("b", 30_100);
        vi.advanceTimersByTime(RailTrayDwellMs);
        expect(model.getOpen()).toBeNull();
    });

    it("hands over to the next item at once, and never keeps two open", () => {
        const model = RailTrayModel.getInstance();
        model.open("a", "pointer");
        model.pointerLeave("a", 1000);
        expect(model.getOpen()).toBeNull();
        model.pointerEnter("b", 1000 + RailTrayWarmMs - 1);
        expect(model.getOpen()).toEqual({ key: "b", via: "pointer" });
        model.focusEnter("c");
        expect(model.getOpen()).toEqual({ key: "c", via: "keyboard" });
        // The pointer leaving b, whose tray is no longer open, changes nothing.
        model.pointerLeave("b");
        expect(model.getOpen()?.key).toBe("c");
    });

    it("folds on Escape and stays folded on that item until it is left, the #390 bug", () => {
        const model = RailTrayModel.getInstance();
        model.focusEnter("a");
        expect(model.escape()).toBe("a");
        expect(model.getOpen()).toBeNull();
        // The focus goes back to the item: it does not open again.
        model.focusEnter("a");
        model.pointerEnter("a");
        vi.advanceTimersByTime(RailTrayDwellMs);
        expect(model.getOpen()).toBeNull();
        // Another item opens its own.
        model.focusLeave("a");
        model.focusEnter("b");
        expect(model.getOpen()?.key).toBe("b");
        model.escape();
        model.pointerLeave("b");
        model.pointerEnter("b", 100_000);
        vi.advanceTimersByTime(RailTrayDwellMs);
        expect(model.getOpen()?.key).toBe("b");
        expect(model.escape()).toBe("b");
        expect(model.escape()).toBeNull();
    });

    it("keeps a pointer tray when the focus leaves it and a keyboard tray when the pointer does", () => {
        const model = RailTrayModel.getInstance();
        model.open("a", "pointer");
        model.focusLeave("a");
        expect(model.getOpen()?.key).toBe("a");
        model.open("a", "keyboard");
        model.pointerLeave("a");
        expect(model.getOpen()?.key).toBe("a");
        model.focusLeave("a");
        expect(model.getOpen()).toBeNull();
    });

    it("stays open while its More menu is, and closes on everything that leaves the rail", () => {
        const model = RailTrayModel.getInstance();
        model.open("a", "pointer");
        model.pin("a");
        model.pointerLeave("a");
        model.fold("a");
        expect(model.escape()).toBeNull();
        expect(model.getOpen()?.key).toBe("a");
        model.unpin("a");
        model.fold("a");
        expect(model.getOpen()).toBeNull();

        model.open("a", "keyboard");
        model.pin("a");
        model.closeAll();
        expect(model.getOpen()).toBeNull();
        expect(model.pinnedKey).toBeNull();
    });

    it("opens nothing under the pointer during a drag, and closes what was open when it starts", () => {
        const model = RailTrayModel.getInstance();
        model.open("a", "pointer");
        model.pointerEnter("b");
        model.setDragging(true);
        expect(model.getOpen()).toBeNull();
        model.pointerEnter("c");
        vi.advanceTimersByTime(RailTrayDwellMs);
        expect(model.getOpen()).toBeNull();
        model.setDragging(false);
        model.pointerEnter("c", 100_000);
        vi.advanceTimersByTime(RailTrayDwellMs);
        expect(model.getOpen()?.key).toBe("c");
    });
});

describe("the rail's keyboard (FR-SHELL-045-AC5, DS-SHELL-081)", () => {
    it("moves between the item and its tray's buttons with Left and Right, the ends staying put", () => {
        expect(trayArrowIndex(0, "ArrowRight", 2)).toBe(1);
        expect(trayArrowIndex(1, "ArrowRight", 2)).toBe(2);
        expect(trayArrowIndex(2, "ArrowRight", 2)).toBe(2);
        expect(trayArrowIndex(2, "ArrowLeft", 2)).toBe(1);
        expect(trayArrowIndex(0, "ArrowLeft", 2)).toBe(0);
        expect(trayArrowIndex(1, "Enter", 2)).toBe(1);
    });

    it("walks the items with Up, Down, Home and End", () => {
        expect(railNavIndex(1, "ArrowUp", 4)).toBe(0);
        expect(railNavIndex(0, "ArrowUp", 4)).toBe(0);
        expect(railNavIndex(2, "ArrowDown", 4)).toBe(3);
        expect(railNavIndex(3, "ArrowDown", 4)).toBe(3);
        expect(railNavIndex(2, "Home", 4)).toBe(0);
        expect(railNavIndex(0, "End", 4)).toBe(3);
        expect(railNavIndex(0, "ArrowRight", 4)).toBeNull();
        expect(railNavIndex(0, "ArrowDown", 0)).toBeNull();
    });

    it("keeps one tab stop: the item last focused, else the active one, else the first", () => {
        expect(railTabStop(["a", "b", "c"], "c", "b")).toBe("c");
        expect(railTabStop(["a", "b", "c"], "gone", "b")).toBe("b");
        expect(railTabStop(["a", "b", "c"], null, "gone")).toBe("a");
        expect(railTabStop([], null, null)).toBeNull();
    });
});

describe("More (FR-SHELL-045-AC2, DS-SHELL-081)", () => {
    const base = (): RailWorkspaceMenu => ({
        onEdit: vi.fn(),
        coffee: { label: "Keep the Mac awake while it works", on: false, onToggle: vi.fn() },
        group: { connecting: false, onGroupWith: vi.fn() },
        onProjectTab: vi.fn(),
        onReset: vi.fn(),
        remove: { enabled: true, reason: "The only workspace: reset it instead", onDelete: vi.fn() },
    });
    const labels = (items: ContextMenuItem[]) => items.map((i) => (i.type === "separator" ? "—" : i.label));

    it("lists Edit, the coffee, Group with…, the Project tab, then Reset… and Delete…, destructive last", () => {
        const items = railWorkspaceMenu(base());
        expect(labels(items)).toEqual([
            "Edit workspace…",
            "—",
            "Keep the Mac awake while it works",
            "Group with…",
            "Open Project tab",
            "—",
            "Reset workspace…",
            "Delete workspace…",
        ]);
        expect(items[2]).toMatchObject({ type: "checkbox", checked: false });
        expect(items[items.length - 1]).toMatchObject({ destructive: true, enabled: true, sublabel: undefined });
    });

    it("checks the coffee while on, offers Stop grouping in connect mode and Remove from group for a member", () => {
        const menu = base();
        menu.coffee.on = true;
        menu.group = { connecting: true, onGroupWith: vi.fn(), onRemove: vi.fn() };
        const items = railWorkspaceMenu(menu);
        expect(items[2]).toMatchObject({ type: "checkbox", checked: true });
        expect(labels(items)).toContain("Stop grouping");
        expect(labels(items).indexOf("Remove from group")).toBe(labels(items).indexOf("Stop grouping") + 1);
    });

    it("leaves out what does not apply and disables the last workspace's delete with its reason", () => {
        const menu = base();
        menu.coffee = undefined;
        menu.group = undefined;
        menu.onProjectTab = undefined;
        menu.remove.enabled = false;
        const items = railWorkspaceMenu(menu);
        expect(labels(items)).toEqual(["Edit workspace…", "—", "Reset workspace…", "Delete workspace…"]);
        expect(items[3]).toMatchObject({ enabled: false, sublabel: "The only workspace: reset it instead" });
    });

    it("gives a group Expand or Collapse, and a local group its own actions", () => {
        expect(labels(railGroupMenu({ collapsed: true, onToggle: vi.fn() }))).toEqual(["Expand"]);
        const local = { connecting: false, onGroupWith: vi.fn(), onRename: vi.fn(), onUngroup: vi.fn() };
        expect(labels(railGroupMenu({ collapsed: false, onToggle: vi.fn(), local }))).toEqual([
            "Collapse",
            "—",
            "Add workspaces…",
            "Rename group…",
            "Ungroup",
        ]);
    });
});
