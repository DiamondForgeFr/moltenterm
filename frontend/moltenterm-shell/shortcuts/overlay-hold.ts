// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Holding ⌘ alone shows the shortcut overlay (FR-SHELL-090, DS-SHELL-129): a bare ⌘ (Alt off macOS, where Wave's Cmd is
// Alt) arms an 800 ms timer; any other key, a click, the window losing focus or the release disarms it. Nothing is
// ever prevented, so ⌘ chords and terminal input behave exactly as without the overlay.

export const HoldDelayMs = 800;

type TimerApi = {
    set: (fn: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
};

const DefaultTimers: TimerApi = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

// The modifier that plays ⌘'s part on this platform.
export function holdKeyFor(mac: boolean): string {
    return mac ? "Meta" : "Alt";
}

export const ModifierKeys = ["Meta", "Alt", "Control", "Shift", "OS", "AltGraph", "CapsLock", "Fn"];

export function isModifierKey(key: string): boolean {
    return ModifierKeys.includes(key);
}

// The hold key pressed with no other modifier.
export function isBareHoldKey(e: WaveKeyboardEvent, holdKey: string): boolean {
    if (e.key !== holdKey) {
        return false;
    }
    if (holdKey === "Meta") {
        return !e.control && !e.alt && !e.shift;
    }
    return !e.control && !e.meta && !e.shift;
}

export class HoldDetector {
    holdKey: string;
    delayMs: number;
    timers: TimerApi;
    onShow: () => void;
    onHide: () => void;
    timer: unknown = null;
    shown = false;

    constructor(opts: {
        holdKey: string;
        onShow: () => void;
        onHide: () => void;
        delayMs?: number;
        timers?: TimerApi;
    }) {
        this.holdKey = opts.holdKey;
        this.onShow = opts.onShow;
        this.onHide = opts.onHide;
        this.delayMs = opts.delayMs ?? HoldDelayMs;
        this.timers = opts.timers ?? DefaultTimers;
    }

    get armed(): boolean {
        return this.timer != null;
    }

    disarm() {
        if (this.timer == null) {
            return;
        }
        this.timers.clear(this.timer);
        this.timer = null;
    }

    end() {
        this.disarm();
        if (!this.shown) {
            return;
        }
        this.shown = false;
        this.onHide();
    }

    key(e: WaveKeyboardEvent) {
        if (e.type === "keyup") {
            if (e.key === this.holdKey) {
                this.end();
            }
            return;
        }
        if (e.type !== "keydown") {
            return;
        }
        if (isBareHoldKey(e, this.holdKey)) {
            // A held modifier repeats on some systems: the first press counts.
            if (e.repeat || this.armed || this.shown) {
                return;
            }
            this.timer = this.timers.set(() => {
                this.timer = null;
                this.shown = true;
                this.onShow();
            }, this.delayMs);
            return;
        }
        // Another key, or the hold key with another modifier: the hold is a chord, not a request for help.
        this.disarm();
    }

    pointer() {
        this.disarm();
    }

    blur() {
        this.end();
    }
}
