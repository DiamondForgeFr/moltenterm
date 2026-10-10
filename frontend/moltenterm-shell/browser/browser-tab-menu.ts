// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The right-click menu of a browser tab (FR-SHELL-051, DS-SHELL-092): Reload, Duplicate, Copy link, Close, Close
// others, shown by the MenuHost like every MoltenTerm menu.

import { BrowserState, BrowserTab } from "./browser-model";

export type BrowserTabActions = {
    reloadTab: (id: string) => void;
    duplicateTab: (id: string) => void;
    copyTabLink: (id: string) => void;
    closeTab: (id: string) => void;
    closeOtherTabs: (id: string) => void;
};

// The last tab closes with its panel (Cmd+W), so Close and Close others are offered only while another tab remains.
export function browserTabMenu(state: BrowserState, tab: BrowserTab, actions: BrowserTabActions): ContextMenuItem[] {
    if (tab == null) {
        return [];
    }
    const menu: ContextMenuItem[] = [];
    if (!tab.engine) {
        menu.push({ label: "Reload", click: () => actions.reloadTab(tab.id) });
    }
    menu.push(
        { label: "Duplicate", click: () => actions.duplicateTab(tab.id) },
        { label: "Copy link", click: () => actions.copyTabLink(tab.id), enabled: !!tab.url }
    );
    if (state.tabs.length > 1) {
        menu.push(
            { type: "separator" },
            { label: "Close", click: () => actions.closeTab(tab.id) },
            { label: "Close others", click: () => actions.closeOtherTabs(tab.id) }
        );
    }
    return menu;
}
