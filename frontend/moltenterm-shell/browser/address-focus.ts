// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A page panel opened by choosing Web page in a chooser has its address field focused (FR-SHELL-086, #1742): ⌘V then
// Enter opens a pasted address. The panel's view model is made after the chooser asked, so a request waits for it; the
// view model keeps the wish until its first giveFocus, which the block calls when the panel takes the layout's focus
// and which would otherwise hand the focus to the page.

export type AddressTarget = { wantAddressFocus(): void };

const Pending = new Set<string>();

// target: the panel's view model when it already exists.
export function requestAddressFocus(blockId: string, target: AddressTarget): void {
    if (!blockId) {
        return;
    }
    if (target?.wantAddressFocus != null) {
        target.wantAddressFocus();
        return;
    }
    Pending.add(blockId);
}

// Called as the panel's view model is made; true once for a panel that waits.
export function takeAddressFocus(blockId: string): boolean {
    return Pending.delete(blockId);
}

export function forgetAddressFocus(blockId: string): void {
    Pending.delete(blockId);
}
