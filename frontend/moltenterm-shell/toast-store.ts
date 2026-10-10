// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The toast stack's store (FR-SHELL-055): one per window renderer, since a toast belongs to the screen it shows on.
// showToast is the API for any caller; the notification center pushes its arrivals through it (notification-toasts.ts).

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import { makeToast, pushToast, removeToast, Toast, ToastDismissReason, ToastInput } from "./toast-model";

export class Toasts {
    private static instance: Toasts = null;

    stackAtom = atom([]) as PrimitiveAtom<Toast[]>;
    // How many notification toasts left the stack for the center since the user last opened it.
    collapsedAtom = atom(0) as PrimitiveAtom<number>;
    nextId = 0;

    private constructor() {}

    static getInstance(): Toasts {
        if (!Toasts.instance) {
            Toasts.instance = new Toasts();
        }
        return Toasts.instance;
    }

    static resetInstance(): void {
        Toasts.instance = null;
    }

    stack(): Toast[] {
        return globalStore.get(this.stackAtom);
    }

    push(input: ToastInput): string {
        const toast = makeToast(input, `toast:${++this.nextId}`);
        const { stack, collapsed } = pushToast(this.stack(), toast);
        globalStore.set(this.stackAtom, stack);
        const collapsedNotifications = collapsed.filter((t) => t.notificationId != null).length;
        if (collapsedNotifications > 0) {
            globalStore.set(this.collapsedAtom, globalStore.get(this.collapsedAtom) + collapsedNotifications);
        }
        collapsed.forEach((t) => t.onDismiss?.("collapsed"));
        return toast.id;
    }

    dismiss(id: string, reason: ToastDismissReason = "user"): void {
        const toast = this.stack().find((t) => t.id === id);
        if (toast == null) {
            return;
        }
        globalStore.set(this.stackAtom, removeToast(this.stack(), id));
        toast.onDismiss?.(reason);
    }

    // The center shows every notification: their toasts would only repeat it.
    clearNotificationToasts(): void {
        this.stack()
            .filter((t) => t.notificationId != null)
            .forEach((t) => this.dismiss(t.id, "gone"));
        globalStore.set(this.collapsedAtom, 0);
    }
}

export function showToast(input: ToastInput): string {
    return Toasts.getInstance().push(input);
}

export function dismissToast(id: string): void {
    Toasts.getInstance().dismiss(id, "gone");
}
