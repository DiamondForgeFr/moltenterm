// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The toast stack (FR-SHELL-055, DS-SHELL-097): what arrives shows at the bottom right instead of opening the whole
// notification center. At most three toasts show, the newest at the bottom; an older one leaves for the center,
// where its notification stays unread. Each kind has its own tone: done green, waiting amber, error red, information
// neutral. Kept apart from the components so the rules can be tested without the app.

import { t } from "./i18n/i18n";
import { displayActions, MoltentermNotification, MoltentermNotificationKind } from "./notifications-model";

export const MaxToasts = 3;
export const MaxToastActions = 2;
// A question's answers all show, so none of them hides in the center (the handoff approval's Allow once, Always for
// this pair and Block, #595).
export const MaxToastAnswers = 3;
// Information leaves by itself after this, unless pointed at or focused; what waits for a gesture stays.
export const ToastDismissMs = 6000;

export type ToastTone = "done" | "waiting" | "error" | "info";

export type ToastToneView = { tone: ToastTone; label: string; colorClass: string; icon: string };

// The tone is never told by colour alone: each has its own icon, and screen readers hear its label (a dictionary key
// here, translated by toneOf).
export const ToastTones: Record<MoltentermNotificationKind, ToastToneView> = {
    success: { tone: "done", label: "notif.tone.done", colorClass: "text-success", icon: "circle-check" },
    warning: { tone: "waiting", label: "notif.tone.waiting", colorClass: "text-warning", icon: "triangle-exclamation" },
    error: { tone: "error", label: "notif.tone.error", colorClass: "text-error", icon: "circle-exclamation" },
    info: { tone: "info", label: "notif.tone.info", colorClass: "text-secondary", icon: "circle-info" },
};

export function toneOf(kind: MoltentermNotificationKind): ToastToneView {
    const view = ToastTones[kind] ?? ToastTones.info;
    return { ...view, label: t(view.label) };
}

export type ToastDismissReason = "user" | "timeout" | "collapsed" | "gone";

export type ToastText = { title: string; message?: string; actionLabels?: Record<string, string> };

export type ToastAction ={ id: string; label: string; run: () => void | Promise<void> };

// What a caller pushes: a notification's toast, or a question of its own that needs no record in the center (#413's
// "Use the repository's logo?"). Pushing the same id again replaces that toast and makes it the newest.
export type ToastInput = {
    id?: string;
    kind?: MoltentermNotificationKind;
    title: string;
    message?: string;
    // Resolves the texts when the toast renders, so a toast that waits for an answer follows a language switch
    // (FR-I18N-001); title, message and the action labels are then only the first values.
    text?: () => ToastText;
    // An image URL shown at 32 px in place of the tone's icon (the project icon offer, DS-SHELL-101).
    thumbnail?: string;
    actions?: ToastAction[];
    // Stays until dismissed; by default only waiting and error toasts do.
    stays?: boolean;
    // How long a toast that does not stay shows, when not ToastDismissMs (an undo offer's time left, FR-SHELL-095).
    dismissMs?: number;
    // A click on the toast itself, besides its buttons.
    onOpen?: () => void | Promise<void>;
    onDismiss?: (reason: ToastDismissReason) => void;
    // The notification this toast shows, if any.
    notificationId?: string;
    // The actions are the answers to one question: up to MaxToastAnswers show.
    question?: boolean;
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
        actions: (input.actions ?? []).slice(0, input.question ? MaxToastAnswers : MaxToastActions),
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

// A notification asks a question when each of its buttons gives an answer to the same gesture (the keep-awake policy,
// the handoff approval).
export function checkQuestion(entry: MoltentermNotification): boolean {
    const actions = displayActions(entry);
    return (
        actions.length > MaxToastActions &&
        actions.every((a) => a.kind === "gesture" && a.gesture != null && a.gesture === actions[0].gesture)
    );
}

// A notification's buttons in a toast: Go to the terminal first for a waiting agent, two at most, except a question's
// answers.
export function toastActionsOf(entry: MoltentermNotification) {
    return displayActions(entry).slice(0, checkQuestion(entry) ? MaxToastAnswers : MaxToastActions);
}

// A toast of a notification goes once the notification no longer asks to be read: read here or in another window,
// resolved, archived or deleted.
export function goneNotificationToasts(stack: Toast[], entries: MoltentermNotification[]): string[] {
    const unread = new Set(entries.filter((e) => !e.read && e.resolved == null && e.archived == null).map((e) => e.id));
    return stack.filter((t) => t.notificationId != null && !unread.has(t.notificationId)).map((t) => t.id);
}
