// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The timers of one mod (FR-PERF-014, DS-PERF-012). The host shadows setTimeout, setInterval, clearTimeout and
// clearInterval in the mod's module scope with these, so that it can count them, measure their callbacks, stop them
// with the mod, and hold them while the tab view is hidden or minimised: a mod's periodic work is paid by the view the
// user looks at, not by every open view. A held timer that came due runs once when the view shows again.

export type MoltenTimerClock = {
    now: () => number;
    setTimeout: (fn: () => void, ms: number) => any;
    clearTimeout: (handle: any) => void;
};

// Handles start far above the browser's own, so a handle from window.setTimeout passed to the shadowed clearTimeout is
// told apart and cleared by the browser.
const FirstHandle = 1_000_000_000;

// The names shadowed in a mod's module scope, in the order of the prologue.
export const MoltenTimerNames = ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] as const;

export type MoltenTimerApi = {
    setTimeout: (fn: (...args: any[]) => void, ms?: number, ...args: any[]) => number;
    setInterval: (fn: (...args: any[]) => void, ms?: number, ...args: any[]) => number;
    clearTimeout: (handle: any) => void;
    clearInterval: (handle: any) => void;
};

type Entry = {
    id: number;
    repeat: boolean;
    ms: number;
    fn: (...args: any[]) => void;
    args: any[];
    due: number;
    handle: any;
};

export class MoltenModTimers {
    clock: MoltenTimerClock;
    // Runs a callback for the mod: the host measures and guards it.
    run: (fn: () => void) => void;
    onCount: (count: number) => void;
    entries = new Map<number, Entry>();
    paused = false;
    disposed = false;
    nextId = FirstHandle;

    constructor(clock: MoltenTimerClock, run: (fn: () => void) => void, onCount: (count: number) => void = () => {}) {
        this.clock = clock;
        this.run = run;
        this.onCount = onCount;
    }

    count(): number {
        return this.entries.size;
    }

    add(repeat: boolean, fn: (...args: any[]) => void, ms: number, args: any[]): number {
        if (typeof fn !== "function") {
            throw new TypeError(`molten: ${repeat ? "setInterval" : "setTimeout"} needs a function`);
        }
        if (this.disposed) {
            return 0;
        }
        // Browsers clamp nested timers to a few ms; an interval of 0 must not spin.
        const delay = Math.max(repeat ? 1 : 0, Number(ms) || 0);
        const entry: Entry = {
            id: this.nextId++,
            repeat,
            ms: delay,
            fn,
            args,
            due: this.clock.now() + delay,
            handle: null,
        };
        this.entries.set(entry.id, entry);
        this.arm(entry);
        this.onCount(this.count());
        return entry.id;
    }

    clear(handle: any) {
        const entry = this.entries.get(handle);
        if (entry == null) {
            if (handle != null && !(typeof handle === "number" && handle >= FirstHandle)) {
                globalThis.clearTimeout(handle);
            }
            return;
        }
        this.disarm(entry);
        this.entries.delete(entry.id);
        this.onCount(this.count());
    }

    pause() {
        if (this.paused) {
            return;
        }
        this.paused = true;
        this.entries.forEach((entry) => this.disarm(entry));
    }

    resume() {
        if (!this.paused) {
            return;
        }
        this.paused = false;
        this.entries.forEach((entry) => this.arm(entry));
    }

    dispose() {
        this.disposed = true;
        this.entries.forEach((entry) => this.disarm(entry));
        this.entries.clear();
        this.onCount(0);
    }

    api(): MoltenTimerApi {
        return {
            setTimeout: (fn, ms, ...args) => this.add(false, fn, ms, args),
            setInterval: (fn, ms, ...args) => this.add(true, fn, ms, args),
            clearTimeout: (handle) => this.clear(handle),
            clearInterval: (handle) => this.clear(handle),
        };
    }

    private arm(entry: Entry) {
        if (this.paused || entry.handle != null) {
            return;
        }
        const delay = Math.max(0, entry.due - this.clock.now());
        entry.handle = this.clock.setTimeout(() => this.fire(entry), delay);
    }

    private disarm(entry: Entry) {
        if (entry.handle == null) {
            return;
        }
        this.clock.clearTimeout(entry.handle);
        entry.handle = null;
    }

    private fire(entry: Entry) {
        entry.handle = null;
        if (this.entries.get(entry.id) !== entry || this.paused) {
            return;
        }
        if (entry.repeat) {
            // Rearmed before the callback runs, so the callback may clear its own interval.
            entry.due = this.clock.now() + entry.ms;
            this.arm(entry);
        } else {
            this.entries.delete(entry.id);
            this.onCount(this.count());
        }
        this.run(() => entry.fn(...entry.args));
    }
}

// Whether the mod declares one of the timer names itself at some level: shadowing it would then be a redeclaration
// (a SyntaxError), so its timers stay the browser's, unmeasured and never held.
export function declaresTimerName(source: string): boolean {
    const names = MoltenTimerNames.join("|");
    return new RegExp(`\\b(?:const|let|var|function|class|import)\\b[^;=(]*\\b(?:${names})\\b`).test(source);
}

// The first line of the module, prepended without a newline so that the mod's line numbers stay right in stack traces.
export function timerPrologue(registryName: string, token: string): string {
    return `const {${MoltenTimerNames.join(",")}}=globalThis.${registryName}.get(${JSON.stringify(token)});`;
}
