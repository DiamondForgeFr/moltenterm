// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Whether a web page panel is in comment mode (#2327, #2422), and for which pages. The panel's Comment button, the version
// card's Comment and the shortcut all start it here; the layer over the page (annotate-layer.tsx) holds the comments.
// A session belongs to a tab: while another tab is shown its layer is hidden and keeps its comments, which are back when
// the tab is.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import type { CaptureView } from "./annotate-capture";
import type { LinkedWebview } from "./annotate-guest-link";

// The panel's header, its menu and its keys load this file with the window; the layer and its model load on demand
// (build/on-demand-imports.test.ts), so nothing heavy is imported here, only types.

// What the layer needs of a tab's page.
export type AnnotatedWebview = LinkedWebview & CaptureView & { getURL(): string };

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

export type AnnotateLayerState = { open: AnnotateOpen; shown: boolean };

// annotateLayers: the layers to keep mounted, each shown only while its own tab is. A tab that is gone has no layer: the
// zones of a page the developer closed go with it.
export function annotateLayers(opens: AnnotateOpen[], activeTabId: string, tabIds: string[]): AnnotateLayerState[] {
    return (opens ?? [])
        .filter((open) => (tabIds ?? []).includes(open.tabId))
        .map((open) => ({ open, shown: open.tabId === activeTabId }));
}

// The hidden setting that remembers the first-use hint was shown (#2537): once, ever, whatever the panel or the restart.
export const AnnotateHintKey = "moltenterm:annotatehint";

// firstUseHint: the mode shows its first-use hint while the setting does not say it was shown.
export function firstUseHint(shown: unknown): boolean {
    return shown !== true;
}

// entryPlays: whether the mode's entry (#2537: the lights round the panel, the toolbar rising, the pencil's flash) is to
// play over this session. Only the start that has not played it yet: showing the tab again, or coming back from the
// review, never plays it twice.
export function entryPlays(entry: AnnotateOpen, open: AnnotateOpen): boolean {
    return entry != null && open != null && entry.nonce === open.nonce;
}

// closedTabs: the sessions whose tab no longer exists.
export function closedTabs(opens: AnnotateOpen[], tabIds: string[]): string[] {
    return (opens ?? []).filter((open) => !(tabIds ?? []).includes(open.tabId)).map((open) => open.tabId);
}

export class AnnotateSession {
    openAtom = atom([]) as PrimitiveAtom<AnnotateOpen[]>;
    // The comments pending in each tab's session: the Comment button shows the number.
    countsAtom = atom({}) as PrimitiveAtom<Record<string, number>>;
    // The start whose entry has not played yet (#2537); null once it has, or once its session ended.
    entryAtom = atom(null) as PrimitiveAtom<AnnotateOpen>;
    nonce = 0;
    // Set by each layer while it has a comment field open: it takes the focus the panel would give to the page of its tab.
    focusLayers = new Map<string, () => boolean>();
    // Set by each layer: what leaving the mode does (it asks first when comments would be lost).
    leaveLayers = new Map<string, () => void>();
    // Set by the panel: a tab's page (null while it has none).
    webviewOf: (tabId: string) => AnnotatedWebview = () => null;

    opens(): AnnotateOpen[] {
        return globalStore.get(this.openAtom);
    }

    isOpen(tabId: string): boolean {
        return this.opens().some((open) => open.tabId === tabId);
    }

    // false when the page cannot be commented on, or the tab is already in the mode (a second press leaves it as it is).
    start(tabId: string, url: string): boolean {
        if (!annotatablePage(url) || this.isOpen(tabId)) {
            return false;
        }
        this.nonce++;
        const open = { tabId, url, nonce: this.nonce };
        globalStore.set(this.openAtom, [...this.opens(), open]);
        globalStore.set(this.entryAtom, open);
        return true;
    }

    close(tabId: string): void {
        globalStore.set(
            this.openAtom,
            this.opens().filter((open) => open.tabId !== tabId)
        );
        this.setCount(tabId, 0);
        if (globalStore.get(this.entryAtom)?.tabId === tabId) {
            globalStore.set(this.entryAtom, null);
        }
    }

    // entryDone: the entry of that start has played (or was skipped): it never plays again.
    entryDone(nonce: number): void {
        if (globalStore.get(this.entryAtom)?.nonce === nonce) {
            globalStore.set(this.entryAtom, null);
        }
    }

    // leave: the Comment button, pressed, asks to leave. The layer decides (it asks before comments are lost); a tab whose
    // layer is not mounted leaves at once.
    leave(tabId: string): void {
        const layer = this.leaveLayers.get(tabId);
        if (layer == null) {
            this.close(tabId);
            return;
        }
        layer();
    }

    setCount(tabId: string, count: number): void {
        const counts = globalStore.get(this.countsAtom);
        if ((counts[tabId] ?? 0) === count) {
            return;
        }
        const next = { ...counts };
        if (count > 0) {
            next[tabId] = count;
        } else {
            delete next[tabId];
        }
        globalStore.set(this.countsAtom, next);
    }

    holdFocus(tabId: string): boolean {
        const focus = this.focusLayers.get(tabId);
        return focus != null && focus();
    }
}
