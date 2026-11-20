// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The view a sidebar switch goes to wears its remembered layout before it is first on screen (FR-SHELL-082, #2407):
// wave.ts calls this at the start of a reinit (a view kept hidden) and before the first render (a new view), so the
// first frame Electron main shows already holds the frames the view left faded into.

import { isArrival, parseSwitchIntent, SwitchIntentKey } from "../sidebar/sidebar-switch";
import { clearLeave, wearArrival } from "./layout-frames";
import { readLayout } from "./layout-memory";

function readIntent(): string {
    try {
        return window.localStorage.getItem(SwitchIntentKey);
    } catch {
        return null;
    }
}

export function wearSwitchArrival(workspaceId: string, tabId: string): boolean {
    try {
        // A view parked off screen may still be "visible" to itself and hold the frames it faded into when it was left:
        // coming back, it shows its own content.
        clearLeave();
        const intent = parseSwitchIntent(readIntent());
        if (intent?.layout !== true || !isArrival(intent, workspaceId, Date.now())) {
            return false;
        }
        return wearArrival(readLayout(workspaceId), tabId);
    } catch {
        // A switch without its frames is the switch of #2390: nothing is lost.
        return false;
    }
}
