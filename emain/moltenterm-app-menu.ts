// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The app menu's Settings…, View and Window menus (FR-SHELL-096, #1325), built from callbacks so the templates are
// tested without Electron. Every label is an appMenu.* key; no label names the system, the menu exists on Linux too.

import type * as electron from "electron";
import { mt } from "./moltenterm-i18n";

// The renderer opens Preferences when it receives this (frontend/moltenterm-shell/settings/settings-menu.ts).
export const MoltentermOpenSettingsChannel = "moltenterm-open-settings";
export const MoltentermSettingsMenuId = "molten-settings";
export const MoltentermReloadViewMenuId = "molten-reload-view";
export const MoltentermDeveloperMenuId = "molten-developer";
export const MoltentermFullScreenOnLaunchMenuId = "molten-fullscreen-on-launch";

type MenuItem = electron.MenuItemConstructorOptions;
type WindowAction = (window: electron.BaseWindow) => void;

export type ViewMenuActions = {
    reload: WindowAction;
    relaunchAll: () => void;
    clearCache: () => void;
    toggleDevTools: WindowAction;
    resetZoom: WindowAction;
    zoomIn: WindowAction;
    zoomOut: WindowAction;
    setFullScreenOnLaunch: (on: boolean) => void;
};

export type ViewMenuOptions = {
    platform: string;
    builderFocused: boolean;
    fullScreenOnLaunch: boolean;
    sidebarItem: MenuItem;
    actions: ViewMenuActions;
};

// {app} › Settings… (⌘,): the same Preferences the palette's Settings opens, in the window's active view.
export function makeMoltentermSettingsMenuItem(targetOf: (window: electron.BaseWindow) => electron.WebContents): MenuItem {
    return {
        id: MoltentermSettingsMenuId,
        label: mt("appMenu.settings"),
        accelerator: "CommandOrControl+,",
        click: (_, window) => {
            const target = targetOf(window as electron.BaseWindow);
            if (target == null || target.isDestroyed()) {
                return;
            }
            target.send(MoltentermOpenSettingsChannel);
        },
    };
}

// One meaning per shortcut: ⇧⌘R is the Web page panel's reload ignoring the cache (keymodel.ts, #210), so on macOS the
// view reloads with ⌥⌘R. Elsewhere Wave's Cmd is Alt: the panel's key is Alt+Shift+R and Ctrl+Shift+R stays free.
export function reloadViewAccelerator(platform: string): string {
    return platform === "darwin" ? "Option+Command+R" : "Shift+Control+R";
}

function zoomItem(label: string, accelerator: string, action: WindowAction, hidden = false): MenuItem {
    return {
        label,
        accelerator,
        click: (_, window) => action(window as electron.BaseWindow),
        ...(hidden ? { visible: false, acceleratorWorksWhenHidden: true } : {}),
    };
}

export function makeMoltentermViewMenu(opts: ViewMenuOptions): MenuItem[] {
    const { actions } = opts;
    const devToolsAccel = opts.platform === "darwin" ? "Option+Command+I" : "Alt+Shift+I";
    const sidebar = opts.sidebarItem != null && !opts.builderFocused ? [opts.sidebarItem, { type: "separator" as const }] : [];
    return [
        ...sidebar,
        {
            id: MoltentermReloadViewMenuId,
            label: mt(opts.builderFocused ? "appMenu.reloadWindow" : "appMenu.reloadView"),
            accelerator: reloadViewAccelerator(opts.platform),
            click: (_, window) => actions.reload(window as electron.BaseWindow),
        },
        { label: mt("appMenu.relaunchAllWindows"), click: () => actions.relaunchAll() },
        { type: "separator" },
        zoomItem(mt("appMenu.resetZoom"), "CommandOrControl+0", actions.resetZoom),
        zoomItem(mt("appMenu.zoomIn"), "CommandOrControl+=", actions.zoomIn),
        zoomItem("Zoom In (hidden)", "CommandOrControl+Shift+=", actions.zoomIn, true),
        zoomItem(mt("appMenu.zoomOut"), "CommandOrControl+-", actions.zoomOut),
        zoomItem("Zoom Out (hidden)", "CommandOrControl+Shift+-", actions.zoomOut, true),
        { type: "separator" },
        { role: "togglefullscreen", label: mt("appMenu.toggleFullScreen") },
        {
            id: MoltentermFullScreenOnLaunchMenuId,
            label: mt("appMenu.fullScreenOnLaunch"),
            type: "checkbox",
            checked: !!opts.fullScreenOnLaunch,
            click: (item) => actions.setFullScreenOnLaunch(!!item.checked),
        },
        { type: "separator" },
        {
            id: MoltentermDeveloperMenuId,
            label: mt("appMenu.developer"),
            submenu: [
                { label: mt("appMenu.clearViewCache"), click: () => actions.clearCache() },
                {
                    label: mt("appMenu.toggleDevTools"),
                    accelerator: devToolsAccel,
                    click: (_, window) => actions.toggleDevTools(window as electron.BaseWindow),
                },
            ],
        },
    ];
}

export function makeMoltentermWindowMenu(): MenuItem[] {
    return [
        { role: "minimize", label: mt("appMenu.minimizeWindow"), accelerator: "" },
        { role: "zoom", label: mt("appMenu.zoom") },
        { type: "separator" },
        { role: "front", label: mt("appMenu.front") },
    ];
}
