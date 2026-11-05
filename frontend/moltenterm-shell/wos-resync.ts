// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The objects a view holds after a websocket reconnect (#1950). A view follows its objects through update events: the
// ones published while its websocket was down never come, so a view kept alive across a reconnect showed an older
// workspace than its neighbours (the sidebar's views list and counts, a pane added meanwhile, the window's sidebar
// meta) until it was reloaded. Once the view follows its events again (ws-resubscribe.ts), it reads them again.

import { reloadCachedWaveObjects } from "@/app/store/wos";
import { onEventsResubscribed } from "./ws-resubscribe";

// What the shell draws from: the window's meta, the workspace, its tabs and their panes.
export const ResyncedOTypes = ["client", "window", "workspace", "tab", "block"] as const;

let started = false;

export function startWosResync(reload: (otypes: readonly string[]) => Promise<number> = reloadCachedWaveObjects) {
    if (started) {
        return;
    }
    started = true;
    onEventsResubscribed(() => {
        reload(ResyncedOTypes).catch((e) => console.log("ws reconnect: reading the objects again failed", e));
    });
}

export function resetWosResyncForTest() {
    started = false;
}
