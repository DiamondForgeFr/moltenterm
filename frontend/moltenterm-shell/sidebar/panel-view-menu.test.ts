// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// "Create a view with this panel" in the panel's menus (FR-SHELL-080, #2548): the right-click and the command panel offer
// the same destinations, a folder only under a project, and a choice makes the view there.

import { initGlobalAtoms } from "@/app/store/global-atoms";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/util/fetchutil", () => ({ fetch: () => new Promise(() => {}) }));

const facts = vi.hoisted(() => ({
    value: null as any,
}));
const make = vi.hoisted(() => vi.fn(async () => "tab-new"));

vi.mock("./panel-view-store", () => ({
    makeViewFromPanel: make,
    panelViewMenuFacts: () => facts.value,
}));

import { blockBodyMenuItems, terminalBodyMenuTail } from "../command-panel/block-menus";
import { PanelPage } from "../command-panel/panel-types";
import { panelViewItem } from "../command-panel/providers/panel-view";
import { panelViewMenuItems } from "./panel-view-menu";
import { PanelViewDestination, PanelViewMenuFacts } from "./panel-view-model";

function twoProjects(folders: Record<string, { id: string; name: string }[]> = {}): PanelViewMenuFacts {
    return {
        contextName: "Client",
        workspaceName: "MoltenTerm",
        projects: [
            { id: "p1", label: "Desktop" },
            { id: "p2", label: "Site" },
        ],
        currentProjectId: "p1",
        foldersOf: (id) => folders[id] ?? [],
    };
}

beforeAll(() => {
    initGlobalAtoms({ tabId: "tab-a", windowId: "win-a", clientId: "c", platform: "darwin" } as any);
});

beforeEach(() => {
    make.mockClear();
    facts.value = twoProjects();
});

function submenuOf(items: ContextMenuItem[]): ContextMenuItem[] {
    const entry = items.find((i) => i.label === "Create a view with this panel");
    return entry.submenu;
}

const labels = (items: ContextMenuItem[]) => items.map((i) => i.label);

describe("the panel's right-click", () => {
    it("offers one entry, Create a view with this panel, a submenu with the destinations in order", () => {
        const items = panelViewMenuItems("block-1");
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ label: "Create a view with this panel", type: "submenu" });
        expect(labels(submenuOf(items))).toEqual([
            "Pinned in Client",
            "In the workspace MoltenTerm",
            "In the project Desktop",
            "In the project Site",
        ]);
    });

    it("makes the view at each destination: pinned, in the workspace, in a project", () => {
        const sub = submenuOf(panelViewMenuItems("block-1"));
        for (const item of sub) {
            item.click();
        }
        const asked = make.mock.calls.map((c) => c as unknown as [string, PanelViewDestination]);
        expect(asked.map((c) => c[0])).toEqual(["block-1", "block-1", "block-1", "block-1"]);
        expect(asked.map((c) => c[1])).toEqual([
            { kind: "pinned" },
            { kind: "workspace" },
            { kind: "views", projectId: "p1" },
            { kind: "views", projectId: "p2" },
        ]);
    });

    it("lists a project's Views then its folders under its entry, and no folder anywhere else", () => {
        facts.value = twoProjects({
            p1: [
                { id: "f1", name: "Recipes" },
                { id: "f2", name: "Bugs" },
            ],
        });
        const sub = submenuOf(panelViewMenuItems("block-1"));
        const project = sub.find((i) => i.label === "In the project Desktop");
        expect(project.type).toBe("submenu");
        expect(labels(project.submenu)).toEqual(["In its Views", "In the folder Recipes", "In the folder Bugs"]);
        for (const entry of sub.filter((i) => i !== project)) {
            expect(entry.submenu).toBeUndefined();
        }
        project.submenu[2].click();
        expect(make).toHaveBeenLastCalledWith("block-1", { kind: "views", projectId: "p1", folderId: "f2" });
        project.submenu[0].click();
        expect(make).toHaveBeenLastCalledWith("block-1", { kind: "views", projectId: "p1" });
    });

    it("sits in the body's menu and in a terminal's, next to the panel's own entries", () => {
        const node = { isMagnified: null, toggleMagnify: () => {} };
        expect(labels(blockBodyMenuItems("block-1", node))).toContain("Create a view with this panel");
        expect(labels(terminalBodyMenuTail("block-1", node))).toContain("Create a view with this panel");
    });
});

describe("the command panel", () => {
    it("offers the same page, with the same destinations, as a page of actions", () => {
        const page = panelViewItem("block-1") as PanelPage;
        expect(page).toMatchObject({ type: "page", label: "Create a view with this panel" });
        expect(page.items.map((i) => i.label)).toEqual([
            "Pinned in Client",
            "In the workspace MoltenTerm",
            "In the project Desktop",
            "In the project Site",
        ]);
        for (const item of page.items) {
            expect(item.type).toBe("action");
            (item as any).run();
        }
        expect(make.mock.calls.map((c) => (c as any)[1])).toEqual([
            { kind: "pinned" },
            { kind: "workspace" },
            { kind: "views", projectId: "p1" },
            { kind: "views", projectId: "p2" },
        ]);
    });

    it("makes a project with folders a page of its own, its folders its actions", () => {
        facts.value = twoProjects({ p2: [{ id: "f9", name: "Docs" }] });
        const page = panelViewItem("block-1") as PanelPage;
        const project = page.items.find((i) => i.label === "In the project Site") as PanelPage;
        expect(project.type).toBe("page");
        expect(project.items.map((i) => i.label)).toEqual(["In its Views", "In the folder Docs"]);
        (project.items[1] as any).run();
        expect(make).toHaveBeenLastCalledWith("block-1", { kind: "views", projectId: "p2", folderId: "f9" });
        const plain = page.items.find((i) => i.label === "In the workspace MoltenTerm");
        expect(plain.type).toBe("action");
    });
});
