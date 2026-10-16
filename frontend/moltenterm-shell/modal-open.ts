// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The overlay rule (FR-SHELL-054, DS-SHELL-096): every modal dims the app with this scrim (tokens.css) and no surface
// draws its own; command surfaces (palette, command panel, menus, popovers) have none, only shadow-command.
export const ScrimClass = "molten-scrim";

// A modal is up when its scrim is, or Wave's own modal backdrop (About, message boxes). The keys that open the
// palette, the shortcuts sheet or a command panel do nothing then (#746): the modal waits for an answer and keeps the
// keyboard, and what they open would act behind it.
export function modalIsOpen(): boolean {
    if (typeof document === "undefined") {
        return false;
    }
    return document.querySelector(`.${ScrimClass}, .modal-backdrop`) != null;
}
