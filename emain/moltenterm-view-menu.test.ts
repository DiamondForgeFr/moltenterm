// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The app menu's View and Help menus (FR-SHELL-113, AC-3), tested through their templates: the native menu cannot be
// reached from the page, so the items, their shortcuts and what a click sends are checked here.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("./moltenterm-i18n", () => ({ mt: (key: string) => key }));

import { AppMenuCommandChannel, AppMenuCommandShortcuts } from "../frontend/moltenterm-shell/menu/app-menu-model";
import { electronAccelerator } from "../frontend/moltenterm-shell/shortcuts/format";
import { findShortcut } from "../frontend/moltenterm-shell/shortcuts/registry";
import {
    AppMenuKeys,
    makeMoltentermHelpMenu,
    makeMoltentermMenus,
    makeMoltentermViewsMenu,
    menuAccelerator,
} from "./moltenterm-view-menu";

type Item = Electron.MenuItemConstructorOptions;

function fakeTarget() {
    const send = vi.fn();
    return { send, contents: { send, isDestroyed: () => false } as unknown as Electron.WebContents };
}

function click(item: Item, triggeredByAccelerator = false) {
    (item.click as any)(item, {}, { triggeredByAccelerator });
}

function labelled(items: Item[]): Item[] {
    return items.filter((i) => i.type !== "separator");
}

const Gs: Item = { id: "molten-getting-started", label: "appMenu.gettingStarted" };

describe("View menu (FR-SHELL-113)", () => {
    it("lists the view actions, then the views to go to", () => {
        const items = makeMoltentermViewsMenu(() => null, "darwin");
        expect(labelled(items).map((i) => i.label)).toEqual([
            "appMenu.newView",
            "appMenu.closeView",
            "appMenu.reopenClosed",
            "appMenu.nextView",
            "appMenu.previousView",
            "appMenu.project",
            "appMenu.integration",
            "workspaceViews.names.scoping",
            "workspaceViews.names.pilotage",
        ]);
    });

    it("shows each action's shortcut without registering it", () => {
        const items = labelled(makeMoltentermViewsMenu(() => null, "darwin"));
        expect(items.map((i) => i.accelerator ?? "")).toEqual([
            "Command+T",
            "Command+Shift+W",
            "Command+Shift+T",
            "Command+]",
            "Command+[",
            "",
            "",
            "",
            "",
        ]);
        for (const item of items.filter((i) => i.accelerator)) {
            expect(item.registerAccelerator, String(item.label)).toBe(false);
        }
    });

    it("off macOS shows Wave's Cmd as Alt", () => {
        const items = labelled(makeMoltentermViewsMenu(() => null, "linux"));
        expect(items[0].accelerator).toBe("Alt+T");
        expect(items[1].accelerator).toBe("Alt+Shift+W");
    });

    it("a click sends its command to the window's active view", () => {
        const target = fakeTarget();
        const items = labelled(makeMoltentermViewsMenu(() => target.contents, "darwin"));
        const sent = items.map((item) => {
            target.send.mockClear();
            click(item);
            return target.send.mock.calls[0];
        });
        expect(sent).toEqual(
            [
                "newview",
                "closeview",
                "reopen",
                "nextview",
                "previousview",
                "project",
                "integration",
                "scoping",
                "pilotage",
            ].map((c) => [AppMenuCommandChannel, c])
        );
    });

    it("a key press that reaches the menu does nothing: the view's key model already ran it", () => {
        const target = fakeTarget();
        const [newView] = makeMoltentermViewsMenu(() => target.contents, "darwin");
        click(newView, true);
        expect(target.send).not.toHaveBeenCalled();
    });

    it("does nothing without a live view", () => {
        const [newView] = makeMoltentermViewsMenu(() => null, "darwin");
        expect(() => click(newView)).not.toThrow();
    });
});

describe("Help menu (FR-SHELL-113)", () => {
    it("holds Getting started, the shortcut overlay and the palette", () => {
        const target = fakeTarget();
        const items = labelled(makeMoltentermHelpMenu(Gs, () => target.contents, "darwin"));
        expect(items.map((i) => i.label)).toEqual(["appMenu.gettingStarted", "appMenu.shortcuts", "appMenu.palette"]);
        expect(items.map((i) => i.accelerator ?? "")).toEqual(["", "Command+/", "Command+Shift+K"]);
        click(items[1]);
        click(items[2]);
        expect(target.send.mock.calls).toEqual([
            [AppMenuCommandChannel, "shortcuts"],
            [AppMenuCommandChannel, "palette"],
        ]);
    });

    it("is the help role, and both menus have their titles", () => {
        const { views, help } = makeMoltentermMenus(Gs, () => null, "darwin");
        expect(views.label).toBe("appMenu.viewsMenu");
        expect(help.label).toBe("appMenu.help");
        expect(help.role).toBe("help");
    });
});

describe("the menus and the keys agree", () => {
    it("each shortcut is the registry's, on both platforms", () => {
        for (const [command, shortcutId] of Object.entries(AppMenuCommandShortcuts)) {
            const shortcut = findShortcut(shortcutId);
            expect(shortcut, shortcutId).not.toBeNull();
            expect(AppMenuKeys[command], command).toBe(shortcut.keys);
            for (const platform of ["darwin", "linux"]) {
                expect(menuAccelerator(AppMenuKeys[command], platform), `${command} ${platform}`).toBe(
                    electronAccelerator(shortcut.keys, platform === "darwin")
                );
            }
        }
    });

    it("each key has a handler in the key model, which the menu runs", () => {
        const sources = [
            "../frontend/app/store/keymodel.ts",
            "../frontend/moltenterm-shell/reopen/reopen-store.ts",
            "../frontend/moltenterm-shell/palette/palette-keys.ts",
            "../frontend/moltenterm-shell/shortcuts/registry.ts",
        ]
            .map((p) => fs.readFileSync(path.resolve(__dirname, p), "utf8"))
            .join("\n");
        for (const keys of Object.values(AppMenuKeys)) {
            expect(sources, keys).toContain(`"${keys}"`);
        }
    });

    it("Getting started left the app menu for Help", () => {
        const menu = fs.readFileSync(path.resolve(__dirname, "emain-menu.ts"), "utf8");
        const appItems = menu.slice(menu.indexOf("function makeAppMenuItems"), menu.indexOf("function makeViewMenu"));
        expect(appItems).not.toContain("makeMoltentermGettingStartedMenuItem(");
        expect(menu).toContain("makeMoltentermMenus(");
    });
});
