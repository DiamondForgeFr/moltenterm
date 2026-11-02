// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));
vi.mock("./moltenterm-i18n", () => ({ mt: (key: string) => key }));

import { electronAccelerator } from "../frontend/moltenterm-shell/shortcuts/format";
import { Shortcuts } from "../frontend/moltenterm-shell/shortcuts/registry";
import en from "../frontend/moltenterm-shell/i18n/locales/en.json";
import fr from "../frontend/moltenterm-shell/i18n/locales/fr.json";
import {
    makeMoltentermSettingsMenuItem,
    makeMoltentermViewMenu,
    makeMoltentermWindowMenu,
    MoltentermDeveloperMenuId,
    MoltentermFullScreenOnLaunchMenuId,
    MoltentermOpenSettingsChannel,
    MoltentermReloadViewMenuId,
    MoltentermSettingsMenuId,
    reloadViewAccelerator,
    ViewMenuActions,
} from "./moltenterm-app-menu";

type Item = Electron.MenuItemConstructorOptions;

function actions(): ViewMenuActions {
    return {
        reload: vi.fn(),
        relaunchAll: vi.fn(),
        clearCache: vi.fn(),
        toggleDevTools: vi.fn(),
        resetZoom: vi.fn(),
        zoomIn: vi.fn(),
        zoomOut: vi.fn(),
        setFullScreenOnLaunch: vi.fn(),
    };
}

function viewMenu(platform = "darwin", over: Partial<Parameters<typeof makeMoltentermViewMenu>[0]> = {}) {
    return makeMoltentermViewMenu({
        platform,
        builderFocused: false,
        fullScreenOnLaunch: false,
        sidebarItem: { id: "sidebar", label: "appMenu.toggleSidebar" },
        actions: actions(),
        ...over,
    });
}

function flatten(items: Item[]): Item[] {
    return items.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? flatten(i.submenu as Item[]) : [])]);
}

function byId(items: Item[], id: string): Item {
    return flatten(items).find((i) => i.id === id);
}

function labels(items: Item[]): string[] {
    return flatten(items)
        .filter((i) => i.type !== "separator" && i.visible !== false)
        .map((i) => i.label);
}

// "Option+Command+R" and "Command+Option+R" are the same keys.
function keysOf(accelerator: string, mac: boolean): string {
    return accelerator
        .replace("CommandOrControl", mac ? "Command" : "Control")
        .split("+")
        .sort()
        .join("+");
}

