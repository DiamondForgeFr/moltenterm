// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Notifications as toasts (FR-SHELL-055): what arrives while the window is in front shows in the toast stack instead
// of opening the center. A toast dismissed by the user marks its notification read; one that leaves by itself, or
// for lack of room, keeps it unread in the center.

import { globalStore } from "@/app/store/jotaiStore";
import { toastArrivals, ToastCoalesceMs } from "./notification-rules";
import { MoltentermNotification } from "./notifications-model";
import { MoltentermNotifications } from "./notifications-store";
import { goneNotificationToasts, notificationToastId, toastActionsOf, ToastInput } from "./toast-model";
import { Toasts } from "./toast-store";

export function notificationToast(entry: MoltentermNotification): ToastInput {
    const model = MoltentermNotifications.getInstance();
    const hasOrigin = !!(entry.workspaceid || entry.tabid || entry.blockid);
    return {
        id: notificationToastId(entry.id),
        notificationId: entry.id,
        kind: entry.kind,
        title: entry.title,
        message: entry.message,
        actions: toastActionsOf(entry).map((action) => ({
            id: action.id,
            label: action.label,
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

export function startNotificationToasts(): () => void {
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
        const shown = model
            .entries()
            .filter((e) => ids.has(e.id) && !e.read && e.resolved == null && e.archived == null)
            .sort((a, b) => a.updated - b.updated);
        shown.forEach((entry) => toasts.push(notificationToast(entry)));
    };

    const unsubscribe = globalStore.sub(model.entriesAtom, () => {
        const entries = model.entries();
        goneNotificationToasts(toasts.stack(), entries).forEach((id) => toasts.dismiss(id, "gone"));
        const arrivals = toastArrivals(entries, seen);
        seen = new Map(entries.map((e) => [e.id, e.updated]));
        if (arrivals.length === 0 || document.visibilityState !== "visible") {
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
