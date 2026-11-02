// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { layoutMenuItems } from "../menu/menu-model";
import { opensWorkspaceMenu, WorkspaceMenuActions, workspaceMenuItems } from "./workspace-menu-model";

const t = (key: string, vars?: Record<string, any>) =>
    vars?.name != null ? `${key}:${vars.name}` : vars?.count != null ? `${key}:${vars.count}` : key;

function actions(enabled: boolean, withProjects = true): WorkspaceMenuActions {
    const fn = () => {};
    return {
        name: "Acme",
        onEdit: fn,
        keepAwake: { label: "keep awake", type: "checkbox", checked: false, click: fn },
        onManage: fn,
        projects: withProjects
            ? {
                  list: [
                      { id: "p1", label: "Desktop", current: true, onSwitch: vi.fn() },
                      { id: "p2", label: "Website", current: false, onSwitch: vi.fn() },
                  ],
                  onAdd: fn,
                  onProjectTab: fn,
              }
            : undefined,
        onReset: fn,
        remove: { enabled, reason: "only one", onDelete: vi.fn() },
    };
}

const shown = (items: ContextMenuItem[]) =>
    layoutMenuItems(items).map((i) => (i.type === "header" ? `# ${i.label}` : i.type === "separator" ? "—" : i.label));

describe("the workspace menu by family (FR-SHELL-107)", () => {
    it("draws the sections Workspace, Projects and Delete or reset, in that order", () => {
        expect(shown(workspaceMenuItems(actions(true), t))).toEqual([
            "# sidebar.workspaceMenu.header:Acme",
            "sidebar.workspaceMenu.edit",
            "keep awake",
            "sidebar.workspaceMenu.manage",
            "# sidebar.workspaceMenu.projects:2",
            "Desktop",
            "Website",
            "sidebar.project.addMenu",
            "rail.menu.openProjectTab",
            "# sidebar.workspaceMenu.removeSection",
            "rail.menu.resetWorkspace",
            "sidebar.workspaceMenu.delete",
        ]);
    });

    it("lists the projects with the current one checked, and switches on a pick", () => {
        const menu = actions(true);
        const items = workspaceMenuItems(menu, t);
        const desktop = items.find((i) => i.label === "Desktop");
        const website = items.find((i) => i.label === "Website");
        expect(desktop).toMatchObject({ type: "checkbox", checked: true });
        expect(website).toMatchObject({ type: "checkbox", checked: false });
        website.click();
        expect(menu.projects.list[1].onSwitch).toHaveBeenCalledTimes(1);
    });

    it("leaves out the projects of a workspace not on screen", () => {
        const items = shown(workspaceMenuItems(actions(true, false), t));
        expect(items.some((l) => l.includes("projects"))).toBe(false);
        expect(items.at(-1)).toBe("sidebar.workspaceMenu.delete");
    });

    it("enables Delete when another workspace exists", () => {
        const del = workspaceMenuItems(actions(true), t).at(-1);
        expect(del.enabled).toBe(true);
        expect(del.sublabel).toBeUndefined();
    });

    it("disables Delete on the last workspace and says why", () => {
        const del = workspaceMenuItems(actions(false), t).at(-1);
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
