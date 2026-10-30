// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// "Copy link" of a page panel (FR-SHELL-051, #1544): the address chip's button, the header's "⋯" and the chip's menu
// copy the page's address as the developer sees it and confirm in place, on the chip, with no toast.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import { addressOfPage } from "./browser-model";

export const LinkCopiedMs = 1600;

export class LinkCopy {
    copiedAtom = atom(false) as PrimitiveAtom<boolean>;
    timer: ReturnType<typeof setTimeout> = null;

    // Resolves true when the text reached the clipboard; the confirmation shows only then.
    async copy(url: string, write: (text: string) => Promise<void> = (text) => navigator.clipboard.writeText(text)) {
        const address = addressOfPage(url);
        if (!address) {
            return false;
        }
        try {
            await write(address);
        } catch {
            return false;
        }
        globalStore.set(this.copiedAtom, true);
        this.clearTimer();
        this.timer = setTimeout(() => {
            this.timer = null;
            globalStore.set(this.copiedAtom, false);
        }, LinkCopiedMs);
        return true;
    }

    clearTimer(): void {
        if (this.timer != null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    dispose(): void {
        this.clearTimer();
    }
}
