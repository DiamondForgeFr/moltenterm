// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Still captures of the carpet's panels (FR-SHELL-065 AC11-AC12, FR-SHELL-125 AC14, DS-SHELL-152): the edge peeks and
// the tab strip's preview show a panel's thumbnail, never a live view (a browser panel is a web view: it cannot be
// tilted, and a live copy would cost frames). A column is captured while it rests in view: once the carpet has stayed
// still for CaptureSettleMs after a scroll, a layout pass, a focus change or a change of a page's state, each column in
// view that may be captured and whose thumbnail is missing for its tag or older than CaptureMinGapMs is captured, one
// at a time. Nothing runs at rest. The thumbnails are kept across a restart (carpet-thumbs.ts, carpet-thumb-state.ts
// tells when one is valid and when a column may not be captured, so a good one is never replaced by a bad frame).

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";

export const CaptureSettleMs = 700;
export const CaptureMinGapMs = 4000;
// A capture the main process refused (a frame of one flat colour) or that failed is tried again this many times, a
// CaptureMinGapMs apart, for one change of the carpet: a page may paint late.
export const CaptureMaxRetries = 2;
// The thumbnail's width in device pixels: the preview card (240 px) on a 2x screen, and the 640 px a material keeps (FR-MAT-002).
export const CaptureThumbPx = 640;
// A capture over this size is not kept (a data URL held per carpet panel).
export const CaptureMaxChars = 600_000;

// tag: what the column was taken for (carpet-thumb-state.ts); a capture is shown only while it is the column's tag.
export type CarpetCapture = { url: string; width: number; height: number; at: number; tag?: string };

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

// Whether a column's capture is due: none yet, one taken for another tag, or one older than the gap.
export function captureDue(capture: CarpetCapture, now: number, minGapMs = CaptureMinGapMs, tag?: string): boolean {
    return capture == null || (tag != null && capture.tag !== tag) || now - capture.at >= minGapMs;
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
    // An empty answer is a frame the main process refused (one flat colour): nothing is kept.
    capture(rect: CaptureRect, target: CaptureTarget): Promise<string>;
    // What a column's thumbnail would be taken for and whether the column may be captured now (carpet-thumb-state.ts):
    // not while a page is loading, failed, crashed, unloaded or blank. Without it every column is captured for no tag.
    inspect?(columnId: string): { tag: string; capturable: boolean };
};

const Uninspected = { tag: undefined as string, capturable: true };

const liveSchedulers = new Set<CarpetCaptureScheduler>();

// Registers a running scheduler with wakeCarpetCaptures; returns the way out.
export function registerCarpetScheduler(scheduler: CarpetCaptureScheduler): () => void {
    liveSchedulers.add(scheduler);
    return () => {
        liveSchedulers.delete(scheduler);
    };
}

// Something that had covered the carpet is gone (the tab strip's preview card): the columns it hid may be captured.
export function wakeCarpetCaptures(): void {
    for (const scheduler of liveSchedulers) {
        scheduler.noteChange();
    }
}

// Runs the captures of one carpet. noteChange() is called on each scroll frame, layout pass, focus change or change of
// a page's state: it only restarts one timer. When the timer ends at rest, the due columns are captured one at a time;
// a change during a capture discards it (it may show a half-moved frame, or a page that started loading). Columns
// captured too recently get one follow-up timer, not a loop: once they are captured, nothing is left to run. A column
// that may not be captured (a page still loading) is left alone: the change that makes it capturable wakes us again.
export class CarpetCaptureScheduler {
    source: CaptureSource;
    clock: CaptureClock;
    read: (columnId: string) => CarpetCapture;
    write: (columnId: string, capture: CarpetCapture) => void;
    timer: any = null;
    generation = 0;
    // The change whose follow-up timer was set.
    followedUp = -1;
    // How many times the captures that came back empty were tried again since the last change.
    retries = 0;
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
        this.retries = 0;
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

    private inspect(columnId: string) {
        return this.source.inspect?.(columnId) ?? Uninspected;
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
        const targets = this.source.targets().filter((t) => this.inspect(t.columnId).capturable);
        const now = this.clock.now();
        const due = targets.filter((t) =>
            captureDue(this.read(t.columnId), now, CaptureMinGapMs, this.inspect(t.columnId).tag)
        );
        let emptyHanded = 0;
        this.running = true;
        try {
            for (const target of due) {
                if (this.disposed || generation !== this.generation || !this.source.atRest()) {
                    return;
                }
                const before = this.inspect(target.columnId);
                let url: string = null;
                try {
                    url = await this.source.capture(target.rect, target);
                } catch {
                    url = null;
                }
                if (this.disposed || generation !== this.generation || !this.source.atRest()) {
                    return;
                }
                const after = this.inspect(target.columnId);
                if (!after.capturable || after.tag !== before.tag) {
                    continue;
                }
                if (url && url.length <= CaptureMaxChars) {
                    this.write(target.columnId, {
                        url,
                        width: target.rect.width,
                        height: target.rect.height,
                        at: this.clock.now(),
                        tag: before.tag,
                    });
                } else {
                    emptyHanded++;
                }
            }
        } finally {
            this.running = false;
        }
        if (this.disposed || generation !== this.generation) {
            return;
        }
        let wait: number = null;
        if (this.followedUp !== generation) {
            // One follow-up per change, for the columns captured too recently: the columns just captured would
            // otherwise be too recent at the follow-up in turn, and the captures would never stop.
            const skipped = targets.filter((t) => !due.includes(t)).map((t) => this.read(t.columnId));
            const left = nextDueInMs(skipped, this.clock.now());
            if (left != null && left > 0) {
                this.followedUp = generation;
                wait = left;
            }
        }
        if (emptyHanded > 0 && this.retries < CaptureMaxRetries) {
            this.retries++;
            wait = wait == null ? CaptureMinGapMs : Math.min(wait, CaptureMinGapMs);
        }
        if (wait != null) {
            this.schedule(wait);
        }
    }
}
