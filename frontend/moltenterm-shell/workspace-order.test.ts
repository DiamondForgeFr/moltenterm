// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { applyRailMove, neighbourMove, slotMove, sortByOrder } from "./workspace-order";

const ids = ["a", "b", "c", "d"];

describe("neighbourMove (FR-MC-031-AC3)", () => {
    it("moves up before the item above and down after the item below", () => {
        expect(neighbourMove(ids, "c", -1)).toEqual({ workspaceid: "c", targetid: "b", place: "before" });
        expect(neighbourMove(ids, "b", 1)).toEqual({ workspaceid: "b", targetid: "c", place: "after" });
    });

    it("has no move up for the first item, no move down for the last, none for an unknown one", () => {
        expect(neighbourMove(ids, "a", -1)).toBeNull();
        expect(neighbourMove(ids, "d", 1)).toBeNull();
        expect(neighbourMove(ids, "unsaved", 1)).toBeNull();
    });
});

describe("slotMove (FR-MC-031-AC1)", () => {
    it("names a neighbour and a side, never an index", () => {
        expect(slotMove(ids, "d", 1)).toEqual({ workspaceid: "d", targetid: "a", place: "after" });
        expect(slotMove(ids, "c", 0)).toEqual({ workspaceid: "c", targetid: "a", place: "before" });
        expect(slotMove(ids, "a", 3)).toEqual({ workspaceid: "a", targetid: "d", place: "after" });
    });

    it("is null when the item would land where it is", () => {
        expect(slotMove(ids, "b", 1)).toBeNull();
        expect(slotMove(ids, "a", 0)).toBeNull();
        expect(slotMove(ids, "d", 3)).toBeNull();
        expect(slotMove(["a"], "a", 0)).toBeNull();
    });

    it("clamps the slot", () => {
        expect(slotMove(ids, "b", -5)).toEqual({ workspaceid: "b", targetid: "a", place: "before" });
        expect(slotMove(ids, "b", 99)).toEqual({ workspaceid: "b", targetid: "d", place: "after" });
    });
});

describe("applyRailMove", () => {
    it("applies a move as the server does", () => {
        expect(applyRailMove(ids, { workspaceid: "d", targetid: "b", place: "before" })).toEqual(["a", "d", "b", "c"]);
        expect(applyRailMove(ids, { workspaceid: "a", targetid: "d", place: "after" })).toEqual(["b", "c", "d", "a"]);
    });

    it("leaves the order alone for a move it cannot apply", () => {
        expect(applyRailMove(ids, null)).toBe(ids);
        expect(applyRailMove(ids, { workspaceid: "x", targetid: "a", place: "before" })).toBe(ids);
        expect(applyRailMove(ids, { workspaceid: "a", targetid: "x", place: "before" })).toBe(ids);
    });

    it("round-trips every slot through slotMove", () => {
        for (const id of ids) {
            for (let slot = 0; slot < ids.length; slot++) {
                const moved = applyRailMove(ids, slotMove(ids, id, slot));
                expect(moved.indexOf(id)).toBe(slot);
            }
        }
    });
});

describe("sortByOrder", () => {
    it("sorts by the order and keeps the others after, in their own order", () => {
        const items = [{ id: "x" }, { id: "b" }, { id: "y" }, { id: "a" }];
        expect(sortByOrder(items, (i) => i.id, ["a", "b"]).map((i) => i.id)).toEqual(["a", "b", "x", "y"]);
    });
});
