// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { GroupMemberState, ProjectGroup } from "./mission/group-model";
import {
    applyGroupedMove,
    makeRailUnits,
    memberMoves,
    memberStateText,
    normalizeOrder,
    productHoverText,
    productIconEntry,
    productKeysOf,
    RailProductUnit,
    unitMoves,
    unitSlotMove,
} from "./rail-groups";
import { WorkspaceRailEntry } from "./workspace-rail-model";

function entry(id: string, extra: Partial<WorkspaceRailEntry> = {}): WorkspaceRailEntry {
    return { id, name: id.toUpperCase(), icon: "x", color: "", saved: true, active: false, open: false, ...extra };
}

function member(name: string, ids: string[], state: GroupMemberState = {}) {
    return { dir: `/r/${name}`, name, group: "Notulia", workspaces: ids.map((id) => ({ id })), state };
}

const notulia: ProjectGroup = {
    key: "notulia",
    name: "Notulia",
    members: [member("notulia-website", ["site"], { worst: "amber" }), member("Notulia", ["app"], { worst: "red" })],
    worst: "red",
};
const lone: ProjectGroup = { key: "lone", name: "Lone", members: [member("Lone", ["lone"])] };
const groups = [notulia, lone];

// Rail: solo, site, x, app, lone
const entries = [entry("solo"), entry("site"), entry("x"), entry("app"), entry("lone")];

function product(units = makeRailUnits(entries, groups)): RailProductUnit {
    return units.find((u) => u.kind === "product") as RailProductUnit;
}

describe("makeRailUnits", () => {
    it("gathers a product where its first workspace sits, and leaves a single-member group alone", () => {
        const units = makeRailUnits(entries, groups);
        expect(units.map((u) => u.id)).toEqual(["solo", "product:notulia", "x", "lone"]);
        expect(product(units).entries.map((e) => e.id)).toEqual(["site", "app"]);
    });

    it("is the plain list without groups", () => {
        expect(makeRailUnits(entries, []).map((u) => u.id)).toEqual(["solo", "site", "x", "app", "lone"]);
    });

    it("keeps an unsaved workspace out of a product", () => {
        const units = makeRailUnits([entry("site", { saved: false }), entry("app")], groups);
        expect(units.map((u) => u.id)).toEqual(["site", "product:notulia"]);
    });
});

describe("productKeysOf", () => {
    it("maps only products of two members or more", () => {
        expect([...productKeysOf(groups).entries()]).toEqual([
            ["site", "notulia"],
            ["app", "notulia"],
        ]);
    });
});

describe("moves", () => {
    const units = makeRailUnits(entries, groups);

    it("moves a plain workspace past a whole product", () => {
        expect(unitMoves(units, "x")).toEqual({
            up: { workspaceid: "x", targetid: "site", place: "before" },
            down: { workspaceid: "x", targetid: "lone", place: "after" },
        });
        expect(unitMoves(units, "solo").down).toEqual({ workspaceid: "solo", targetid: "app", place: "after" });
        expect(unitMoves(units, "solo").up).toBeNull();
    });

    it("moves a product as a block", () => {
        expect(unitMoves(units, "product:notulia")).toEqual({
            up: { workspaceid: "site", targetid: "solo", place: "before", block: true },
            down: { workspaceid: "site", targetid: "x", place: "after", block: true },
        });
    });

    it("moves a member within its product only", () => {
        expect(memberMoves(product(units), "site")).toEqual({
            up: null,
            down: { workspaceid: "site", targetid: "app", place: "after" },
        });
        expect(memberMoves(product(units), "app").down).toBeNull();
    });

    it("drops a unit at a slot among the others", () => {
        expect(unitSlotMove(units, "product:notulia", 0)).toEqual({
            workspaceid: "site",
            targetid: "solo",
            place: "before",
            block: true,
        });
        expect(unitSlotMove(units, "product:notulia", 1)).toBeNull();
        expect(unitSlotMove(units, "lone", 2)).toEqual({ workspaceid: "lone", targetid: "app", place: "after" });
    });
});

describe("applyGroupedMove", () => {
    const keys = productKeysOf(groups);
    const ids = ["solo", "site", "app", "x", "lone"];

    it("applies what the server applies", () => {
        expect(
            applyGroupedMove(ids, keys, { workspaceid: "site", targetid: "lone", place: "after", block: true })
        ).toEqual(["solo", "x", "lone", "site", "app"]);
        expect(applyGroupedMove(ids, keys, { workspaceid: "app", targetid: "site", place: "before" })).toEqual([
            "solo",
            "app",
            "site",
            "x",
            "lone",
        ]);
        expect(applyGroupedMove(ids, keys, { workspaceid: "x", targetid: "site", place: "before" })).toEqual([
            "solo",
            "x",
            "site",
            "app",
            "lone",
        ]);
    });

    it("leaves the order alone for a move the server refuses", () => {
        expect(applyGroupedMove(ids, keys, { workspaceid: "site", targetid: "x", place: "after" })).toBe(ids);
        expect(applyGroupedMove(ids, keys, { workspaceid: "x", targetid: "site", place: "after" })).toBe(ids);
        expect(applyGroupedMove(ids, keys, { workspaceid: "site", targetid: "app", place: "after", block: true })).toBe(
            ids
        );
    });

    it("normalizes an interleaved order", () => {
        expect(normalizeOrder(["site", "solo", "app"], keys)).toEqual(["site", "app", "solo"]);
    });
});

describe("product icon and hover", () => {
    it("takes the member named like the group, else the first member", () => {
        expect(productIconEntry(product()).id).toBe("app");
        const renamed = { ...notulia, name: "Product" };
        expect(productIconEntry(product(makeRailUnits(entries, [renamed]))).id).toBe("site");
    });

    it("lists the workspaces and their state", () => {
        const unit = product(
            makeRailUnits(entries, [
                {
                    ...notulia,
                    members: [
                        member("notulia-website", ["site"], {
                            deps: [{ index: 0, project: "Notulia", paths: [], output: [], state: "stale" }],
                            worst: "amber",
                        }),
                        member("Notulia", ["app"], { trunk: "develop", trunkci: "failure", worst: "red" }),
                    ],
                },
            ])
        );
        expect(productHoverText(unit)).toBe(
            "Notulia\nSITE: stale dependency on Notulia\nAPP: local CI failed on develop"
        );
    });

    it("says what each state is", () => {
        expect(memberStateText({ collectedat: 1, trunkci: "success" })).toBe("OK");
        expect(memberStateText({ build: "running", collectedat: 1 })).toBe("running");
        expect(memberStateText({ build: "failure", remoteci: "failure", trunk: "main" })).toBe(
            "GitHub CI failed on main, last build failed"
        );
        expect(memberStateText({})).toBe("not read yet");
        expect(memberStateText({ missing: true })).toBe("folder missing");
    });
});
