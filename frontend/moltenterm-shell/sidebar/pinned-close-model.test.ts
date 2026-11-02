// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { slotMembers, SlotsMetaKey } from "../hidden-tabs";
import { planPinnedClose } from "./pinned-close-model";
import { GlobalPinMetaKey } from "./view-pins-model";

const Names = ["Desktop", "Website"];

const ws = {
    tabids: ["project", "cadrage1", "a1", "cadrage2", "term1", "term2", "term3"],
    meta: {
        [SlotsMetaKey]: { cadrage1: "sA", cadrage2: "sA" },
    },
};

const metas: Record<string, Record<string, any>> = {
    term1: { [GlobalPinMetaKey]: "g1" },
    term2: { [GlobalPinMetaKey]: "g1" },
    term3: { [GlobalPinMetaKey]: "g2" },
};
const metaOf = (id: string) => metas[id] ?? {};

describe("slotMembers", () => {
    it("lists the instances of a tile's slot in every project, the tab itself included", () => {
        expect(slotMembers(ws, "cadrage1")).toEqual(["cadrage1", "cadrage2"]);
        expect(slotMembers(ws, "cadrage2")).toEqual(["cadrage1", "cadrage2"]);
    });

    it("leaves a tab without a slot alone", () => {
        expect(slotMembers(ws, "a1")).toEqual(["a1"]);
    });
});

describe("closing a pinned view (#1760)", () => {
    it("closes a temporary view as itself, with no confirmation", () => {
        const plan = planPinnedClose(ws, "a1", "temporary", false, metaOf, Names);
        expect(plan).toMatchObject({ tabIds: ["a1"], shared: false, confirm: false });
    });

    it("closes a tile in every project and asks first once the workspace has two projects", () => {
        const plan = planPinnedClose(ws, "cadrage2", "workspace", false, metaOf, Names);
        expect(plan.tabIds).toEqual(["cadrage2", "cadrage1"]);
        expect(plan).toMatchObject({ shared: true, confirm: true, projects: Names });
    });

    it("closes a tile at once with one project", () => {
        const one = { tabids: ["cadrage1"], meta: {} };
        const plan = planPinnedClose(one, "cadrage1", "workspace", false, metaOf, ["Desktop"]);
        expect(plan).toMatchObject({ tabIds: ["cadrage1"], shared: true, confirm: false });
    });

    it("closes this workspace's instances of a view pinned everywhere, never another pin's", () => {
        const plan = planPinnedClose(ws, "term1", "everywhere", false, metaOf, Names);
        expect(plan.tabIds).toEqual(["term1", "term2"]);
        expect(plan.confirm).toBe(true);
    });

    it("closes the Project tab, one tab shared by the projects, after the same confirmation", () => {
        expect(planPinnedClose(ws, "project", "workspace", true, metaOf, Names)).toMatchObject({
            tabIds: ["project"],
            shared: true,
            confirm: true,
        });
        expect(planPinnedClose(ws, "project", "workspace", true, metaOf, ["Desktop"]).confirm).toBe(false);
    });

    it("names no choice of closing for one project only", () => {
        const plan = planPinnedClose(ws, "cadrage1", "workspace", false, metaOf, Names);
        expect(Object.keys(plan).sort()).toEqual(["confirm", "projects", "shared", "tabIds"]);
    });
});
