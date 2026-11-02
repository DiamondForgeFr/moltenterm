// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The app menu's View and Help items run here, in the window's active view (FR-SHELL-113). An item bound to a key runs
// that key's handler of the key model, so the menu and the key never drift apart; the others go to a view. Their code
// loads on the first click, out of the JS every view loads up front (NFR-PERF-003).

import { atoms, getApi, globalStore } from "@/app/store/global";
import * as WOS from "@/app/store/wos";
import { fireAndForget } from "@/util/util";
import { t } from "../i18n/i18n";
import { findShortcut } from "../shortcuts/registry";
import {
    AppMenuCommand,
    AppMenuCommandShortcuts,
    AppMenuWorkspaceViewKeys,
    isAppMenuCommand,
    MenuTab,
    workspaceViewTabId,
} from "./app-menu-model";

type KeyMap = Map<string, (e: WaveKeyboardEvent) => boolean>;

type AppMenuApi = { onMoltentermAppMenuCommand?: (callback: (command: string) => void) => void };

// must match MoltentermProjectView (project/project-model.ts) and MoltentermReviewsView (reviews/reviews-model.ts),
// kept as text so this file stays light
const ProjectView = "molten-project";
const IntegrationView = "molten-reviews";

let keyMap: KeyMap = null;
let listening = false;

// Runs the handler the key model binds to a registry shortcut; false when the key has none.
export function runShortcutKey(keys: KeyMap, shortcutId: string): boolean {
    const shortcut = findShortcut(shortcutId);
    const handler = shortcut == null ? null : keys?.get(shortcut.keys);
    if (handler == null) {
        return false;
    }
    handler(null);
    return true;
}

// The top row's view of the panel, else the panel itself in a temporary view (FR-SHELL-094).
async function goToPanel(view: string): Promise<void> {
    const { ViewPins } = await import("../sidebar/view-pins-store");
    if (await ViewPins.getInstance().openPinShowing(view)) {
        return;
    }
    const { openMoltentermView } = await import("../open-view");
    await openMoltentermView(view);
}

async function loadTab(tabId: string): Promise<MenuTab> {
    const oref = WOS.makeORef("tab", tabId);
    let tab = WOS.getObjectValue<Tab>(oref);
    if (tab == null) {
        try {
            tab = await WOS.reloadWaveObject<Tab>(oref);
        } catch {
            return null;
        }
    }
    return tab == null ? null : { id: tabId, meta: tab.meta };
}

// A view of the workspace's template (Scoping, Control room). A workspace made before the template, or one whose view
// was removed, has none: a toast says so rather than nothing happening.
async function goToWorkspaceView(nameKey: string): Promise<void> {
    const ws = globalStore.get(atoms.workspace);
    const tabs = await Promise.all((ws?.tabids ?? []).map(loadTab));
    const tabId = workspaceViewTabId(tabs, nameKey);
    if (tabId) {
        const { showTabFromHere } = await import("../opener-tab");
        showTabFromHere(tabId);
        return;
    }
    const { showToast } = await import("../toast-store");
    showToast({ kind: "info", title: t("appMenu.noWorkspaceView", { name: t(nameKey) }) });
}

export async function runAppMenuCommand(command: AppMenuCommand, keys: KeyMap = keyMap): Promise<void> {
    const shortcutId = AppMenuCommandShortcuts[command];
    if (shortcutId) {
        runShortcutKey(keys, shortcutId);
        return;
    }
    const nameKey = AppMenuWorkspaceViewKeys[command];
    if (nameKey) {
        await goToWorkspaceView(nameKey);
        return;
    }
    if (command === "project") {
        await goToPanel(ProjectView);
        return;
    }
    if (command === "integration") {
        await goToPanel(IntegrationView);
    }
}

// Called once per view by the key model's registration (palette/palette-keys.ts), with the map it fills.
export function listenAppMenuCommands(keys: KeyMap): void {
    keyMap = keys;
    if (listening) {
        return;
    }
    listening = true;
    (getApi?.() as unknown as AppMenuApi)?.onMoltentermAppMenuCommand?.((command) => {
        if (!isAppMenuCommand(command)) {
            return;
        }
        fireAndForget(() => runAppMenuCommand(command));
    });
}
