// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { ProjectGroup } from "./mission/group-model";
import {
    applyGroupedMove,
    leaveSlotMove,
    makeRailUnits,
    productHoverText,
    RailProductUnit,
    railUnitKeys,
    unitMoves,
    worstOf,
} from "./rail-groups";
import {
    cleanGroupName,
    effectiveLocalGroups,
    groupWithChoices,
    localGroupName,
    localKey,
    projectGroupRefusal,
    readLocalGroups,
} from "./rail-local-groups";
import { WorkspaceRailEntry } from "./workspace-rail-model";

function entry(id: string, extra: Partial<WorkspaceRailEntry> = {}): WorkspaceRailEntry {
    return { id, name: id.toUpperCase(), icon: "x", color: "", saved: true, active: false, open: false, ...extra };
}

function member(name: string, ids: string[], worst: "" | "red" | "amber" = "") {
    const state = { worst, build: worst === "red" ? "failure" : "" };
    return { dir: `/r/${name}`, name, group: "Notulia", workspaces: ids.map((id) => ({ id })), state };
}

const notulia: ProjectGroup = {
    key: "notulia",
    name: "Notulia",
    members: [member("App", ["app"]), member("Site", ["site"], "amber")],
    worst: "amber",
};
// A linked project in a group of one: Mission Control knows its state, the rail shows no product for it.
const solo: ProjectGroup = { key: "solo", name: "Solo", members: [member("D", ["d"], "red")] };
const groups = [notulia, solo];
const productKeys = new Map([
    ["app", "notulia"],
    ["site", "notulia"],
]);
// Rail: a, b, c, d, app, site.
const saved = ["a", "b", "c", "d", "app", "site"];
const names = (id: string) => id.toUpperCase();

describe("stored local groups (FR-MC-032, DS-MC-028)", () => {
    it("reads what wavesrv stores, dropping junk", () => {
        expect(
            readLocalGroups([
                { id: "g", name: "Clients", members: ["b", "d", 3] },
                { id: "", members: ["a"] },
                "junk",
                { id: "h", members: "x" },
            ])
        ).toEqual([
            { id: "g", name: "Clients", members: ["b", "d"] },
            { id: "h", name: "", members: [] },
        ]);
        expect(readLocalGroups(null)).toEqual([]);
    });

    it("draws them as the server keeps them: project groups win, groups of one dissolve, rail order", () => {
        const stored = [
            { id: "g", members: ["d", "gone", "b", "site"] },
            { id: "g", members: ["a", "c"] },
            { id: "h", members: ["b", "c", "a"] },
            { id: "i", members: ["app", "c"] },
        ];
        expect(effectiveLocalGroups(stored, saved, productKeys)).toEqual([
            { id: "g", name: "", members: ["b", "d"] },
            { id: "h", name: "", members: ["a", "c"] },
        ]);
    });

    it("is named after its first member until renamed", () => {
        expect(localGroupName({ id: "g", members: ["b", "d"] }, names)).toBe("B");
        expect(localGroupName({ id: "g", name: "Clients", members: ["b", "d"] }, names)).toBe("Clients");
    });

    it("trims a name, keeps 1 to 64 characters, and an empty one is the default", () => {
        expect(cleanGroupName("  Clients ")).toBe("Clients");
        expect(cleanGroupName("   ")).toBe("");
        expect(cleanGroupName("é".repeat(64))).toBe("é".repeat(64));
        expect(cleanGroupName("é".repeat(65))).toBeNull();
        expect(cleanGroupName(" Cli\u001b[31ments‮ ")).toBe("Cli[31ments");
    });

    it("offers Group with the other groupable workspaces and the groups it is not in", () => {
        const local = [{ id: "g", members: ["b", "d"] }];
        expect(groupWithChoices("a", saved, productKeys, local, names)).toEqual([
            { id: "g", label: "B (group)", kind: "group" },
            { id: "c", label: "C", kind: "workspace" },
        ]);
        expect(groupWithChoices("b", saved, productKeys, local, names)).toEqual([
            { id: "a", label: "A", kind: "workspace" },
            { id: "c", label: "C", kind: "workspace" },
        ]);
    });

    it("words the refusal of a project group's member", () => {
        expect(projectGroupRefusal("Site", "Notulia")).toBe(
            "Site belongs to Notulia, declared in its project files. Project groups come first."
        );
    });
});

