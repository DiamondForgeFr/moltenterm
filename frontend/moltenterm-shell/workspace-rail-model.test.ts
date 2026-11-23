// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { makeWorkspaceRailEntries } from "./workspace-rail-model";

function ws(oid: string, name = "", icon = "", color = ""): Workspace {
    return { oid, name, icon, color, tabids: [], activetabid: "", otype: "workspace", version: 1 } as Workspace;
}

describe("makeWorkspaceRailEntries", () => {
    it("keeps Wave's order and marks the active and open workspaces", () => {
        const entries = makeWorkspaceRailEntries(
            [
                { workspace: ws("a", "Alpha", "rocket", "#58C142"), windowId: "w1" },
                { workspace: ws("b", "Beta", "star", "#BF55EC"), windowId: "" },
            ],
            ws("a", "Alpha", "rocket", "#58C142")
        );
        expect(entries.map((e) => [e.id, e.active, e.open, e.saved])).toEqual([
            ["a", true, true, true],
            ["b", false, false, true],
        ]);
        expect(entries[1]).toMatchObject({ name: "Beta", icon: "star", color: "#BF55EC" });
    });

    it("puts an unsaved active workspace first", () => {
        const entries = makeWorkspaceRailEntries([{ workspace: ws("a", "Alpha", "rocket"), windowId: "" }], ws("tmp"));
        expect(entries[0]).toMatchObject({
            id: "tmp",
            saved: false,
            active: true,
            open: true,
            name: "Unsaved workspace",
        });
        expect(entries).toHaveLength(2);
    });

    it("treats a workspace without a name or an icon as unsaved", () => {
        const entries = makeWorkspaceRailEntries([{ workspace: ws("x", "Named"), windowId: "" }], null);
        expect(entries[0].saved).toBe(false);
    });

    it("ignores empty sources", () => {
        expect(makeWorkspaceRailEntries(null, null)).toEqual([]);
        expect(makeWorkspaceRailEntries([{ workspace: null, windowId: "" }], null)).toEqual([]);
    });

    it("gives each entry its context, the first one when the workspace names none (FR-SHELL-158)", () => {
        const contexts = [{ id: "first" }, { id: "second" }];
        const inSecond = { ...ws("b", "Beta", "star"), meta: { "molten:context": "second" } } as Workspace;
        const gone = { ...ws("c", "Gamma", "star"), meta: { "molten:context": "deleted" } } as Workspace;
        const entries = makeWorkspaceRailEntries(
            [
                { workspace: ws("a", "Alpha", "rocket"), windowId: "" },
                { workspace: inSecond, windowId: "" },
                { workspace: gone, windowId: "" },
            ],
            ws("tmp"),
            contexts
        );
        expect(entries.map((e) => [e.id, e.contextId])).toEqual([
            ["tmp", "first"],
            ["a", "first"],
            ["b", "second"],
            ["c", "first"],
        ]);
    });

    it("leaves the context empty when the entries were made without the contexts", () => {
        const entries = makeWorkspaceRailEntries([{ workspace: ws("a", "Alpha", "rocket"), windowId: "" }], null);
        expect(entries[0].contextId).toBe("");
    });
});
