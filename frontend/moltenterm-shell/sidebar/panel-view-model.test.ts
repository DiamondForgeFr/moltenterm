// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A view made from a panel (FR-SHELL-080, #2548): the three destinations, the places in them, and what the menu offers.

import { describe, expect, it } from "vitest";
import {
    agentPlan,
    asksBeforeMoving,
    captionOf,
    destinationHasFolder,
    destinationOfHit,
    endMark,
    entryDestinations,
    foldersOfViews,
    landsBefore,
    listHitAt,
    noticeOf,
    panelViewEntries,
    PanelViewMenuFacts,
    PanelViewNames,
    sameHit,
} from "./panel-view-model";

const names: PanelViewNames = {
    context: "Client",
    workspace: "MoltenTerm",
    projectOf: (id) => ({ p1: "Desktop", p2: "Site" })[id] ?? "",
    folderName: (id) => `folder ${id}`,
};

function facts(over: Partial<PanelViewMenuFacts> = {}): PanelViewMenuFacts {
    return {
        contextName: "Client",
        workspaceName: "MoltenTerm",
        projects: [
            { id: "p1", label: "Desktop" },
            { id: "p2", label: "Site" },
        ],
        currentProjectId: "p1",
        foldersOf: () => [],
        ...over,
    };
}

describe("where a dropped view lands in a row of blocks", () => {
    const order = ["a", "b", "c"];

    it("lands before the block under the pointer, or before the next when it is on its far side", () => {
        expect(landsBefore(order, "b", false)).toBe("b");
        expect(landsBefore(order, "b", true)).toBe("c");
    });

    it("lands at the end past the last block, or on a block the row does not hold", () => {
        expect(landsBefore(order, "c", true)).toBeNull();
        expect(landsBefore(order, "gone", false)).toBeNull();
        expect(landsBefore(order, null, false)).toBeNull();
        expect(landsBefore([], null, true)).toBeNull();
    });

    it("marks the end of the row after its last block, and nothing in an empty row", () => {
        expect(endMark(order)).toEqual({ key: "c", after: true });
        expect(endMark([])).toEqual({ key: null, after: false });
    });
});

describe("the Views list under the pointer", () => {
    const slots = [
        { key: "tab:t1", top: 100, height: 30 },
        { key: "folder:f1", top: 130, height: 30 },
        { key: "tab:t2", top: 160, height: 30 },
    ];

    it("lands before the first row whose middle is below the pointer", () => {
        expect(listHitAt(105, slots)).toEqual({ before: "tab:t1", folderKey: null });
        expect(listHitAt(126, slots)).toEqual({ before: "folder:f1", folderKey: null });
        expect(listHitAt(181, slots)).toEqual({ before: null, folderKey: null });
    });

    it("goes into the folder whose row's middle the pointer is on, and into no view's row", () => {
        expect(listHitAt(145, slots)).toEqual({ before: null, folderKey: "folder:f1" });
        expect(listHitAt(175, slots).folderKey).toBeNull();
    });
});

describe("the destination a hit stands for", () => {
    it("the top row is the Transversal views, before the block it lands before", () => {
        expect(destinationOfHit({ zone: "top", before: "g2" }, "p1", false)).toEqual({ kind: "pinned", before: "g2" });
        expect(destinationOfHit({ zone: "top", before: null }, "p1", false)).toEqual({
            kind: "pinned",
            before: undefined,
        });
    });

    it("the tiles are the Important views of the workspace", () => {
        expect(destinationOfHit({ zone: "tiles", before: "t9" }, "p1", true)).toEqual({
            kind: "workspace",
            before: "t9",
        });
    });

    it("the Views list is the project's, which a workspace with two projects names", () => {
        expect(destinationOfHit({ zone: "temporary", before: "t3" }, "p1", true)).toEqual({
            kind: "views",
            projectId: "p1",
            before: "t3",
        });
        expect(destinationOfHit({ zone: "temporary", before: null }, "p1", false)).toEqual({
            kind: "views",
            projectId: undefined,
            before: undefined,
        });
    });

    it("a folder's row is a folder of the project's Views", () => {
        const dest = destinationOfHit({ zone: "temporary", folderId: "f1", before: null }, "p1", true);
        expect(dest).toEqual({ kind: "views", projectId: "p1", folderId: "f1" });
        expect(destinationHasFolder(dest)).toBe(true);
    });

    it("another project's zone is that project's Views", () => {
        expect(destinationOfHit({ zone: "project", projectId: "p2" }, "p1", true)).toEqual({
            kind: "views",
            projectId: "p2",
        });
        expect(destinationOfHit({ zone: "project" }, "p1", true)).toBeNull();
    });

    it("away from every zone there is no destination", () => {
        expect(destinationOfHit(null, "p1", true)).toBeNull();
    });
});

