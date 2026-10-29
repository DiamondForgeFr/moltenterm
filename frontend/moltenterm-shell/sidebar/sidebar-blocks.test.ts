// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A workspace's blocks, read the same by its sidebar and its library card (FR-SHELL-080, FR-SHELL-088, #1307).

import { describe, expect, it } from "vitest";
import { pinGlyph, topRowBlocks, workspaceBlocks } from "./sidebar-blocks";
import { GlobalPin } from "./view-pins-model";

function pin(id: string, name: string, views: string[], extra: Partial<GlobalPin> = {}): GlobalPin {
    const panes = views.map((view) => ({ view }));
    const tree = panes.length === 1 ? { pane: 0 } : { dir: "row", children: panes.map((_, i) => ({ pane: i })) };
    return { id, name, rev: 1, config: { tree, panes }, ...extra };
}

const terminal = pin("p-term", "Terminal", ["term"]);
const web = pin("p-web", "Page web", ["molten-browser"]);
const review = pin("p-rev", "Revue PR", ["molten-reviews"]);
const project = pin("p-proj", "Projet", ["molten-project", "molten-browser"], { rev: 2 });

describe("the top row of a workspace (#1307)", () => {
    it("follows the pins' order, not the order the workspace opened its instances in", () => {
        // The workspace opened Projet first, then Terminal, Revue PR and Page web.
        const instances = { "p-proj": "t1", "p-term": "t2", "p-rev": "t3", "p-web": "t4" };
        const blocks = topRowBlocks([terminal, web, review, project], instances);
        expect(blocks.map((b) => b.pin.id)).toEqual(["p-term", "p-web", "p-rev", "p-proj"]);
        expect(blocks.map((b) => b.tabId)).toEqual(["t2", "t4", "t3", "t1"]);
    });

    it("names each block by its pin, whatever its instance's tab is still called", () => {
        const blocks = topRowBlocks([terminal, web, review, project], { "p-rev": "tab-still-named-pilotage" });
        expect(blocks.map((b) => b.name)).toEqual(["Terminal", "Page web", "Revue PR", "Projet"]);
    });

    it("draws the composed glyph of the pin's panels, up to three", () => {
        expect(pinGlyph(project)).toEqual(["gauge", "globe"]);
        const four = pin("p4", "Four", ["term", "molten-browser", "molten-reviews", "molten-project"]);
        expect(pinGlyph(four)).toHaveLength(3);
    });

    it("draws a pin whose panels were updated from its new configuration, not from a stale instance", () => {
        const before = pin("p-proj", "Projet", ["molten-project"]);
        const updated = { ...before, rev: 2, config: project.config };
        expect(topRowBlocks([before], { "p-proj": "t1" })[0].glyph).toEqual(["gauge"]);
        expect(topRowBlocks([updated], { "p-proj": "t1" })[0].glyph).toEqual(["gauge", "globe"]);
    });

    it("keeps the icon the developer chose for the pin", () => {
        expect(pinGlyph({ ...terminal, icon: "rocket" })).toEqual(["rocket"]);
    });

    it("shows a pin the workspace never opened, without an instance", () => {
        const blocks = topRowBlocks([terminal, web], { "p-term": "t2" });
        expect(blocks.map((b) => b.tabId)).toEqual(["t2", ""]);
    });
});

describe("a workspace's blocks (#1307)", () => {
    it("are the top row, then the tiles in the sidebar's order", () => {
        const blocks = workspaceBlocks([terminal, review], {
            tiles: ["cadrage", "pilotage"],
            temporary: ["scratch"],
            everywhere: { "p-rev": "t3" },
        });
        expect(blocks.top.map((b) => [b.name, b.tabId])).toEqual([
            ["Terminal", ""],
            ["Revue PR", "t3"],
        ]);
        expect(blocks.tiles).toEqual(["cadrage", "pilotage"]);
    });

    it("are empty for a workspace not loaded yet", () => {
        expect(workspaceBlocks([], null)).toEqual({ top: [], tiles: [] });
    });
});
