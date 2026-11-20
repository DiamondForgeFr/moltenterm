// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The view a sidebar switch goes to wears its remembered layout before it is first on screen (FR-SHELL-082, #2407).
// A view kept hidden puts it on as soon as the view being left writes the switch's record (a storage event every other
// view gets, hidden or not): Electron main makes the view visible before its reinit, and the sidebar takes the record
// then, so the reinit is too late to read it. A new view reads the record before its first render (wave.ts).

import { atoms, globalStore } from "@/app/store/global";
import { isArrival, parseSwitchIntent, SwitchIntent, SwitchIntentKey } from "../sidebar/sidebar-switch";
import { arrivalPending, clearArrival, clearLeave, wearArrival } from "./layout-frames";
import { loadLayout } from "./layout-store";

function readIntent(): string {
    try {
        return window.localStorage.getItem(SwitchIntentKey);
    } catch {
        return null;
    }
}

function wearFor(intent: SwitchIntent, workspaceId: string, tabId: string): boolean {
    if (intent?.layout !== true || !workspaceId || !isArrival(intent, workspaceId, Date.now())) {
        return false;
    }
    return wearArrival(loadLayout(workspaceId), tabId);
}

function ownView(): { workspaceId: string; tabId: string } {
    return { workspaceId: globalStore.get(atoms.workspace)?.oid, tabId: globalStore.get(atoms.staticTabId) };
}

// Called at a reinit and before a first render: a view parked off screen may still hold the frames it faded into when
// it was left, and coming back it shows its own content, or the layout it is arriving into.
export function wearSwitchArrival(workspaceId: string, tabId: string): boolean {
    try {
        listenForSwitchArrival();
        clearLeave();
        if (arrivalPending()) {
            return true;
        }
        clearArrival();
        return wearFor(parseSwitchIntent(readIntent()), workspaceId, tabId);
    } catch {
        // A switch without its frames is the switch of #2390: nothing is lost.
        return false;
    }
}

function onStorage(e: StorageEvent) {
    if (e.key !== SwitchIntentKey || !e.newValue) {
        return;
    }
    try {
        const own = ownView();
        const intent = parseSwitchIntent(e.newValue);
        if (intent?.workspaceId !== own.workspaceId) {
            return;
        }
        clearLeave();
        wearFor(intent, own.workspaceId, own.tabId);
    } catch {
        // Nothing worn: the view shows as it is.
    }
}

let listening = false;

export function listenForSwitchArrival() {
    if (listening || typeof window === "undefined") {
        return;
    }
    listening = true;
    window.addEventListener("storage", onStorage);
}
