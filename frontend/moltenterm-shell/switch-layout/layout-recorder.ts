// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Keeps the remembered layout of the view on screen up to date (FR-SHELL-082, #2407): whenever its panels change (a
// split, a resize, a panel opened or closed, the window resized), once they have settled, the view writes where they
// are. Only the view on screen writes, and never during a switch: its frames or its content fading are no layout.

import { atoms, globalStore } from "@/app/store/global";
import * as WOS from "@/app/store/wos";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { arriving, contentElement, leaving, switchLayoutOn } from "./layout-frames";
import {
    LayoutKeyPrefix,
    MeasuredBlock,
    measureLayout,
    RememberedLayout,
    sameLayout,
    staleLayoutKeys,
} from "./layout-memory";
import { loadLayout, saveLayout } from "./layout-store";

// The layout animates its changes (about 100 ms): it is read once it has been still this long.
export const LayoutSettleMs = 400;
// A recording put off (a switch under way, panels mounting) is tried again this many times at most (about 10 s).
export const LayoutMaxRetries = 25;

function blockKind(id: string): string {
    const block = WOS.getObjectValue<Block>(WOS.makeORef("block", id));
    return (block?.meta as Record<string, any>)?.view ?? "";
}

// The panels on screen, in the page's order: a panel inside another one (a preview's own blocks) is the outer one's.
export function measureBlocks(content: Element, kind: (id: string) => string = blockKind): MeasuredBlock[] {
    const out: MeasuredBlock[] = [];
    const blocks = Array.from(content.querySelectorAll<HTMLElement>(".block[data-blockid]"));
    for (const el of blocks) {
        if (el.parentElement?.closest(".block[data-blockid]") != null) {
            continue;
        }
        const r = el.getBoundingClientRect();
        const id = el.dataset.blockid;
        out.push({ id, kind: kind(id), rect: { left: r.left, top: r.top, width: r.width, height: r.height } });
    }
    return out;
}

// What the view knows of its tab and its workspace, read at the moment of a recording.
export type RecordFacts = {
    visible: boolean;
    // A switch is under way in this view (its frames, or its content fading): what shows is no layout. Asked again later.
    switching: boolean;
    // The view the workspace shows now: a view parked visible (the hidden-view budget off) is not it, and records nothing.
    activeTabId: string;
    // How many panels the tab holds: none means an empty layout, some with none measured means they are still mounting.
    tabBlocks: number;
};

export type RecordOutcome = { layout: RememberedLayout; save: boolean; retry: boolean };

// The decision, apart from the DOM: whether this measured layout is written, kept, or measured again later.
export function recordDecision(
    measured: RememberedLayout,
    last: RememberedLayout,
    tabId: string,
    facts: RecordFacts
): RecordOutcome {
    if (facts.switching) {
        return { layout: last, save: false, retry: true };
    }
    if (!facts.visible || facts.activeTabId !== tabId || measured == null) {
        return { layout: last, save: false, retry: false };
    }
    // An empty tab is written empty, so another view's layout never stays as this workspace's; panels the tab holds but
    // not mounted yet are measured again.
    if (measured.panels.length === 0 && facts.tabBlocks > 0) {
        return { layout: last, save: false, retry: true };
    }
    if (sameLayout(measured, last)) {
        return { layout: last, save: false, retry: false };
    }
    return { layout: measured, save: true, retry: false };
}

function tabBlockCount(tabId: string): number {
    const tab = WOS.getObjectValue<Tab>(WOS.makeORef("tab", tabId));
    return tab?.blockids?.length ?? 0;
}

export function recordLayoutNow(workspaceId: string, tabId: string, last: RememberedLayout): RecordOutcome {
    const content = contentElement();
    let measured: RememberedLayout = null;
    if (content != null) {
        const r = content.getBoundingClientRect();
        measured = measureLayout(
            workspaceId,
            tabId,
            { left: r.left, top: r.top, width: r.width, height: r.height },
            { width: window.innerWidth, height: window.innerHeight },
            measureBlocks(content),
            Date.now()
        );
    }
    const outcome = recordDecision(measured, last, tabId, {
        visible: document.visibilityState === "visible",
        switching: leaving() || arriving(),
        activeTabId: globalStore.get(atoms.workspace)?.activetabid ?? "",
        tabBlocks: tabBlockCount(tabId),
    });
    if (outcome.save) {
        saveLayout(outcome.layout);
    }
    return outcome;
}

export function pruneLayouts(workspaceIds: readonly string[]) {
    if (workspaceIds == null || workspaceIds.length === 0) {
        return;
    }
    try {
        const keys = Object.keys(window.localStorage).filter((k) => k.startsWith(LayoutKeyPrefix));
        for (const key of staleLayoutKeys(keys, workspaceIds)) {
            window.localStorage.removeItem(key);
        }
    } catch {
        // Nothing to prune without storage.
    }
}

// Keeps the layout of the view on screen up to date; returns what stops it. The sidebar loads this module once it is
// idle, so the first paint does not carry it.
export function startRememberLayout(workspaceId: string, tabId: string): () => void {
    if (!workspaceId || !tabId || !switchLayoutOn()) {
        return () => {};
    }
    let last = loadLayout(workspaceId);
    let timer: ReturnType<typeof setTimeout> = null;
    let retries = 0;
    const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(record, LayoutSettleMs);
    };
    const record = () => {
        timer = null;
        const outcome = recordLayoutNow(workspaceId, tabId, last);
        last = outcome.layout;
        // A switch under way, or panels still mounting: measured again a little later, a bounded number of times.
        retries = outcome.retry ? retries + 1 : 0;
        if (outcome.retry && retries <= LayoutMaxRetries) {
            schedule();
        }
    };
    const onChange = () => {
        retries = 0;
        schedule();
    };
    const model = getLayoutModelForStaticTab();
    const unsubs: (() => void)[] = [];
    if (model != null && globalStore.get(atoms.staticTabId) === tabId) {
        unsubs.push(globalStore.sub(model.additionalProps, onChange));
        unsubs.push(globalStore.sub(model.leafs, onChange));
    }
    window.addEventListener("resize", onChange);
    document.addEventListener("visibilitychange", onChange);
    schedule();
    return () => {
        clearTimeout(timer);
        unsubs.forEach((u) => u());
        window.removeEventListener("resize", onChange);
        document.removeEventListener("visibilitychange", onChange);
    };
}
