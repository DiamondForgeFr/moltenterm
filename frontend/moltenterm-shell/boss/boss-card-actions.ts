// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the Sessions card's buttons do (FR-BOSS-002): the Sessions view's own doors, so the card has no second
// implementation of showing a session, opening the full view or starting a terminal.

import { getApi } from "@/app/store/global";
import { openAppPanel } from "../app-panel";
import { openMoltentermView } from "../open-view";
import { showPane } from "../sessions/pane-focus";
import { MoltentermSessionsView, SessionLocation } from "../sessions/sessions-model";
import { DurableSessions } from "../sessions/sessions-store";

// Asks wavesrv where the session's pane is (it opens one beside the developer's when the session has none).
export function locateSession(id: string): Promise<SessionLocation> {
    return DurableSessions.getInstance().show(id);
}

// Takes the window to the pane: its workspace, its view, its tab, and the focus in it. A pane just opened for a
// session that had none is already where the developer is.
export function goToLocation(loc: SessionLocation): void {
    if (loc == null || loc.created) {
        return;
    }
    showPane(loc);
}

export function openSessionsView(): Promise<void> {
    return openMoltentermView(MoltentermSessionsView);
}

// A terminal in the view the developer is in, through the door every app action uses: a pinned view is left as it was.
export function startTerminal(): Promise<void> {
    return openAppPanel({ meta: { view: "term", controller: "shell" } }, { match: () => false });
}

let homeDir: string = null;

export function homeFolder(): string {
    if (homeDir == null) {
        try {
            homeDir = getApi()?.getHomeDir?.() ?? "";
        } catch {
            homeDir = "";
        }
    }
    return homeDir;
}
