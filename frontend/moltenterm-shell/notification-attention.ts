// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What a new notification does to be noticed (#790). One that needs the developer's answer (a question answered in the
// notification, like the handoff approval, or a waiting one: an agent waiting, a permission, a prompt waiting for
// Enter) opens the notification panel in the focused window, that entry highlighted; the panel closes itself once
// those are answered, when it opened itself. Anything else shows as a toast for a few seconds. The developer may ask
// for the panel on every new notification. Pure, so the rules are tested apart from the timers and the component.

import { checkOpen, checkUnread, MoltentermNotification } from "./notifications-model";
import { checkQuestion } from "./toast-model";

// Only the windows read it, from the client meta they share; wavesrv publishes the same way whatever it says.
export const NotificationPanelMetaKey = "molten:notifpanel";

// "answers": the panel opens for what needs an answer (the default); "all": for every new notification.
export type PanelPolicy = "answers" | "all";

export function parsePanelPolicy(value: unknown): PanelPolicy {
    return value === "all" ? "all" : "answers";
}

// A question whose answers are the notification's own buttons: nowhere else answers it, so the focused pane's
// auto-read must leave it unread.
export function checkAnsweredInNotification(entry: MoltentermNotification): boolean {
    return entry != null && entry.resolved == null && entry.archived == null && checkQuestion(entry);
}

export function checkNeedsAnswer(entry: MoltentermNotification): boolean {
    if (entry == null || entry.resolved != null || entry.archived != null) {
        return false;
    }
    return entry.kind === "warning" || checkQuestion(entry);
}

export type ArrivalPlan = { panel: string[]; toast: string[] };

// How the arrivals of a focused window are shown: those for the panel, the others as toasts. A window not in focus
// toasts them all; panel arrivals it missed open the panel when it gets the focus back (missedForPanel).
export function planArrivals(arrivals: MoltentermNotification[], policy: PanelPolicy, focused: boolean): ArrivalPlan {
    const rtn: ArrivalPlan = { panel: [], toast: [] };
    for (const entry of arrivals) {
        const forPanel = focused && (policy === "all" || checkNeedsAnswer(entry));
        (forPanel ? rtn.panel : rtn.toast).push(entry.id);
    }
    return rtn;
}

// The arrivals an unfocused window keeps to open the panel on, once focused.
export function missedForPanel(arrivals: MoltentermNotification[], policy: PanelPolicy): string[] {
    return arrivals.filter((e) => policy === "all" || checkNeedsAnswer(e)).map((e) => e.id);
}

// Of the ids kept while the window was away, those still worth the panel: unread, or a question still open.
export function stillWaiting(entries: MoltentermNotification[], ids: string[]): string[] {
    const wanted = new Set(ids);
    return entries
        .filter((e) => wanted.has(e.id) && (checkUnread(e) || checkAnsweredInNotification(e)))
        .map((e) => e.id);
}

// The panel that opened itself closes once each entry it opened for is answered: resolved, archived, gone, or for a
// notification without a key, read.
export function checkAnswered(entries: MoltentermNotification[], ids: string[]): boolean {
    if (ids.length === 0) {
        return false;
    }
    const byId = new Map(entries.map((e) => [e.id, e]));
    return ids.every((id) => {
        const entry = byId.get(id);
        return entry == null || !checkOpen(entry);
    });
}

// The bell's count: the unread ones, and the questions still open once read (only their buttons answer them).
export function attentionCount(entries: MoltentermNotification[]): number {
    return entries.filter((e) => checkUnread(e) || checkAnsweredInNotification(e)).length;
}
