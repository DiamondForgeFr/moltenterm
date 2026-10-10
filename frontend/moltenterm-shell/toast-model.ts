// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The toast stack (FR-SHELL-055, DS-SHELL-097): what arrives shows at the bottom right instead of opening the whole
// notification center. At most three toasts show, the newest at the bottom; an older one leaves for the center,
// where its notification stays unread. Each kind has its own tone: done green, waiting amber, error red, information
// neutral. Kept apart from the components so the rules can be tested without the app.

import { displayActions, MoltentermNotification, MoltentermNotificationKind } from "./notifications-model";

export const MaxToasts = 3;
export const MaxToastActions = 2;
// Information leaves by itself after this, unless pointed at or focused; what waits for a gesture stays.
export const ToastDismissMs = 6000;

export type ToastTone = "done" | "waiting" | "error" | "info";

export type ToastToneView = { tone: ToastTone; label: string; icon: string; iconClass: string };

// The tone is never told by colour alone: each has its own icon, and screen readers hear its label.
export const ToastTones: Record<MoltentermNotificationKind, ToastToneView> = {
    success: { tone: "done", label: "Done", icon: "circle-check", iconClass: "text-success" },
    warning: { tone: "waiting", label: "Waiting", icon: "triangle-exclamation", iconClass: "text-warning" },
    error: { tone: "error", label: "Error", icon: "circle-exclamation", iconClass: "text-error" },
    info: { tone: "info", label: "Information", icon: "circle-info", iconClass: "text-secondary" },
};

export function toneOf(kind: MoltentermNotificationKind): ToastToneView {
    return ToastTones[kind] ?? ToastTones.info;
}

export type ToastDismissReason = "user" | "timeout" | "collapsed" | "gone";

export type ToastAction = { id: string; label: string; run: () => void | Promise<void> };

// What a caller pushes: a notification's toast, or a question of its own that needs no record in the center (#413's
// "Use the repository's logo?"). Pushing the same id again replaces that toast and makes it the newest.
export type ToastInput = {
    id?: string;
    kind?: MoltentermNotificationKind;
    title: string;
    message?: string;
    actions?: ToastAction[];
    // Stays until dismissed; by default only waiting and error toasts do.
    stays?: boolean;
    // A click on the toast itself, besides its buttons.
    onOpen?: () => void | Promise<void>;
    onDismiss?: (reason: ToastDismissReason) => void;
    // The notification this toast shows, if any.
    notificationId?: string;
};

export type Toast = ToastInput & {
    id: string;
    kind: MoltentermNotificationKind;
    actions: ToastAction[];
    stays: boolean;
};

export function checkStays(kind: MoltentermNotificationKind): boolean {
    return kind === "warning" || kind === "error";
}

export function makeToast(input: ToastInput, id: string): Toast {
    const kind = input.kind ?? "info";
    return {
        ...input,
        id: input.id ?? id,
        kind,
        actions: (input.actions ?? []).slice(0, MaxToastActions),
        stays: input.stays ?? checkStays(kind),
    };
}

export type StackPush = { stack: Toast[]; collapsed: Toast[] };

// Newest last; beyond MaxToasts the oldest leave the stack.
export function pushToast(stack: Toast[], toast: Toast): StackPush {
    const next = [...stack.filter((t) => t.id !== toast.id), toast];
    const over = Math.max(0, next.length - MaxToasts);
    return { stack: next.slice(over), collapsed: next.slice(0, over) };
}

export function removeToast(stack: Toast[], id: string): Toast[] {
    return stack.filter((t) => t.id !== id);
}

export function notificationToastId(notificationId: string): string {
    return `notif:${notificationId}`;
}

// A notification's buttons in a toast: Go to the terminal first for a waiting agent, two at most.
export function toastActionsOf(entry: MoltentermNotification) {
    return displayActions(entry).slice(0, MaxToastActions);
}

// A toast of a notification goes once the notification no longer asks to be read: read here or in another window,
// resolved, archived or deleted.
export function goneNotificationToasts(stack: Toast[], entries: MoltentermNotification[]): string[] {
    const unread = new Set(entries.filter((e) => !e.read && e.resolved == null && e.archived == null).map((e) => e.id));
    return stack.filter((t) => t.notificationId != null && !unread.has(t.notificationId)).map((t) => t.id);
}
