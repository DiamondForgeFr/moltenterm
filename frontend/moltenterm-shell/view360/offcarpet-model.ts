// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Panels off-screen on the carpet are throttled, never unloaded (FR-SHELL-069, DS-SHELL-120). One flag per block says
// whether the panel is off-carpet: the single source the views read. view360-offcarpet.tsx feeds the tracker with the
// carpet columns an IntersectionObserver sees; the block's content stops painting (block.tsx), a browser page is
// reported off-carpet to the webview lifecycle (frozen per moltenterm:hiddenpagefreeze, never discarded), a terminal
// keeps its PTY size and repaints in full on return (termwrap.ts), and companion-like views pause their refresh jobs
// (everyInPanel) and run them once on return.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, Atom, PrimitiveAtom } from "jotai";
import { createContext, useContext } from "react";
import { TabActivity } from "../tab-activity";
import { ActivityPolicy, ActivityRunReason, ActivityScheduler, ActivityState } from "../tab-activity-model";

// A column out of view stays live this long before it is throttled: a panel scrolled past, or one that just left
// the view and is scrolled back, never pays for a pause and a full repaint. Coming back into view is immediate.
export const OffCarpetDelayMs = 2000;

export type OffCarpetClock = {
    setTimeout: (fn: () => void, ms: number) => any;
    clearTimeout: (handle: any) => void;
};

