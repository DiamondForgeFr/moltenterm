// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The message after a 360 × N (FR-SHELL-123-AC8): what happened, with Undo for 10 seconds. A toast never takes the
// focus and is read as a status; a new apply replaces the one before.

import { t, tCount } from "../i18n/i18n";
import { showToast } from "../toast-store";

export const PlacesToastId = "view360-places";
export const PlacesUndoMs = 10000;

export function placesToastText(n: number, stored: number): { title: string; message: string } {
    return {
        title: tCount("view360.places.toastTitle", n),
        message: tCount("view360.places.toastStored", stored),
    };
}

export function showPlacesToast(n: number, stored: number, undo: () => void): string {
    return showToast({
        id: PlacesToastId,
        kind: "info",
        ...placesToastText(n, stored),
        text: () => ({ ...placesToastText(n, stored), actionLabels: { undo: t("view360.places.undo") } }),
        dismissMs: PlacesUndoMs,
        actions: [{ id: "undo", label: t("view360.places.undo"), run: undo }],
    });
}
