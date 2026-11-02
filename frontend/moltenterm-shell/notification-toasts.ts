// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Notifications as toasts (FR-SHELL-055): what arrives while the window is in front shows in the toast stack instead
// of opening the center. A toast dismissed by the user marks its notification read; one that leaves by itself, or
// for lack of room, keeps it unread in the center. Since #790, what needs an answer opens the center in the focused
// window instead (notification-attention.ts).

import { globalStore } from "@/app/store/jotaiStore";
import { trustReviewAction } from "./mission/trust-approval-model";
import { missedForPanel, planArrivals, stillWaiting } from "./notification-attention";
import { toastArrivals, ToastCoalesceMs } from "./notification-rules";
import {
    checkClickable,
    MoltentermNotification,
    notificationActionLabel,
    notificationMessage,
    notificationTitle,
} from "./notifications-model";
import { MoltentermNotifications } from "./notifications-store";
import { checkQuestion, goneNotificationToasts, notificationToastId, toastActionsOf, ToastInput } from "./toast-model";
import { Toasts } from "./toast-store";

export function notificationToast(entry: MoltentermNotification): ToastInput {
    const model = MoltentermNotifications.getInstance();
    const hasOrigin = checkClickable(entry) || trustReviewAction(entry) != null;
    return {
        id: notificationToastId(entry.id),
        notificationId: entry.id,
        kind: entry.kind,
        title: notificationTitle(entry),
        message: notificationMessage(entry),
        question: checkQuestion(entry),
        actions: toastActionsOf(entry).map((action) => ({
            id: action.id,
            label: notificationActionLabel(action),
            run: () => model.runAction(entry, action),
        })),
        onOpen: hasOrigin ? () => model.open(entry) : undefined,
        onDismiss: (reason) => {
            if (reason === "user") {
                model.markRead([entry.id]);
            }
        },
    };
}

function checkWindowFocused(): boolean {
    return document.hasFocus() && document.visibilityState === "visible";
}

export function startNotificationToasts(): () => void {
    const model = MoltentermNotifications.getInstance();
    const toasts = Toasts.getInstance();
    let seen = new Map(model.entries().map((e) => [e.id, e.updated]));
    let pending: string[] = [];
    let timer: ReturnType<typeof setTimeout> = null;
    // What needed the panel while this window was not in focus: it opens on them when the window gets it back (#790).
    let missed: string[] = [];

    // A signal from the pane in front of the user is read on arrival (startNotificationAutoRead): by the time the
    // arrivals are shown, it no longer asks for a toast.
    const showPending = () => {
        timer = null;
        const ids = new Set(pending);
        pending = [];
        const shown = model
            .entries()
            .filter((e) => ids.has(e.id) && !e.read && e.resolved == null && e.archived == null)
            .sort((a, b) => a.updated - b.updated);
        const policy = globalStore.get(model.panelPolicyAtom);
        const focused = checkWindowFocused();
        const plan = planArrivals(shown, policy, focused);
        if (!focused) {
            missed = [...new Set([...missed, ...missedForPanel(shown, policy)])];
        }
        const toToast = new Set(plan.toast);
        shown.filter((e) => toToast.has(e.id)).forEach((entry) => toasts.push(notificationToast(entry)));
        model.requestPanel(plan.panel);
    };

    const onFocus = () => {
        const waiting = stillWaiting(model.entries(), missed);
        missed = [];
        model.requestPanel(waiting);
    };
    window.addEventListener("focus", onFocus);

    const unsubscribe = globalStore.sub(model.entriesAtom, () => {
        const entries = model.entries();
        goneNotificationToasts(toasts.stack(), entries).forEach((id) => toasts.dismiss(id, "gone"));
        const arrivals = toastArrivals(entries, seen);
        seen = new Map(entries.map((e) => [e.id, e.updated]));
        if (arrivals.length === 0) {
            return;
        }
        if (document.visibilityState !== "visible") {
            const arrived = new Set(arrivals);
            const policy = globalStore.get(model.panelPolicyAtom);
            missed = [
                ...new Set([
                    ...missed,
                    ...missedForPanel(
                        entries.filter((e) => arrived.has(e.id)),
                        policy
                    ),
                ]),
            ];
            return;
        }
        pending = [...new Set([...pending, ...arrivals])];
        if (timer != null) {
            clearTimeout(timer);
        }
        timer = setTimeout(showPending, ToastCoalesceMs);
    });
    return () => {
        unsubscribe();
        window.removeEventListener("focus", onFocus);
        if (timer != null) {
            clearTimeout(timer);
        }
    };
}