describe("local groups in the rail units (FR-MC-032-AC5)", () => {
    const local = [{ id: "g", name: "", members: ["b", "d"] }];
    const entries = ["a", "b", "c", "d", "app", "site"].map((id) => entry(id));
    // The server keeps a group gathered: the rail reads b, d, then c.
    const gathered = ["a", "b", "d", "c", "app", "site"].map((id) => entry(id));

    it("keys a local member after the project products", () => {
        const keys = railUnitKeys(groups, [{ id: "x", members: ["site", "c"] }, ...local]);
        expect(keys.get("site")).toBe("notulia");
        expect(keys.get("b")).toBe(localKey("g"));
        expect(keys.get("c")).toBe(localKey("x"));
    });

    it("makes a local product named after its first member, with its members' worst state", () => {
        const units = makeRailUnits(entries, groups, local);
        const product = units.find((u) => u.id === "product:" + localKey("g")) as RailProductUnit;
        expect(product.local).toEqual(local[0]);
        expect(product.group.name).toBe("B");
        expect(product.group.worst).toBe("red");
        expect(product.entries.map((e) => e.id)).toEqual(["b", "d"]);
        expect(units.map((u) => u.id)).toEqual(["a", "product:local:g", "c", "product:notulia"]);
        expect(productHoverText(product, groups)).toBe("B\nB\nD: last build failed");
    });

    it("moves a local product as a block", () => {
        const units = makeRailUnits(gathered, groups, local);
        expect(unitMoves(units, "product:local:g").down).toEqual({
            workspaceid: "b",
            targetid: "c",
            place: "after",
            block: true,
        });
    });

    it("takes the worst state, red over amber", () => {
        expect(worstOf([{ worst: "amber" }, null, { worst: "red" }])).toBe("red");
        expect(worstOf([{ worst: "" }, null])).toBe("");
    });
});

describe("leaving a local group by a move (FR-MC-032-AC7)", () => {
    const ids = ["a", "b", "d", "c", "app", "site"];
    const keys = railUnitKeys(groups, [{ id: "g", members: ["b", "d"] }]);

    it("moves within the group", () => {
        expect(applyGroupedMove(ids, keys, { workspaceid: "d", targetid: "b", place: "before" })).toEqual([
            "a",
            "d",
            "b",
            "c",
            "app",
            "site",
        ]);
    });

    it("leaves the group next to a neighbour outside it", () => {
        expect(applyGroupedMove(ids, keys, { workspaceid: "b", targetid: "c", place: "after" })).toEqual([
            "a",
            "d",
            "c",
            "b",
            "app",
            "site",
        ]);
    });

    it("leaves right before or after its own group, named by its id", () => {
        expect(applyGroupedMove(ids, keys, { workspaceid: "d", targetid: "g", place: "before" })).toEqual([
            "a",
            "d",
            "b",
            "c",
            "app",
            "site",
        ]);
        expect(applyGroupedMove(ids, keys, { workspaceid: "b", targetid: "g", place: "after" })).toEqual([
            "a",
            "d",
            "b",
            "c",
            "app",
            "site",
        ]);
    });

    it("never lands between two members of a project product", () => {
        expect(applyGroupedMove(ids, keys, { workspaceid: "b", targetid: "site", place: "before" })).toBe(ids);
    });

    it("drops a member among the units, its own group named by its id", () => {
        const units = makeRailUnits(
            ids.map((id) => entry(id)),
            groups,
            [{ id: "g", members: ["b", "d"] }]
        );
        const own = units.find((u) => u.id === "product:local:g") as RailProductUnit;
        expect(leaveSlotMove(units, own, "d", 0)).toEqual({ workspaceid: "d", targetid: "a", place: "before" });
        expect(leaveSlotMove(units, own, "d", 1)).toEqual({ workspaceid: "d", targetid: "g", place: "before" });
        expect(leaveSlotMove(units, own, "d", 2)).toEqual({ workspaceid: "d", targetid: "c", place: "before" });
        expect(leaveSlotMove(units, own, "d", 9)).toEqual({ workspaceid: "d", targetid: "site", place: "after" });
    });
});
