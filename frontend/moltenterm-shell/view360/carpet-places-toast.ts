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

// What a pin or an unpin did to the places on screen (#1500): the places that fit now, and why they changed. N stays
// the view's (AC7), so the places the pin took come back with the pin gone.
export function pinPlacesToastText(shown: number, before: number): { title: string; message: string } {
    const delta = Math.abs(shown - before);
    return {
        title: tCount("view360.places.toastTitle", shown),
        message: tCount(shown < before ? "view360.places.pinTook" : "view360.places.pinGaveBack", delta),
    };
}

// Replaces the toast of a 360 × N: its count is no longer what is on screen, and its Undo would undo the pin too.
export function showPinPlacesToast(shown: number, before: number): string {
    return showToast({
        id: PlacesToastId,
        kind: "info",
        ...pinPlacesToastText(shown, before),
        text: () => pinPlacesToastText(shown, before),
    });
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
