// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { layoutMenuItems } from "../menu/menu-model";
import type { PaletteEntry } from "../palette/palette-model";
import { PlusMenuActions, plusMenuItems } from "./plus-menu-model";

const t = (key: string, vars?: Record<string, any>) => (vars?.name != null ? `${key}:${vars.name}` : key);

const widget = (id: string, label: string): PaletteEntry => ({
    id,
    group: "panels",
    label,
    icon: "x",
    run: { kind: "widget", blockdef: { meta: { view: id } } },
});
const agent = (id: string, label: string): PaletteEntry => ({
    id: `agent:${id}`,
    group: "agents",
    label,
    icon: "robot",
    run: { kind: "agent", command: id },
});
const projectTab: PaletteEntry = {
    id: "action:projecttab",
    group: "actions",
    label: "Project",
    icon: "gauge",
    run: { kind: "projecttab" },
};

function actions(choices: PaletteEntry[]): PlusMenuActions {
    return {
        workspace: "Acme",
        choices,
        onOpenHere: vi.fn(),
        onNewView: vi.fn(),
        newViewKeys: "Command+T",
        onAddProject: vi.fn(),
        onNewWorkspace: vi.fn(),
    };
}

const shown = (items: ContextMenuItem[]) =>
    layoutMenuItems(items).map((i) =>
        i.type === "header" ? `# ${i.label}` : i.type === "submenu" ? `${i.label} ›` : i.label
    );

describe("the + menu (FR-SHELL-107)", () => {
    const choices = [
        widget("panel:defwidget@terminal", "Terminal panel"),
        widget("panel:defwidget@web", "Web"),
        widget("panel:sessions", "Sessions"),
        agent("claude", "Claude Code"),
        agent("codex", "Codex"),
        projectTab,
    ];

    it("offers In this view, In «workspace» and Workspaces", () => {
        expect(shown(plusMenuItems(actions(choices), t))).toEqual([
            "# sidebar.plus.inThisView",
            "sidebar.plus.terminal",
            "sidebar.plus.webPage",
            "sidebar.plus.agent ›",
            "sidebar.plus.otherPanel ›",
            "# sidebar.plus.inWorkspace:Acme",
            "sidebar.plus.newView",
            "sidebar.project.addMenu",
            "# sidebar.plus.workspaces",
            "sidebar.plus.newWorkspace",
        ]);
    });

    it("lists every agent preset and the other panels, never the Project view, and opens a pick in this view", () => {
        const menu = actions(choices);
        const items = plusMenuItems(menu, t);
        const agents = items.find((i) => i.label === "sidebar.plus.agent");
        expect(agents.submenu.map((i) => i.label)).toEqual(["Claude Code", "Codex"]);
        const others = items.find((i) => i.label === "sidebar.plus.otherPanel");
        expect(others.submenu.map((i) => i.label)).toEqual(["Sessions"]);
        agents.submenu[1].click();
        expect(menu.onOpenHere).toHaveBeenCalledWith(choices[4]);
        items.find((i) => i.label === "sidebar.plus.terminal").click();
        expect(menu.onOpenHere).toHaveBeenLastCalledWith(choices[0]);
    });

    it("names a lone agent instead of a submenu, and drops what the setup lacks", () => {
        const items = plusMenuItems(actions([widget("panel:defwidget@terminal", "T"), agent("codex", "Codex")]), t);
        const lone = items.find((i) => i.label === "sidebar.plus.agent");
        expect(lone.type).toBeUndefined();
        expect(lone.sublabel).toBe("Codex");
        expect(items.some((i) => i.label === "sidebar.plus.webPage")).toBe(false);
        expect(items.some((i) => i.label === "sidebar.plus.otherPanel")).toBe(false);
    });
});