describe("the panel's menu", () => {
    it("offers the context, the workspace, then each linked project, in the order of the hierarchy", () => {
        const entries = panelViewEntries(facts());
        expect(entries.map((e) => e.id)).toEqual(["pinned", "workspace", "project:p1", "project:p2"]);
        expect(entries[0]).toMatchObject({ labelKey: "sidebar.panelView.pinned", vars: { context: "Client" } });
        expect(entries[1]).toMatchObject({
            labelKey: "sidebar.panelView.workspace",
            vars: { workspace: "MoltenTerm" },
        });
        expect(entries[2]).toMatchObject({ labelKey: "sidebar.panelView.project", vars: { project: "Desktop" } });
    });

    it("leads to one destination each: pinned, workspace, and a project's Views", () => {
        const entries = panelViewEntries(facts());
        expect(entries.map((e) => e.destination)).toEqual([
            { kind: "pinned" },
            { kind: "workspace" },
            { kind: "views", projectId: "p1" },
            { kind: "views", projectId: "p2" },
        ]);
    });

    it("names no project in a workspace with one: the Views are its own", () => {
        const entries = panelViewEntries(facts({ projects: [{ id: "p1", label: "Desktop" }] }));
        expect(entries[2].destination).toEqual({ kind: "views", projectId: undefined });
    });

    it("offers the Views list as it is in a workspace with no linked project", () => {
        const entries = panelViewEntries(facts({ projects: [], currentProjectId: "" }));
        expect(entries.map((e) => e.id)).toEqual(["pinned", "workspace", "views"]);
        expect(entries[2]).toMatchObject({ labelKey: "sidebar.panelView.views", destination: { kind: "views" } });
    });

    it("puts a project's folders under its entry: its Views first, then each folder", () => {
        const entries = panelViewEntries(
            facts({
                foldersOf: (id) =>
                    id === "p1"
                        ? [
                              { id: "f1", name: "Recipes" },
                              { id: "f2", name: "Bugs" },
                          ]
                        : [],
            })
        );
        const project = entries.find((e) => e.id === "project:p1");
        expect(project.destination).toBeUndefined();
        expect(project.children.map((c) => c.labelKey)).toEqual([
            "sidebar.panelView.projectViews",
            "sidebar.panelView.folder",
            "sidebar.panelView.folder",
        ]);
        expect(project.children.map((c) => c.destination)).toEqual([
            { kind: "views", projectId: "p1" },
            { kind: "views", projectId: "p1", folderId: "f1" },
            { kind: "views", projectId: "p1", folderId: "f2" },
        ]);
        expect(project.children[1].vars).toEqual({ name: "Recipes" });
        const other = entries.find((e) => e.id === "project:p2");
        expect(other.children).toBeUndefined();
    });

    it("offers a folder only among a project's Views, never for the context or the workspace", () => {
        const entries = panelViewEntries(
            facts({
                foldersOf: () => [
                    { id: "f1", name: "Recipes" },
                    { id: "f2", name: "Bugs" },
                ],
            })
        );
        for (const entry of entries.filter((e) => e.id === "pinned" || e.id === "workspace")) {
            expect(entry.children).toBeUndefined();
            expect(destinationHasFolder(entry.destination)).toBe(false);
        }
        const withFolder = entryDestinations(entries).filter(destinationHasFolder);
        expect(withFolder.length).toBe(4);
        expect(withFolder.every((d) => d.kind === "views")).toBe(true);
    });

    it("keeps the Views list's own folders in a workspace with no project", () => {
        const entries = panelViewEntries(
            facts({ projects: [], currentProjectId: "", foldersOf: () => [{ id: "f1", name: "Recipes" }] })
        );
        const views = entries.find((e) => e.id === "views");
        expect(views.children.map((c) => c.destination)).toEqual([
            { kind: "views", projectId: undefined },
            { kind: "views", projectId: undefined, folderId: "f1" },
        ]);
    });
});

