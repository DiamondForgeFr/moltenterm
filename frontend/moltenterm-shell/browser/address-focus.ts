// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A page panel opened by choosing Web page in a chooser has its address field focused (FR-SHELL-086, #1742): ⌘V then
// Enter opens a pasted address. The panel's view model is made after the chooser asked, so a request waits for it; the
// view model then holds the focus on the address field (AddressHold) against the block's own focusing of the page.

import { isBlankPage } from "./browser-model";

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

export type HoldTarget = {
    addEventListener(type: string, listener: (e: any) => void, capture?: boolean): void;
    removeEventListener(type: string, listener: (e: any) => void, capture?: boolean): void;
};

function isPageElement(target: unknown): boolean {
    return (target as { tagName?: string })?.tagName === "WEBVIEW";
}

// The wish of a page panel opened from a chooser to keep the focus on its address field. While it holds, the panel's
// giveFocus goes to the address field instead of the page. It lets go on the first of: the developer types or presses
// a key anywhere, clicks anywhere or clicks into a page (a page taking the focus while nothing else asks it to is the
// developer's click), or a page finishes loading an address (a load of the start page or a blank page is no address).
// Events only: nothing here waits.
export class AddressHold {
    holds = false;
    target: HoldTarget;
    isPage: (target: unknown) => boolean;

    constructor(target?: HoldTarget, isPage: (target: unknown) => boolean = isPageElement) {
        this.target = target === undefined ? (typeof document === "undefined" ? null : document) : target;
        this.isPage = isPage;
    }

    onAct = () => {
        this.stop();
    };

    onFocus = (e: { target?: unknown }) => {
        if (this.isPage(e?.target)) {
            this.stop();
        }
    };

    start(): void {
        if (this.holds) {
            return;
        }
        this.holds = true;
        this.target?.addEventListener("keydown", this.onAct, true);
        this.target?.addEventListener("pointerdown", this.onAct, true);
        this.target?.addEventListener("focus", this.onFocus, true);
    }

    stop(): void {
        if (!this.holds) {
            return;
        }
        this.holds = false;
        this.target?.removeEventListener("keydown", this.onAct, true);
        this.target?.removeEventListener("pointerdown", this.onAct, true);
        this.target?.removeEventListener("focus", this.onFocus, true);
    }

    // A page's load ended, with the address the panel shows: the panel opened blank, so any other address was entered.
    noteLoadStopped(url: string): void {
        if (this.holds && !isBlankPage(url)) {
            this.stop();
        }
    }
}
