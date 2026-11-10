// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Notifications as toasts (FR-SHELL-055): what arrives while the window is in front shows in the toast stack instead
// of opening the center. A toast dismissed by the user marks its notification read; one that leaves by itself, or
// for lack of room, keeps it unread in the center. What needs an answer toasts like the rest, joins Brokk's To handle and,
// when the developer set it to Vient, brings Brokk (FR-BOSS-009): nothing opens the center by itself (#2003).

import { globalStore } from "@/app/store/jotaiStore";
import type { Atom } from "jotai";
import { makeSeenViewAtom } from "./agent-seen";
import type { AgentSeenView } from "./agent-state-model";
import { trustReviewAction } from "./mission/trust-approval-model";
import { toastArrivals, ToastCoalesceMs } from "./notification-rules";
import {
    checkClickable,
    MoltentermNotification,
    notificationActionLabel,
    notificationMessage,
    notificationTitle,
} from "./notifications-model";
import { MoltentermNotifications } from "./notifications-store";
import { notificationInView } from "./source-in-view";
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
            run: async () => {
                await model.runAction(entry, action);
            },
        })),
        onOpen: hasOrigin ? () => model.open(entry) : undefined,
        onDismiss: (reason) => {
            if (reason === "user") {
                model.markRead([entry.id]);
            }
        },
    };
}

// The arrivals to toast, oldest first: still unread and open, and not from a pane the developer has in view (#2166,
// source-in-view.ts), which they already see; those stay unread in the center.
export function toastsToShow(
    entries: MoltentermNotification[],
    ids: ReadonlySet<string>,
    view: AgentSeenView
): MoltentermNotification[] {
    return entries
        .filter(
            (e) => ids.has(e.id) && !e.read && e.resolved == null && e.archived == null && !notificationInView(e, view)
        )
        .sort((a, b) => a.updated - b.updated);
}

export function startNotificationToasts(viewAtom: Atom<AgentSeenView> = makeSeenViewAtom()): () => void {
    const model = MoltentermNotifications.getInstance();
    const toasts = Toasts.getInstance();
    let seen = new Map(model.entries().map((e) => [e.id, e.updated]));
    let pending: string[] = [];
    let timer: ReturnType<typeof setTimeout> = null;

    // A signal from the pane in front of the user is read on arrival (startNotificationAutoRead): by the time the
    // arrivals are shown, it no longer asks for a toast.
    const showPending = () => {
        timer = null;
        const ids = new Set(pending);
        pending = [];
        toastsToShow(model.entries(), ids, globalStore.get(viewAtom)).forEach((entry) =>
            toasts.push(notificationToast(entry))
        );
    };

    const unsubscribe = globalStore.sub(model.entriesAtom, () => {
        const entries = model.entries();
        goneNotificationToasts(toasts.stack(), entries).forEach((id) => toasts.dismiss(id, "gone"));
        const arrivals = toastArrivals(entries, seen);
        seen = new Map(entries.map((e) => [e.id, e.updated]));
        if (arrivals.length === 0) {
            return;
        }
        if (document.visibilityState !== "visible") {
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
        if (timer != null) {
            clearTimeout(timer);
        }
    };
}