describe("the folders a project's Views show", () => {
    it("lists the folders with two views or more among the project's own, and leaves out the others", () => {
        const folders = [
            { id: "f1", name: "A", tabids: ["t1", "t2"] },
            { id: "f2", name: "B", tabids: ["t3", "elsewhere"] },
        ];
        expect(foldersOfViews(["t1", "t2", "t3"], folders).map((f) => f.id)).toEqual(["f1"]);
    });
});

describe("what a zone says, and the notice after", () => {
    it("says where the view goes for each destination", () => {
        expect(captionOf({ kind: "pinned" }, names)).toEqual({
            key: "sidebar.panelView.captionPinned",
            vars: { context: "Client" },
        });
        expect(captionOf({ kind: "workspace" }, names)).toEqual({
            key: "sidebar.panelView.captionWorkspace",
            vars: { workspace: "MoltenTerm" },
        });
        expect(captionOf({ kind: "views", projectId: "p2" }, names)).toEqual({
            key: "sidebar.panelView.captionProject",
            vars: { project: "Site" },
        });
        expect(captionOf({ kind: "views" }, { ...names, projectOf: () => "" }).key).toBe(
            "sidebar.panelView.captionViews"
        );
        expect(captionOf({ kind: "views", projectId: "p1", folderId: "f1" }, names)).toEqual({
            key: "sidebar.panelView.captionFolder",
            vars: { name: "folder f1" },
        });
    });

    it("tells where the view was made, with its name", () => {
        expect(noticeOf({ kind: "pinned" }, "Docs", names)).toEqual({
            key: "sidebar.panelView.createdPinned",
            vars: { name: "Docs", context: "Client" },
        });
        expect(noticeOf({ kind: "workspace" }, "Docs", names).key).toBe("sidebar.panelView.createdWorkspace");
        expect(noticeOf({ kind: "views", projectId: "p1" }, "Docs", names)).toEqual({
            key: "sidebar.panelView.createdProject",
            vars: { name: "Docs", project: "Desktop" },
        });
        expect(noticeOf({ kind: "views", folderId: "f1" }, "Docs", names)).toEqual({
            key: "sidebar.panelView.createdFolder",
            vars: { name: "Docs", folder: "folder f1" },
        });
    });
});

describe("a panel that holds an agent", () => {
    it("asks before it moves, and only an agent's panel asks", () => {
        expect(asksBeforeMoving(true)).toBe(true);
        expect(asksBeforeMoving(false)).toBe(false);
    });

    it("moves the panel on Move, makes the view without it on Leave it here, and makes nothing without an answer", () => {
        expect(agentPlan("move")).toEqual({ move: true, make: true });
        expect(agentPlan("stay")).toEqual({ move: false, make: true });
        expect(agentPlan(null)).toEqual({ move: false, make: false });
    });
});

describe("the hit a pointer makes", () => {
    it("is the same hit when nothing it names changed", () => {
        expect(
            sameHit({ zone: "top", key: "a", after: true, before: null }, { zone: "top", key: "a", after: true })
        ).toBe(true);
        expect(sameHit({ zone: "top", key: "a", after: true }, { zone: "top", key: "a", after: false })).toBe(false);
        expect(sameHit({ zone: "temporary", folderId: "f1" }, { zone: "temporary" })).toBe(false);
        expect(sameHit(null, null)).toBe(true);
        expect(sameHit(null, { zone: "top" })).toBe(false);
    });
});
