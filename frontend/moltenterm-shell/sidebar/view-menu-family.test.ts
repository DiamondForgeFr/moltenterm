// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The view menu holds only what is about the view (FR-SHELL-107): Reopen what was closed (the workspace's), the tab bar
// position (the app's) and Copy id (the developer's) leave it, and a pinned view says why it has no Close on hover.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/tab/tabcontextmenu", () => ({
    buildTabContextMenu: () => [
        { label: "wave.tab.rename" },
        { label: "wave.tab.backgrounds", type: "submenu", submenu: [] },
        { label: "wave.tab.tabBarPosition", type: "submenu", submenu: [] },
        { label: "wave.tab.copyId", section: "Developer" },
        { type: "separator" },
        { label: "wave.tab.reopenClosed" },
        { label: "wave.tab.close", destructive: true },
    ],
}));
vi.mock("./view-pins-store", () => ({
    ViewPins: {
        getInstance: () => ({
            forkOriginOf: (): any => null,
            finishedAtom: { read: (): any[] => [] },
        }),
    },
}));
vi.mock("../equalize/equalize-actions", () => ({ currentEqualize: (): any => null }));
vi.mock("@/layout/index", () => ({ getLayoutModelForStaticTab: (): any => null }));
vi.mock("@/app/store/global", () => ({
    atoms: { workspace: "workspace" },
    globalStore: { get: (a: any): any => (a === "workspace" ? { name: "Acme" } : []) },
}));

import { viewMenuItems, ViewMenuTarget } from "./view-menu";

const t = (key: string) => key;

function target(state: ViewMenuTarget["state"]): ViewMenuTarget {
    return { ref: { tabId: "tab1" } as any, state, modified: false, name: "Build", icon: null, active: true };
}

function labels(items: ContextMenuItem[]): string[] {
    return items.filter((i) => i.type !== "separator" && i.type !== "header").map((i) => i.label);
}

describe("the view menu by family (FR-SHELL-107)", () => {
    const hooks = { env: {} as any, at: { x: 0, y: 0 } };

    it("leaves out Reopen what was closed, the tab bar position and Copy id", () => {
        const shown = labels(viewMenuItems(target("temporary"), hooks, t));
        expect(shown).toContain("wave.tab.backgrounds");
        expect(shown).toContain("sidebar.views.close");
        for (const gone of ["wave.tab.reopenClosed", "wave.tab.tabBarPosition", "wave.tab.copyId", "wave.tab.rename"]) {
            expect(shown).not.toContain(gone);
        }
    });

    it("turns a pinned view's close note into the tooltip of Make temporary", () => {
        const items = viewMenuItems(target("workspace"), hooks, t);
        expect(labels(items)).not.toContain("sidebar.views.closeNote");
        expect(labels(items)).not.toContain("sidebar.views.close");
        const make = items.find((i) => i.label === "sidebar.pins.menu.makeTemporary");
        expect(make.tooltip).toBe("sidebar.views.closeNote");
        expect(make.enabled).not.toBe(false);
    });
});
