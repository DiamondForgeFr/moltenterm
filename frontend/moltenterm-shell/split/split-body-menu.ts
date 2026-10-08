// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A right-click in a panel's body that its view leaves alone opens the block's menu, so every panel offers Split
// right / Split down there too (FR-SHELL-042-AC4). A view with its own menu stops the event first; text fields and
// selections keep the app's Cut / Copy / Paste menu.

function isEditable(target: EventTarget): boolean {
    const el = target as HTMLElement;
    if (el == null || typeof el.closest !== "function") {
        return false;
    }
    return el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']") != null;
}

function hasSelection(): boolean {
    const sel = globalThis.getSelection?.();
    return sel != null && !sel.isCollapsed && sel.toString().trim() !== "";
}

export function shouldOpenBlockBodyMenu(e: { defaultPrevented: boolean; target: EventTarget }): boolean {
    if (e.defaultPrevented || isEditable(e.target)) {
        return false;
    }
    return !hasSelection();
}

export function openBlockBodyMenu(e: React.MouseEvent<HTMLDivElement>, show: () => void): void {
    if (!shouldOpenBlockBodyMenu(e)) {
        return;
    }
    show();
}
