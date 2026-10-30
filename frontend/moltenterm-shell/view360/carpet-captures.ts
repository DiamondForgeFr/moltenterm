// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Still captures of the carpet's panels (FR-SHELL-065 AC11-AC12, FR-SHELL-125 AC14, DS-SHELL-152): the edge peeks and
// the tab strip's preview show a panel's last capture, never a live view (a browser panel is a web view: it cannot be
// tilted, and a live copy would cost frames). A column is captured while it rests in view: once the carpet has stayed
// still for CaptureSettleMs after a scroll, a layout pass or a focus change, each column in view whose capture is
// missing or older than CaptureMinGapMs is captured, one at a time, as a thumbnail. Nothing runs at rest.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";

export const CaptureSettleMs = 700;
export const CaptureMinGapMs = 4000;
// The thumbnail's width in device pixels: the preview card (240 px) on a 2x screen.
export const CaptureThumbPx = 480;
// A capture over this size is not kept (a data URL held per carpet panel).
export const CaptureMaxChars = 600_000;

export type CarpetCapture = { url: string; width: number; height: number; at: number };

export type CaptureRect = { x: number; y: number; width: number; height: number };

// A column in view that may be captured now, in the window's coordinates.
export type CaptureTarget = { columnId: string; rect: CaptureRect };

const captureAtoms = new Map<string, PrimitiveAtom<CarpetCapture>>();

export function carpetCaptureAtom(columnId: string): PrimitiveAtom<CarpetCapture> {
    let a = captureAtoms.get(columnId);
    if (a == null) {
        a = atom(null) as PrimitiveAtom<CarpetCapture>;
        captureAtoms.set(columnId, a);
    }
    return a;
}

export function readCarpetCapture(columnId: string): CarpetCapture {
    const a = captureAtoms.get(columnId);
    return a == null ? null : globalStore.get(a);
}

export function writeCarpetCapture(columnId: string, capture: CarpetCapture) {
    globalStore.set(carpetCaptureAtom(columnId), capture);
}

// The captures of columns no longer on the carpet are dropped.
export function dropCarpetCaptures(keepColumnIds: readonly string[]) {
    const keep = new Set(keepColumnIds);
    for (const [columnId, a] of captureAtoms) {
        if (!keep.has(columnId) && globalStore.get(a) != null) {
            globalStore.set(a, null);
        }
    }
}

// Whether a column's capture is due: none yet, or older than the gap.
export function captureDue(capture: CarpetCapture, now: number, minGapMs = CaptureMinGapMs): boolean {
    return capture == null || now - capture.at >= minGapMs;
}

// How long until the oldest of these captures is due, null when one already is or none is held.
export function nextDueInMs(captures: CarpetCapture[], now: number, minGapMs = CaptureMinGapMs): number {
    let wait: number = null;
    for (const c of captures) {
        if (captureDue(c, now, minGapMs)) {
            return 0;
        }
        const left = c.at + minGapMs - now;
        wait = wait == null ? left : Math.min(wait, left);
    }
    return wait;
}

export type CaptureClock = {
    setTimeout: (fn: () => void, ms: number) => any;
    clearTimeout: (handle: any) => void;
    now: () => number;
};

const RealClock: CaptureClock = {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle),
    now: () => Date.now(),
};

export type CaptureSource = {
    // The columns in view, whole, that nothing covers.
    targets(): CaptureTarget[];
    // The carpet stands still: no scroll, drag or magnified panel, the window on screen.
    atRest(): boolean;
    capture(rect: CaptureRect): Promise<string>;
};

// Runs the captures of one carpet. noteChange() is called on each scroll frame, layout pass or focus change: it only
// restarts one timer. When the timer ends at rest, the due columns are captured one at a time; a change during a
// capture discards it (it may show a half-moved frame). Columns captured too recently get one follow-up timer, not a
// loop: once they are captured, nothing is left to run.
export class CarpetCaptureScheduler {
    source: CaptureSource;
    clock: CaptureClock;
    read: (columnId: string) => CarpetCapture;
    write: (columnId: string, capture: CarpetCapture) => void;
    timer: any = null;
    generation = 0;
    // The change whose follow-up timer was set.
    followedUp = -1;
    running = false;
    disposed = false;

    constructor(
        source: CaptureSource,
        clock: CaptureClock = RealClock,
        read: (columnId: string) => CarpetCapture = readCarpetCapture,
        write: (columnId: string, capture: CarpetCapture) => void = writeCarpetCapture
    ) {
        this.source = source;
        this.clock = clock;
        this.read = read;
        this.write = write;
    }

    noteChange() {
        if (this.disposed) {
            return;
        }
        this.generation++;
        this.schedule(CaptureSettleMs);
    }

    dispose() {
        this.disposed = true;
        this.generation++;
        this.cancel();
    }

    private cancel() {
        if (this.timer != null) {
            this.clock.clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private schedule(ms: number) {
        this.cancel();
        this.timer = this.clock.setTimeout(() => {
            this.timer = null;
            void this.run();
        }, ms);
    }

    async run(): Promise<void> {
        if (this.disposed) {
            return;
        }
        if (this.running || !this.source.atRest()) {
            this.schedule(CaptureSettleMs);
            return;
        }
        const generation = this.generation;
        const targets = this.source.targets();
        const now = this.clock.now();
        const due = targets.filter((t) => captureDue(this.read(t.columnId), now));
        this.running = true;
        try {
            for (const target of due) {
                if (this.disposed || generation !== this.generation || !this.source.atRest()) {
                    return;
                }
                let url: string = null;
                try {
                    url = await this.source.capture(target.rect);
                } catch {
                    url = null;
                }
                if (this.disposed || generation !== this.generation || !this.source.atRest()) {
                    return;
                }
                if (url && url.length <= CaptureMaxChars) {
                    this.write(target.columnId, {
                        url,
                        width: target.rect.width,
                        height: target.rect.height,
                        at: this.clock.now(),
                    });
                }
            }
        } finally {
            this.running = false;
        }
        if (this.disposed || generation !== this.generation || this.followedUp === generation) {
            return;
        }
        // One follow-up per change, for the columns captured too recently: the columns just captured would otherwise
        // be too recent at the follow-up in turn, and the captures would never stop.
        const skipped = targets.filter((t) => !due.includes(t)).map((t) => this.read(t.columnId));
        const wait = nextDueInMs(skipped, this.clock.now());
        if (wait != null && wait > 0) {
            this.followedUp = generation;
            this.schedule(wait);
        }
    }
}
