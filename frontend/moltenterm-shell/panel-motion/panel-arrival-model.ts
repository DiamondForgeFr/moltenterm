// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A panel's arrival (FR-SHELL-112, #1349): a panel that a split, an insert or an agent adds to a view that already
// shows panels arrives instead of appearing: an orange edge runs once around its frame, then goes out
// (panel-motion.css). The layout model hands over the blocks it added (layoutModel.ts, notePanelsArrived). A panel
// added while its view is not on screen arrives when the view comes back, after the view's pour (one moment at a
// time). The first panel of a new view does not: the view itself is what is new. The edge is drawn by
// panel-arrival.tsx; this model holds no React, so the layout model can call it.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import { TabActivity } from "../tab-activity";
import { isShowing } from "../tab-activity-model";
import { onViewPour, pourWaitMs } from "./pour-moment";

// A view shown again without a switch (the window restored) has no pour: its pending arrivals wait this long for a
// switch's pour to start, then play.
export const ArrivalShownGraceMs = 300;

export type ArrivalDeps = {
    showing: () => boolean;
    onActivity: (cb: () => void) => () => void;
    onPour: (cb: () => void) => () => void;
    waitMs: () => number;
    later: (cb: () => void, ms: number) => () => void;
};

function defaultDeps(): ArrivalDeps {
    return {
        showing: () => isShowing(TabActivity.getInstance().state()),
        onActivity: (cb) => globalStore.sub(TabActivity.getInstance().stateAtom, cb),
        onPour: onViewPour,
        waitMs: () => pourWaitMs(),
        later: (cb, ms) => {
            const timer = setTimeout(cb, ms);
            return () => clearTimeout(timer);
        },
    };
}

export class PanelArrival {
    private static instance: PanelArrival = null;

    seqAtoms = new Map<string, PrimitiveAtom<number>>();
    delays = new Map<string, number>();
    pending: string[] = [];
    seq = 0;
    stops: (() => void)[] = [];
    cancelGrace: () => void = null;
    deps: ArrivalDeps;

    private constructor(deps: ArrivalDeps) {
        this.deps = deps;
    }

    static getInstance(): PanelArrival {
        if (!PanelArrival.instance) {
            PanelArrival.instance = new PanelArrival(defaultDeps());
        }
        return PanelArrival.instance;
    }

    static resetInstance(): void {
        PanelArrival.instance?.stopWaiting();
        PanelArrival.instance = null;
    }

    static makeForTest(deps: ArrivalDeps): PanelArrival {
        return new PanelArrival(deps);
    }

    seqAtom(blockId: string): PrimitiveAtom<number> {
        let a = this.seqAtoms.get(blockId);
        if (a == null) {
            a = atom(0) as PrimitiveAtom<number>;
            this.seqAtoms.set(blockId, a);
        }
        return a;
    }

    delayMs(blockId: string): number {
        return this.delays.get(blockId) ?? 0;
    }

    // added: the blocks the layout just placed; leafCount: the panels the view shows now, those included.
    note(added: string[], leafCount: number) {
        const ids = (added ?? []).filter((id) => !!id);
        if (ids.length === 0 || leafCount <= ids.length) {
            return;
        }
        if (this.deps.showing()) {
            this.play(ids);
            return;
        }
        this.pending.push(...ids.filter((id) => !this.pending.includes(id)));
        this.waitForScreen();
    }

    private waitForScreen() {
        if (this.stops.length > 0) {
            return;
        }
        this.stops.push(this.deps.onPour(() => this.flush()));
        this.stops.push(
            this.deps.onActivity(() => {
                if (!this.deps.showing() || this.cancelGrace != null) {
                    return;
                }
                this.cancelGrace = this.deps.later(() => {
                    this.cancelGrace = null;
                    this.flush();
                }, ArrivalShownGraceMs);
            })
        );
    }

    private stopWaiting() {
        this.stops.forEach((stop) => stop());
        this.stops = [];
        this.cancelGrace?.();
        this.cancelGrace = null;
    }

    flush() {
        if (!this.deps.showing() || this.pending.length === 0) {
            return;
        }
        const ids = this.pending;
        this.pending = [];
        this.stopWaiting();
        this.play(ids);
    }

    play(ids: string[]) {
        const wait = this.deps.waitMs();
        this.seq++;
        for (const id of ids) {
            this.delays.set(id, wait);
            globalStore.set(this.seqAtom(id), this.seq);
        }
    }

    done(blockId: string, seq: number) {
        const a = this.seqAtoms.get(blockId);
        if (a == null || globalStore.get(a) !== seq) {
            return;
        }
        globalStore.set(a, 0);
        this.delays.delete(blockId);
    }
}

export function notePanelsArrived(added: string[], leafCount: number) {
    PanelArrival.getInstance().note(added, leafCount);
}
