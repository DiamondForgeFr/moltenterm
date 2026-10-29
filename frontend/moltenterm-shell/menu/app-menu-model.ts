// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The app menu's View and Help menus (FR-SHELL-113): what each item asks the active view's renderer to do. Pure data
// shared by Electron main (emain/moltenterm-view-menu.ts builds the menus) and the renderer (app-menu-commands.ts runs
// the commands), so neither side spells an id the other does not know.

// Main sends the command's id on this channel to the window's active view (emain/preload.ts).
export const AppMenuCommandChannel = "moltenterm-app-menu-command";

export const AppMenuCommands = [
    "newview",
    "closeview",
    "reopen",
    "nextview",
    "previousview",
    "project",
    "integration",
    "scoping",
    "pilotage",
    "shortcuts",
    "palette",
] as const;

export type AppMenuCommand = (typeof AppMenuCommands)[number];

// A command bound to a key runs that key's own handler in the renderer's key model, so the menu does exactly what the
// key does, whatever later changes the key gets. The ids are the shortcut registry's (shortcuts/registry.ts).
export const AppMenuCommandShortcuts: Partial<Record<AppMenuCommand, string>> = {
    newview: "new-tab",
    closeview: "close-tab",
    reopen: "reopen-closed",
    nextview: "next-tab",
    previousview: "previous-tab",
    shortcuts: "shortcuts",
    palette: "palette",
};

// The workspace views the menu goes to (FR-SHELL-092): found by the name key wavesrv stored on them, so a view the
// developer renamed is still found. Must match workspace-views/workspace-views-model.ts ViewNameKeyPrefix.
export const AppMenuWorkspaceViewKeys: Partial<Record<AppMenuCommand, string>> = {
    scoping: "workspaceViews.names.scoping",
    pilotage: "workspaceViews.names.pilotage",
};

// Must match workspace-views/workspace-views-model.ts ViewNameKeyMetaKey.
const ViewNameKeyMetaKey = "molten:viewnamekey";

export function isAppMenuCommand(value: unknown): value is AppMenuCommand {
    return typeof value === "string" && (AppMenuCommands as readonly string[]).includes(value);
}

export type MenuTab = { id: string; meta?: Record<string, any> };

// The workspace's view a menu item goes to: the first one, in the workspace's order, that carries the name key. A view
// the developer put away counts too: showing it brings it back, as Go to does (hidden-tabs.ts).
export function workspaceViewTabId(tabs: MenuTab[], nameKey: string): string {
    if (!nameKey) {
        return null;
    }
    const tab = (tabs ?? []).find((t) => t?.id && t.meta?.[ViewNameKeyMetaKey] === nameKey);
    return tab?.id ?? null;
}
