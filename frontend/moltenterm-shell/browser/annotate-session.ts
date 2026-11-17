// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Whether a web page panel is in annotate mode (#2327), and for which page. The button of the panel's header, the version
// card's Annotate and the shortcut all start it here; the layer over the page (annotate-layer.tsx) holds the zones.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";

// The panel's header, its menu and its keys load this file with the window; the layer and its model load on demand
// (build/on-demand-imports.test.ts), so nothing heavy is imported here.

// annotatablePage: the pages the mode starts on: a page of the web, not an error or a blank start page.
export function annotatablePage(url: string): boolean {
    try {
        const parsed = new URL(url);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
        return false;
    }
}

// nonce: each start is a new session, so the layer starts again from a fresh capture.
export type AnnotateOpen = { tabId: string; url: string; nonce: number };

export class AnnotateSession {
    openAtom = atom(null) as PrimitiveAtom<AnnotateOpen>;
    nonce = 0;
    // Set by the layer while it shows: it takes the focus the panel would give to the page.
    focusLayer: () => boolean = null;

    holdFocus(): boolean {
        return this.focusLayer != null && this.focusLayer();
    }

    isOpen(): boolean {
        return globalStore.get(this.openAtom) != null;
    }

    // false when the page cannot be annotated, or the mode is already on (a second press leaves it as it is).
    start(tabId: string, url: string): boolean {
        if (!annotatablePage(url) || this.isOpen()) {
            return false;
        }
        this.nonce++;
        globalStore.set(this.openAtom, { tabId, url, nonce: this.nonce });
        return true;
    }

    close(): void {
        globalStore.set(this.openAtom, null);
    }
}
