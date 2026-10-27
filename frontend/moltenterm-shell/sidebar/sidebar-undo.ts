// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The sidebar's Undo (FR-SHELL-081): a change to the views (an order, a pin, a duplicate) shows a toast with Undo, and
// ⌘Z (Ctrl+Z elsewhere) undoes the latest one while its toast shows.

import { isMacOS } from "@/util/platformutil";
import { fireAndForget } from "@/util/util";
import { t } from "../i18n/i18n";
import { shortcutLabel } from "../menu/menu-model";
import { dismissToast, showToast } from "../toast-store";
import { typesText, undoKey } from "./view-menu-model";

type PendingUndo = { toastId: string; run: () => void | Promise<void> };

let pending: PendingUndo = null;

export function undoKeysLabel(): string {
    return shortcutLabel(isMacOS() ? "Command+Z" : "Control+Z");
}

// A toast whose Undo is also ⌘Z's while it shows.
export function showUndoToast(title: string, undo: () => void | Promise<void>, message?: string): string {
    const entry: PendingUndo = { toastId: null, run: undo };
    entry.toastId = showToast({
        title,
        message,
        actions: [
            {
                id: "undo",
                label: t("sidebar.undoKeys", { keys: undoKeysLabel() }),
                run: () => {
                    if (pending === entry) {
                        pending = null;
                    }
                    return undo();
                },
            },
        ],
        onDismiss: () => {
            if (pending === entry) {
                pending = null;
            }
        },
    });
    pending = entry;
    return entry.toastId;
}

// ⌘Z from the window: true when it undid the sidebar's latest change.
export function undoFromKey(e: KeyboardEvent): boolean {
    if (pending == null || !undoKey(e, isMacOS()) || typesText(document.activeElement)) {
        return false;
    }
    const entry = pending;
    pending = null;
    dismissToast(entry.toastId);
    fireAndForget(async () => {
        try {
            await entry.run();
        } catch (err) {
            console.log("sidebar undo:", err);
        }
    });
    return true;
}
