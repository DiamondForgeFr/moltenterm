// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the Sessions card's buttons do (FR-BOSS-002): the Sessions view's own doors, so the card has no second
// implementation of showing a session, opening the full view or starting a terminal.

import { getApi } from "@/app/store/global";
import { AgentHandoffDecision } from "../agent-handoff";
import { openAppPanel } from "../app-panel";
import { MoltentermNotification, NotificationAction } from "../notifications-model";
import { MoltentermNotifications } from "../notifications-store";
import { openMoltentermView } from "../open-view";
import { openWebLink } from "../open-web-link";
import { reviewsRerunFailed } from "../reviews/reviews-client";
import { ReviewsModel } from "../reviews/reviews-store";
import { showPane } from "../sessions/pane-focus";
import { MoltentermSessionsView, SessionLocation } from "../sessions/sessions-model";
import { DurableSessions } from "../sessions/sessions-store";
import { PendingHandoffs } from "./boss-handoffs";

// The To handle rows' buttons (FR-BOSS-003): the Integration panel's own door to a PR, its CI re-run, the PR page, and a
// notification's own buttons and its opening, as the bell's panel does them.
export function openIntegrationPr(dir: string, number: number): Promise<void> {
    return ReviewsModel.getInstance().openReviews(dir, number);
}

export function rerunPrChecks(dir: string, number: number): Promise<unknown> {
    return reviewsRerunFailed(dir, number);
}

export function openPrPage(url: string): Promise<boolean> {
    return openWebLink(url);
}

export function answerNotice(entry: MoltentermNotification, action: NotificationAction): Promise<void> {
    return MoltentermNotifications.getInstance().runAction(entry, action);
}

export function openNotice(entry: MoltentermNotification): Promise<void> {
    return MoltentermNotifications.getInstance().open(entry);
}

// Done on a "go there and do it" row (#1938): the developer did it, so the notification's situation closes.
export function markNoticeDone(entry: MoltentermNotification): Promise<void> {
    return MoltentermNotifications.getInstance().resolveEntries([entry.id]);
}

// A hand-off request's answer, through the route its notification's buttons answer through (FR-BOSS-005): one request,
// two views, so answering here removes the notification too.
export function answerHandoff(requestid: string, decision: AgentHandoffDecision): Promise<void> {
    return PendingHandoffs.getInstance().answer(requestid, decision);
}

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