const RealClock: OffCarpetClock = {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

const offCarpetAtoms = new Map<string, PrimitiveAtom<boolean>>();

export function offCarpetAtom(blockId: string): PrimitiveAtom<boolean> {
    let a = offCarpetAtoms.get(blockId);
    if (a == null) {
        a = atom(false) as PrimitiveAtom<boolean>;
        offCarpetAtoms.set(blockId, a);
    }
    return a;
}

export function isOffCarpet(blockId: string): boolean {
    if (!blockId) {
        return false;
    }
    const a = offCarpetAtoms.get(blockId);
    return a != null && globalStore.get(a);
}

function setOffCarpet(blockId: string, off: boolean) {
    const a = offCarpetAtom(blockId);
    if (globalStore.get(a) !== off) {
        globalStore.set(a, off);
    }
}

// Panels that must keep running wherever they are on the carpet, by the reason a view gave (a browser page an agent
// drives: the agent reads and clicks it while the user looks elsewhere).
export const keepLiveAtom = atom({}) as PrimitiveAtom<Record<string, boolean>>;

export function setKeepLive(blockId: string, live: boolean) {
    if (!blockId) {
        return;
    }
    const cur = globalStore.get(keepLiveAtom);
    if (!!cur[blockId] === live) {
        return;
    }
    const next = { ...cur };
    if (live) {
        next[blockId] = true;
    } else {
        delete next[blockId];
    }
    globalStore.set(keepLiveAtom, next);
}

// For the performance harness and DevTools: which panels are off-carpet, and a way to keep one live to compare.
(globalThis as any).moltenOffCarpet = {
    isOffCarpet: (blockId: string) => isOffCarpet(blockId),
    setKeepLive: (blockId: string, live: boolean) => setKeepLive(blockId, live),
};

export type CarpetColumnBlocks = { columnId: string; blockIds: string[] };

// Turns what the observer sees into per-block flags. A block is off-carpet when its column is out of view (margin
// included) for OffCarpetDelayMs, and it is not exempt: focused or magnified (a panel the user works in stays live),
// or kept live by its view (keepLiveAtom). A panel in the fixed zone (the first column, or pinned to it, FR-SHELL-067)
// is always visible and never off-carpet, even if a stale column list still names it.
export class OffCarpetTracker {
    clock: OffCarpetClock;
    set: (blockId: string, off: boolean) => void;
    columns: CarpetColumnBlocks[] = [];
    fixedBlocks = new Set<string>();
    // Columns the observer reports in view; a column it has not reported yet counts as in view.
    outOfView = new Set<string>();
    offColumns = new Set<string>();
    timers = new Map<string, any>();
    exempt = new Set<string>();
    marked = new Set<string>();

    constructor(set: (blockId: string, off: boolean) => void = setOffCarpet, clock: OffCarpetClock = RealClock) {
        this.set = set;
        this.clock = clock;
    }

    setColumns(columns: CarpetColumnBlocks[], fixedBlockIds: string[] = []) {
        this.columns = columns ?? [];
        this.fixedBlocks = new Set((fixedBlockIds ?? []).filter((id) => !!id));
        const ids = new Set(this.columns.map((c) => c.columnId));
        for (const id of [...this.outOfView]) {
            if (!ids.has(id)) {
                this.outOfView.delete(id);
                this.offColumns.delete(id);
                this.clearTimer(id);
            }
        }
        this.apply();
    }

    setExempt(blockIds: string[]) {
        this.exempt = new Set((blockIds ?? []).filter((id) => !!id));
        this.apply();
    }

    noteInView(columnId: string, inView: boolean) {
        if (inView) {
            this.outOfView.delete(columnId);
            this.clearTimer(columnId);
            if (this.offColumns.delete(columnId)) {
                this.apply();
            }
            return;
        }
        if (this.outOfView.has(columnId)) {
            return;
        }
        this.outOfView.add(columnId);
        this.timers.set(
            columnId,
            this.clock.setTimeout(() => {
                this.timers.delete(columnId);
                if (!this.outOfView.has(columnId)) {
                    return;
                }
                this.offColumns.add(columnId);
                this.apply();
            }, OffCarpetDelayMs)
        );
    }

    // Every flag back to live: the view left 360 mode, or the carpet went away.
    clear() {
        for (const id of this.timers.keys()) {
            this.clock.clearTimeout(this.timers.get(id));
        }
        this.timers.clear();
        this.outOfView.clear();
        this.offColumns.clear();
        this.columns = [];
        this.apply();
    }

    private clearTimer(columnId: string) {
        const t = this.timers.get(columnId);
        if (t != null) {
            this.clock.clearTimeout(t);
            this.timers.delete(columnId);
        }
    }

    private apply() {
        const next = new Set<string>();
        for (const column of this.columns) {
            if (!this.offColumns.has(column.columnId)) {
                continue;
            }
            for (const blockId of column.blockIds) {
                if (blockId && !this.exempt.has(blockId) && !this.fixedBlocks.has(blockId)) {
                    next.add(blockId);
                }
            }
        }
        for (const blockId of this.marked) {
            if (!next.has(blockId)) {
                this.set(blockId, false);
            }
        }
        for (const blockId of next) {
            if (!this.marked.has(blockId)) {
                this.set(blockId, true);
            }
        }
        this.marked = next;
    }
}

// A panel's activity: the tab view's, except that a panel off the carpet counts as hidden.
export function panelActivity(tabState: ActivityState, offCarpet: boolean): ActivityState {
    if (offCarpet && (tabState === "active" || tabState === "visible")) {
        return "hidden";
    }
    return tabState;
}

const panelActivityAtoms = new Map<string, Atom<ActivityState>>();

export function panelActivityAtom(blockId: string): Atom<ActivityState> {
    let a = panelActivityAtoms.get(blockId);
    if (a == null) {
        const tabState = TabActivity.getInstance().stateAtom;
        const off = offCarpetAtom(blockId);
        a = atom((get) => panelActivity(get(tabState), get(off)));
        panelActivityAtoms.set(blockId, a);
    }
    return a;
}

// The block a view is drawn in (block.tsx provides it), so a view's hooks find their panel without threading its id.
export const PanelBlockIdContext = createContext<string>(null);

export function usePanelBlockId(): string {
    return useContext(PanelBlockIdContext);
}

// TabActivity.every for a job that belongs to one panel: it also pauses while the panel is off the carpet, and runs
// once, overdue, when the panel comes back (the companion's rule when its view is hidden, #600). Without a block id
// it is the tab view's own job.
export function everyInPanel(
    blockId: string,
    policy: ActivityPolicy,
    run: (reason: ActivityRunReason) => void,
    label = ""
): () => void {
    const activity = TabActivity.getInstance();
    if (!blockId) {
        return activity.every(policy, run, label);
    }
    activity.start();
    const stateAtom = panelActivityAtom(blockId);
    const scheduler = new ActivityScheduler(globalStore.get(stateAtom));
    const stopJob = scheduler.every(policy, run, label);
    const unsubscribe = globalStore.sub(stateAtom, () => scheduler.setState(globalStore.get(stateAtom)));
    return () => {
        unsubscribe();
        stopJob();
    };
}
