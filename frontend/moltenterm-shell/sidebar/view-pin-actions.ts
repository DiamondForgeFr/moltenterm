// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The view menu's pin moves as actions (FR-SHELL-081, #1652): the menu, the command palette and the keep shortcut run
// the same ones, so the rules stay the menu's (a temporary view's pins open the pin page, a view pinned everywhere
// forks as #1272 says, the Project tab never moves).

import { atoms, globalStore, WOS } from "@/app/store/global";
import { isMacOS } from "@/util/platformutil";
import { fireAndForget } from "@/util/util";
import { t } from "../i18n/i18n";
import { formatShortcutById } from "../shortcuts/format";
import { findShortcut } from "../shortcuts/registry";
import { showToast } from "../toast-store";
import { SidebarModel } from "./sidebar-store";
import { keepToggleMove, PinMove, pinMoves, viewMenuPlan } from "./view-menu-model";
import { isProjectTab, ViewState } from "./view-pins-model";
import { shownName, ViewPins, ViewRef } from "./view-pins-store";

export function keepViewShortcutId(mac = isMacOS()): string {
    return mac ? "keep-view" : "keep-view-other";
}

export function keepViewKeysLabel(mac = isMacOS()): string {
    return formatShortcutById(keepViewShortcutId(mac), mac);
}

export type PinMoveTarget = { ref: ViewRef; state: ViewState; name: string };

// The pin page lives in the sidebar: a hidden one floats out for it, as it does on hover.
function showPinPage(tabId: string, name: string, scope: "here" | "everywhere") {
    const sidebar = SidebarModel.getInstance();
    if (sidebar.isHidden()) {
        sidebar.setPeek(true);
    }
    ViewPins.getInstance().openPinPage(tabId, name, scope);
}

export function runPinMove(target: PinMoveTarget, move: PinMove) {
    const pins = ViewPins.getInstance();
    const tabId = target.ref.tabId;
    switch (move) {
        case "here":
            if (target.state === "temporary") {
                showPinPage(tabId, target.name, "here");
                return;
            }
            fireAndForget(() => pins.pinOnlyHere(tabId, target.ref.pinId));
            return;
        case "everywhere":
            if (target.state === "temporary") {
                showPinPage(tabId, target.name, "everywhere");
                return;
            }
            fireAndForget(() => pins.pinEverywhere(tabId, target.name));
            return;
        case "temporary":
            fireAndForget(() => (tabId ? pins.unpin(tabId) : pins.unpinGlobal(target.ref.pinId)));
            return;
    }
}

export type CurrentView = PinMoveTarget & { modified: boolean; projectTab: boolean };

// The view on screen, as its menu sees it.
export function currentView(): CurrentView {
    const tabId = globalStore.get(atoms.staticTabId);
    if (!tabId) {
        return null;
    }
    const tab = globalStore.get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
    if (tab == null) {
        return null;
    }
    const pins = ViewPins.getInstance();
    const state = globalStore.get(pins.stateAtom(tabId));
    const pin = state === "everywhere" ? pins.pinOf({ tabId }) : null;
    return {
        ref: { tabId },
        state,
        modified: globalStore.get(pins.modifiedAtom(tabId)),
        projectTab: isProjectTab(tab),
        name: pin?.name ?? shownName(tab),
    };
}

// The moves the view's menu offers, for the palette.
export function currentPinMoves(view: CurrentView): PinMove[] {
    if (view == null) {
        return [];
    }
    return pinMoves(viewMenuPlan(view.state, view.modified, view.projectTab));
}

// The keep shortcut: a temporary view is pinned in its workspace at once (the pin page is for choosing; the key has
// one meaning), a view pinned in its workspace becomes temporary; both with the move's Undo message.
export function toggleKeepFromKey(): boolean {
    const view = currentView();
    if (view == null || view.projectTab) {
        return false;
    }
    const move = keepToggleMove(view.state, view.projectTab);
    if (move == null) {
        showToast({
            id: `keep-view:${view.ref.tabId}`,
            title: t("sidebar.pins.keepKey.everywhere", { name: view.name }),
            message: t("sidebar.pins.keepKey.everywhereHint"),
        });
        return true;
    }
    const pins = ViewPins.getInstance();
    if (move === "here") {
        fireAndForget(() => pins.pinHere(view.ref.tabId, view.name));
        return true;
    }
    runPinMove(view, move);
    return true;
}

export function registerKeepViewKeys(keyMap: Map<string, (e: WaveKeyboardEvent) => boolean>) {
    const shortcut = findShortcut(keepViewShortcutId());
    if (shortcut == null) {
        return;
    }
    keyMap.set(shortcut.keys, () => toggleKeepFromKey());
}
