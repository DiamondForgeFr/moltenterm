// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What makes a carpet column's thumbnail valid and when it may be taken (#1814, FR-SHELL-065 AC12, DS-SHELL-152). A
// thumbnail is tagged with the column's panels and, for a page, the address it shows: it is shown only while the tag is
// the same, whatever happens to the page (off-screen, unloaded, another view, a restart). A page that is loading, has
// failed, has crashed, is unloaded or is blank is never captured, so a good thumbnail is never overwritten by a bad
// frame. Kept apart from the app's stores (carpet-thumb-live.ts reads them) so the rules are tested alone.

import { isBlankPage } from "../browser/browser-model";
import type { CarpetCapture } from "./carpet-captures";
import type { CaptureColumn } from "./carpet-peeks";
import type { CarpetThumbBackend } from "./carpet-thumbs";

export type ColumnPanel = {
    blockId: string;
    // A page of MoltenTerm's browser: the only kind whose address is part of the tag and whose state gates a capture.
    page: boolean;
    url: string;
    // The page's view model is registered and its webview is there.
    ready: boolean;
    // The tab is an entry handed off to the installed browser: it has no page of its own here.
    handedOff: boolean;
    loading: boolean;
    failed: boolean;
    crashed: boolean;
    // The webview was dropped to save resources, or is coming back.
    unloaded: boolean;
};

export function plainPanel(blockId: string): ColumnPanel {
    return {
        blockId,
        page: false,
        url: "",
        ready: true,
        handedOff: false,
        loading: false,
        failed: false,
        crashed: false,
        unloaded: false,
    };
}

const MaxTagUrlChars = 300;

function hashText(text: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    }
    return (h >>> 0).toString(36);
}

// A very long address stays distinguishable without making the tag longer than the store accepts.
export function tagUrl(url: string): string {
    const text = (url ?? "").trim();
    return text.length <= MaxTagUrlChars ? text : `${text.slice(0, 200)}#${text.length}.${hashText(text)}`;
}

export function panelTag(p: ColumnPanel): string {
    return p.page ? `${p.blockId}@${tagUrl(p.url)}` : p.blockId;
}

export function columnTag(panels: ColumnPanel[]): string {
    return (panels ?? []).map(panelTag).join("|");
}

export function panelCapturable(p: ColumnPanel): boolean {
    if (!p.page) {
        return true;
    }
    return p.ready && !p.handedOff && !p.loading && !p.failed && !p.crashed && !p.unloaded && !isBlankPage(p.url);
}

export function columnCapturable(panels: ColumnPanel[]): boolean {
    return (panels ?? []).length > 0 && panels.every(panelCapturable);
}

// A page's column starts with the panel's own header (its address and buttons), which would make a blank page look like
// a picture: the main process leaves this share of the top out when it checks for a frame of one flat colour.
export const PageHeaderShare = 0.08;

export function columnFlatSkipTop(panels: ColumnPanel[]): number {
    return panels?.length === 1 && panels[0].page ? PageHeaderShare : 0;
}

// What a change of panel state is compared by: a title or a favicon changing is not one.
export function panelFactsKey(p: ColumnPanel): string {
    return [p.blockId, p.page, p.url, p.ready, p.handedOff, p.loading, p.failed, p.crashed, p.unloaded].join("\u0001");
}

export type TrackerDeps = {
    readPanel(blockId: string): ColumnPanel;
    // Calls back on any change of a page panel's address, load, failure, crash or unloading; null while the panel's
    // view model is not registered (or it is not a page).
    watchPanel(blockId: string, onChange: () => void): () => void;
    readCapture(columnId: string): CarpetCapture;
    // null empties the column: what it held is not valid any more.
    writeCapture(columnId: string, capture: CarpetCapture): void;
    backend: Pick<CarpetThumbBackend, "read">;
    // A panel's state changed: the scheduler looks again once the carpet has settled.
    wake(): void;
};

