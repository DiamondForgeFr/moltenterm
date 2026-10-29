// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The app menu's View and Help menus (FR-SHELL-113, #1350), built from a target finder so the templates are tested
// without Electron. Each item sends a command to the window's active view, which runs it (frontend/moltenterm-shell/
// menu/app-menu-commands.ts): an item with a shortcut runs that key's own handler. The shortcut is shown, never
// registered: the view's key model owns it, so a focused page or editor keeps it, and a key press that reaches the
// menu does nothing (the view already handled it).

import type * as electron from "electron";
import { AppMenuCommand, AppMenuCommandChannel } from "../frontend/moltenterm-shell/menu/app-menu-model";
import { mt } from "./moltenterm-i18n";

export const MoltentermViewMenuId = "molten-view-menu";
export const MoltentermHelpMenuId = "molten-help-menu";

type MenuItem = electron.MenuItemConstructorOptions;
type TargetOf = (window: electron.BaseWindow) => electron.WebContents;

// The keys of the shortcut registry (frontend/moltenterm-shell/shortcuts/registry.ts), in Wave's notation where Cmd is
// Command on macOS and Alt elsewhere. moltenterm-view-menu.test.ts checks them against the registry.
export const AppMenuKeys: Partial<Record<AppMenuCommand, string>> = {
    newview: "Cmd:t",
    closeview: "Cmd:Shift:w",
    reopen: "Cmd:Shift:t",
    nextview: "Cmd:]",
    previousview: "Cmd:[",
    shortcuts: "Cmd:/",
    palette: "Cmd:Shift:k",
};

const AcceleratorMods: Record<string, { mac: string; other: string }> = {
    Cmd: { mac: "Command", other: "Alt" },
    Ctrl: { mac: "Control", other: "Control" },
    Shift: { mac: "Shift", other: "Shift" },
    Alt: { mac: "Option", other: "Alt" },
};

// Wave's key notation as an Electron accelerator for the platform.
export function menuAccelerator(keys: string, platform: string): string {
    const parts = (keys ?? "").split(":").filter((p) => p !== "");
    const key = parts.pop();
    if (!key) {
        return "";
    }
    const mac = platform === "darwin";
    const mods = parts.map((m) => (mac ? AcceleratorMods[m]?.mac : AcceleratorMods[m]?.other) ?? m);
    return [...mods, key.length === 1 ? key.toUpperCase() : key].join("+");
}

function commandItem(command: AppMenuCommand, label: string, targetOf: TargetOf, platform: string): MenuItem {
    const keys = AppMenuKeys[command];
    const item: MenuItem = {
        id: `molten-menu-${command}`,
        label,
        click: (_, window, event) => {
            if (event?.triggeredByAccelerator) {
                return;
            }
            const target = targetOf(window as electron.BaseWindow);
            if (target == null || target.isDestroyed()) {
                return;
            }
            target.send(AppMenuCommandChannel, command);
        },
    };
    if (keys) {
        item.accelerator = menuAccelerator(keys, platform);
        item.registerAccelerator = false;
    }
    return item;
}

// View: the views of the workspace, with their keys (the audit's section 13: none of them was in a menu).
export function makeMoltentermViewsMenu(targetOf: TargetOf, platform: string): MenuItem[] {
    const item = (command: AppMenuCommand, label: string) => commandItem(command, label, targetOf, platform);
    return [
        item("newview", mt("appMenu.newView")),
        item("closeview", mt("appMenu.closeView")),
        item("reopen", mt("appMenu.reopenClosed")),
        { type: "separator" },
        item("nextview", mt("appMenu.nextView")),
        item("previousview", mt("appMenu.previousView")),
        { type: "separator" },
        item("project", mt("appMenu.project")),
        item("integration", mt("appMenu.integration")),
        item("scoping", mt("workspaceViews.names.scoping")),
        item("pilotage", mt("workspaceViews.names.pilotage")),
    ];
}

// Help: Getting started (moved here from the app menu), the shortcut overlay and the palette, in the top field.
export function makeMoltentermHelpMenu(gettingStarted: MenuItem, targetOf: TargetOf, platform: string): MenuItem[] {
    return [
        gettingStarted,
        { type: "separator" },
        commandItem("shortcuts", mt("appMenu.shortcuts"), targetOf, platform),
        commandItem("palette", mt("appMenu.palette"), targetOf, platform),
    ];
}

// The two menus: View goes between Display and Workspace, Help after Window, last as on every platform.
export function makeMoltentermMenus(
    gettingStarted: MenuItem,
    targetOf: TargetOf,
    platform: string
): { views: MenuItem; help: MenuItem } {
    return {
        views: {
            id: MoltentermViewMenuId,
            label: mt("appMenu.viewsMenu"),
            submenu: makeMoltentermViewsMenu(targetOf, platform),
        },
        help: {
            id: MoltentermHelpMenuId,
            role: "help",
            label: mt("appMenu.help"),
            submenu: makeMoltentermHelpMenu(gettingStarted, targetOf, platform),
        },
    };
}
