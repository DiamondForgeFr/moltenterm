// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { opensWorkspaceMenu, workspaceBackgroundMenuItems, WorkspaceMenuActions } from "./workspace-menu-model";

const t = (key: string, vars?: Record<string, any>) => (vars?.name ? `${key}:${vars.name}` : key);

function actions(enabled: boolean): WorkspaceMenuActions {
    const fn = () => {};
    return {
        name: "Acme",
        onRename: fn,
        onChangeIcon: fn,
        onEditColour: fn,
        onEdit: fn,
        onNewView: fn,
        onAddProject: fn,
        onManage: fn,
        newViewKeys: "Cmd+T",
        remove: { enabled, reason: "only one", onDelete: vi.fn() },
    };
}

describe("the workspace menu (FR-SHELL-079, #1252)", () => {
    it("lists the header and the items in order", () => {
        const items = workspaceBackgroundMenuItems(actions(true), t);
        const labels = items.filter((i) => i.type !== "separator").map((i) => i.label);
        expect(labels).toEqual([
            "sidebar.workspaceMenu.header:Acme",
            "sidebar.workspaceMenu.rename",
            "sidebar.workspaceMenu.changeIcon",
            "sidebar.workspaceMenu.editColour",
            "sidebar.workspaceMenu.edit",
            "sidebar.workspaceMenu.newView",
            "sidebar.project.addMenu",
            "sidebar.workspaceMenu.manage",
            "sidebar.workspaceMenu.delete",
        ]);
        expect(items[0].type).toBe("header");
        expect(items.find((i) => i.label === "sidebar.workspaceMenu.newView").accelerator).toBe("Cmd+T");
    });

    it("enables Delete when another workspace exists", () => {
        const del = workspaceBackgroundMenuItems(actions(true), t).at(-1);
        expect(del.enabled).toBe(true);
        expect(del.sublabel).toBeUndefined();
    });

    it("disables Delete on the last workspace and says why", () => {
        const del = workspaceBackgroundMenuItems(actions(false), t).at(-1);
        expect(del.enabled).toBe(false);
        expect(del.sublabel).toBe("only one");
    });
});

describe("what opens the workspace menu", () => {
    // A node whose closest() finds a control only when it sits inside one.
    function node(insideControl: boolean): Element {
        return { closest: (selector: string) => (insideControl && selector.includes("button") ? {} : null) } as any;
    }

    it("opens on the background and on the name", () => {
        expect(opensWorkspaceMenu(node(false), false)).toBe(true);
    });

    it("does not open on a control", () => {
        expect(opensWorkspaceMenu(node(true), false)).toBe(false);
    });

    it("does not open when a view, an agent row or a pinned block already handled the right-click", () => {
        expect(opensWorkspaceMenu(node(false), true)).toBe(false);
    });
});