// Keeps the carpet's in-memory thumbnails true to what the columns show now: empties a column whose tag moved on, fills
// an empty one from the store (so a panel off-screen, unloaded or from before a restart has its thumbnail without being
// visited), and wakes the scheduler when a page's state changes.
export class CarpetThumbTracker {
    columns: CaptureColumn[];
    deps: TrackerDeps;
    // The tag the store was last asked for, per column: it is asked again only for another tag.
    asked = new Map<string, string>();
    watches = new Map<string, () => void>();
    seen = new Map<string, string>();
    disposed = false;

    constructor(columns: CaptureColumn[], deps: TrackerDeps) {
        this.columns = columns;
        this.deps = deps;
    }

    panels(columnId: string): ColumnPanel[] {
        const column = this.columns.find((c) => c.columnId === columnId);
        return (column?.blockIds ?? []).map((id) => this.deps.readPanel(id));
    }

    tagOf(columnId: string): string {
        return columnTag(this.panels(columnId));
    }

    inspect(columnId: string): { tag: string; capturable: boolean } {
        const panels = this.panels(columnId);
        return { tag: columnTag(panels), capturable: columnCapturable(panels) };
    }

    flatSkipTop(columnId: string): number {
        return columnFlatSkipTop(this.panels(columnId));
    }

    // The store's key: the column's first panel.
    keyOf(columnId: string): string {
        return this.columns.find((c) => c.columnId === columnId)?.blockIds?.[0] ?? null;
    }

    // Watches every page panel whose view model is registered by now (a model registers while its block renders, which
    // may come after the carpet's first pass).
    attach(): void {
        if (this.disposed) {
            return;
        }
        for (const column of this.columns) {
            for (const blockId of column.blockIds ?? []) {
                if (this.watches.has(blockId)) {
                    continue;
                }
                const stop = this.deps.watchPanel(blockId, () => this.onPanelChange(blockId));
                if (stop == null) {
                    continue;
                }
                this.watches.set(blockId, stop);
                this.onPanelChange(blockId);
            }
        }
    }

    onPanelChange(blockId: string): void {
        if (this.disposed) {
            return;
        }
        const key = panelFactsKey(this.deps.readPanel(blockId));
        if (this.seen.get(blockId) === key) {
            return;
        }
        this.seen.set(blockId, key);
        void this.sync();
        this.deps.wake();
    }

    async sync(): Promise<void> {
        const wanted: { columnId: string; key: string; tag: string }[] = [];
        for (const column of this.columns) {
            const tag = this.tagOf(column.columnId);
            const held = this.deps.readCapture(column.columnId);
            if (held != null && held.tag != null && held.tag !== tag) {
                this.deps.writeCapture(column.columnId, null);
            }
            const key = this.keyOf(column.columnId);
            if (
                key != null &&
                this.deps.readCapture(column.columnId) == null &&
                this.asked.get(column.columnId) !== tag
            ) {
                this.asked.set(column.columnId, tag);
                wanted.push({ columnId: column.columnId, key, tag });
            }
        }
        if (wanted.length === 0) {
            return;
        }
        const found = await this.deps.backend.read(wanted.map(({ key, tag }) => ({ key, tag })));
        if (this.disposed) {
            return;
        }
        for (const { columnId, key, tag } of wanted) {
            const stored = found?.[key];
            // A capture taken while the store answered, or a page that moved on, wins over the stored one.
            if (stored == null || this.deps.readCapture(columnId) != null || this.tagOf(columnId) !== tag) {
                continue;
            }
            this.deps.writeCapture(columnId, {
                url: stored.url,
                width: stored.width,
                height: stored.height,
                at: stored.at,
                tag,
            });
        }
    }

    dispose(): void {
        this.disposed = true;
        for (const stop of this.watches.values()) {
            stop();
        }
        this.watches.clear();
    }
}
