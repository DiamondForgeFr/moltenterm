// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The right-click menu of a browser tab (FR-SHELL-051, DS-SHELL-092): Reload, Duplicate, Copy link, Close, Close
// others, shown by the MenuHost like every MoltenTerm menu, with the icons of the command panel's rows for the same
// actions (FR-SHELL-054).

import { BrowserState, BrowserTab } from "./browser-model";

export type BrowserTabActions = {
    reloadTab: (id: string) => void;
    duplicateTab: (id: string) => void;
    copyTabLink: (id: string) => void;
    closeTab: (id: string) => void;
    closeOtherTabs: (id: string) => void;
};

// Unavailable actions are absent, not disabled (FR-SHELL-049), as in the command panel: a page handed off to the
// installed browser has no Reload, a tab without an address no Copy link, and the last tab (it closes with its panel,
// Cmd+W) neither Close nor Close others.
export function browserTabMenu(state: BrowserState, tab: BrowserTab, actions: BrowserTabActions): ContextMenuItem[] {
    if (tab == null) {
        return [];
    }
    const menu: ContextMenuItem[] = [];
    if (!tab.engine) {
        menu.push({ label: "Reload", icon: "rotate-right", click: () => actions.reloadTab(tab.id) });
    }
    menu.push({ label: "Duplicate", icon: "clone", click: () => actions.duplicateTab(tab.id) });
    if (tab.url) {
        menu.push({ label: "Copy link", icon: "link", click: () => actions.copyTabLink(tab.id) });
    }
    if (state.tabs.length > 1) {
        menu.push(
            { type: "separator" },
            { label: "Close", icon: "xmark", click: () => actions.closeTab(tab.id) },
            { label: "Close others", icon: "xmark", click: () => actions.closeOtherTabs(tab.id) }
        );
    }
    return menu;
}
