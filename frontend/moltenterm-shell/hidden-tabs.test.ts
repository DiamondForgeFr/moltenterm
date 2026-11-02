// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    ActiveByProjectMetaKey,
    currentProjectIdOf,
    HiddenTabsMetaKey,
    projectTabIds,
    tabProjectOf,
    TabProjectsMetaKey,
    visibleTabIds,
} from "./hidden-tabs";

const Projects = [
    { id: "p1", type: "Desktop", dir: "/x/Notulia" },
    { id: "p2", type: "Website", dir: "/x/Notulia-website" },
];

function ws(meta: Record<string, any>, tabids: string[]) {
    return { tabids, meta: { "molten:projects": Projects, ...meta } };
}

describe("visibleTabIds", () => {
    it("shows every tab of a workspace with one project, hidden ones apart", () => {
        const one = {
            tabids: ["a", "b", "c"],
            meta: { [HiddenTabsMetaKey]: ["b"], [TabProjectsMetaKey]: { a: "p1" } },
        };
        expect(currentProjectIdOf(one)).toBe("");
        expect(projectTabIds(one)).toEqual(["a", "b", "c"]);
        expect(visibleTabIds(one)).toEqual(["a", "c"]);
    });

    it("shows the current project's views, the shared ones and nothing of the other project", () => {
        const meta = {
            "molten:currentproject": "p2",
            [TabProjectsMetaKey]: { a1: "p1", a2: "p1", b1: "p2", gone: "p9" },
        };
        const tabs = ["project", "a1", "b1", "a2", "gone"];
        expect(visibleTabIds(ws(meta, tabs))).toEqual(["project", "b1", "gone"]);
        expect(visibleTabIds(ws({ ...meta, "molten:currentproject": "p1" }, tabs))).toEqual([
            "project",
            "a1",
            "a2",
            "gone",
        ]);
    });

    it("takes the first project as current when the stored one is gone", () => {
        const meta = { "molten:currentproject": "p9", [TabProjectsMetaKey]: { a1: "p1", b1: "p2" } };
        expect(currentProjectIdOf(ws(meta, []))).toBe("p1");
        expect(visibleTabIds(ws(meta, ["a1", "b1"]))).toEqual(["a1"]);
    });

    it("keeps the hidden tabs of the project in projectTabIds and out of visibleTabIds", () => {
        const meta = {
            "molten:currentproject": "p1",
            [HiddenTabsMetaKey]: ["a2", "b2"],
            [TabProjectsMetaKey]: { a1: "p1", a2: "p1", b1: "p2", b2: "p2" },
        };
        const tabs = ["a1", "a2", "b1", "b2"];
        expect(projectTabIds(ws(meta, tabs))).toEqual(["a1", "a2"]);
        expect(visibleTabIds(ws(meta, tabs))).toEqual(["a1"]);
    });

    it("ignores a malformed map", () => {
        for (const bad of [null, "x", ["a"], 3]) {
            const meta = { "molten:currentproject": "p1", [TabProjectsMetaKey]: bad };
            expect(visibleTabIds(ws(meta, ["a", "b"]))).toEqual(["a", "b"]);
        }
        expect(ActiveByProjectMetaKey).toBe("molten:projectactivetab");
    });
});

describe("tabProjectOf", () => {
    it("names the owner, or nothing for a shared tab and a project the list lost", () => {
        const w = ws({ [TabProjectsMetaKey]: { a: "p1", b: "p9" } }, ["a", "b", "c"]);
        expect(tabProjectOf(w, "a")).toBe("p1");
        expect(tabProjectOf(w, "b")).toBe("");
        expect(tabProjectOf(w, "c")).toBe("");
    });
});