describe("{app} › Settings… (FR-SHELL-096-AC2)", () => {
    it("shows ⌘, and asks the window's active view to open Preferences", () => {
        const tab = { send: vi.fn(), isDestroyed: () => false } as any;
        const item = makeMoltentermSettingsMenuItem(() => tab);
        expect(item.id).toBe(MoltentermSettingsMenuId);
        expect(item.label).toBe("appMenu.settings");
        expect(item.accelerator).toBe("CommandOrControl+,");
        (item.click as any)(null, {}, {});
        expect(tab.send).toHaveBeenCalledExactlyOnceWith(MoltentermOpenSettingsChannel);
    });

    it("does nothing without a live view", () => {
        const gone = { send: vi.fn(), isDestroyed: () => true } as any;
        expect(() => (makeMoltentermSettingsMenuItem(() => null).click as any)(null, null, {})).not.toThrow();
        (makeMoltentermSettingsMenuItem(() => gone).click as any)(null, {}, {});
        expect(gone.send).not.toHaveBeenCalled();
    });

    it("sits in the app menu, on the channel the preload listens on", () => {
        const preload = readFileSync(new URL("./preload.ts", import.meta.url), "utf8");
        expect(preload).toContain(`ipcRenderer.on("${MoltentermOpenSettingsChannel}"`);
        const menu = readFileSync(new URL("./emain-menu.ts", import.meta.url), "utf8");
        expect(menu).toMatch(/function makeAppMenuItems[\s\S]*?makeMoltentermSettingsMenuItem\(/);
    });
});

describe("View (FR-SHELL-096-AC3)", () => {
    it("has no widgets entry and says Reload view", () => {
        const items = viewMenu();
        expect(labels(items).filter((l) => /widget/i.test(l))).toEqual([]);
        expect(byId(items, MoltentermReloadViewMenuId).label).toBe("appMenu.reloadView");
        expect(byId(viewMenu("darwin", { builderFocused: true }), MoltentermReloadViewMenuId).label).toBe(
            "appMenu.reloadWindow"
        );
    });

    it("puts the cache and DevTools under Developer, nowhere else", () => {
        const items = viewMenu();
        const dev = byId(items, MoltentermDeveloperMenuId);
        expect((dev.submenu as Item[]).map((i) => i.label)).toEqual(["appMenu.clearViewCache", "appMenu.toggleDevTools"]);
        expect(items.map((i) => i.label)).not.toContain("appMenu.clearViewCache");
        expect(items.map((i) => i.label)).not.toContain("appMenu.toggleDevTools");
    });

    it("reads Zoom in and Zoom out, and labels full screen", () => {
        const shown = labels(viewMenu());
        expect(shown).toEqual(expect.arrayContaining(["appMenu.resetZoom", "appMenu.zoomIn", "appMenu.zoomOut"]));
        expect(viewMenu().find((i) => i.role === "togglefullscreen")?.label).toBe("appMenu.toggleFullScreen");
    });

    it("makes Full screen at launch a checkbox that writes the setting", () => {
        const acts = actions();
        const item = byId(viewMenu("darwin", { fullScreenOnLaunch: true, actions: acts }), MoltentermFullScreenOnLaunchMenuId);
        expect(item.type).toBe("checkbox");
        expect(item.checked).toBe(true);
        expect(item.submenu).toBeUndefined();
        (item.click as any)({ checked: false }, {}, {});
        expect(acts.setFullScreenOnLaunch).toHaveBeenCalledWith(false);
    });

    it("keeps the sidebar entry first, and leaves it out of a builder window", () => {
        expect(viewMenu()[0].id).toBe("sidebar");
        expect(byId(viewMenu("darwin", { builderFocused: true }), "sidebar")).toBeUndefined();
    });

    it("gives Reload view a key no shortcut of the app uses (one meaning per key)", () => {
        for (const [platform, mac] of [
            ["darwin", true],
            ["linux", false],
        ] as const) {
            const reload = keysOf(reloadViewAccelerator(platform), mac);
            const taken = Shortcuts.map((s) => electronAccelerator(s.keys, mac))
                .filter((a) => a !== "")
                .map((a) => keysOf(a, mac));
            expect(taken, platform).not.toContain(reload);
        }
    });
});

describe("Window (FR-SHELL-096-AC4)", () => {
    it("says Minimize window", () => {
        expect(makeMoltentermWindowMenu()[0]).toMatchObject({ role: "minimize", label: "appMenu.minimizeWindow" });
    });
});

describe("every menu label comes from en.json and fr.json (FR-SHELL-096-AC5)", () => {
    const appMenuEn = en.appMenu as Record<string, string>;
    const appMenuFr = fr.appMenu as Record<string, string>;

    it("labels the built menus with appMenu keys both dictionaries hold", () => {
        const shown = [
            ...labels(viewMenu()),
            ...labels(viewMenu("linux", { builderFocused: true })),
            ...labels(makeMoltentermWindowMenu()),
            makeMoltentermSettingsMenuItem(() => null).label,
        ];
        for (const label of shown) {
            expect(label, label).toMatch(/^appMenu\./);
            const key = label.slice("appMenu.".length);
            expect(appMenuEn[key], label).toBeTruthy();
            expect(appMenuFr[key], label).toBeTruthy();
        }
    });

    it("asks only for keys both dictionaries hold, and writes no visible label by hand", () => {
        for (const file of ["./emain-menu.ts", "./moltenterm-app-menu.ts"]) {
            const src = readFileSync(new URL(file, import.meta.url), "utf8");
            for (const m of src.matchAll(/mt\(\s*"appMenu\.(\w+)"/g)) {
                expect(appMenuEn[m[1]], `${file} appMenu.${m[1]}`).toBeTruthy();
                expect(appMenuFr[m[1]], `${file} appMenu.${m[1]}`).toBeTruthy();
            }
            for (const m of src.matchAll(/label: "([^"]*)"/g)) {
                expect(m[1], file).toContain("(hidden");
            }
        }
    });

    it("names no system in a menu label", () => {
        for (const text of [...Object.values(appMenuEn), ...Object.values(appMenuFr)]) {
            expect(text).not.toMatch(/\b(Dock|Finder|mac ?OS|Mac|Linux|Explorer)\b/);
        }
    });
});
