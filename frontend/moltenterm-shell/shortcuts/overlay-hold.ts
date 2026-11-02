// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Holding ⌘ alone shows the shortcut overlay (FR-SHELL-090, DS-SHELL-129): a bare ⌘ (Alt off macOS, where Wave's Cmd is
// Alt) arms a timer; any other key, a click, the window losing focus or the release disarms it. Nothing is
// ever prevented, so ⌘ chords and terminal input behave exactly as without the overlay.
//
// The overlay must never show while the developer switches app (#1390). The system's app switcher keeps the window
// focused and hides the Tab key from it, so a ⌘+Tab looks like a plain hold: the delay is long enough to outlast a
// switch, and a hold that began before the window had focus (coming back from the switcher) is not ours.

export const HoldDelayMs = 1500;

// A bare ⌘ keydown this soon after the window gained focus is a hold that began elsewhere.
export const FocusGraceMs = 250;

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
    now: () => number;
    isFocused: () => boolean;
    onShow: () => void;
    onHide: () => void;
    timer: unknown = null;
    shown = false;
    focusedAt: number = null;
    // The hold key is down but its press was not seen by this window: nothing shows until it is released.
    inherited = false;

    constructor(opts: {
        holdKey: string;
        onShow: () => void;
        onHide: () => void;
        delayMs?: number;
        timers?: TimerApi;
        now?: () => number;
        isFocused?: () => boolean;
    }) {
        this.holdKey = opts.holdKey;
        this.onShow = opts.onShow;
        this.onHide = opts.onHide;
        this.delayMs = opts.delayMs ?? HoldDelayMs;
        this.timers = opts.timers ?? DefaultTimers;
        this.now = opts.now ?? (() => Date.now());
        this.isFocused = opts.isFocused ?? (() => typeof document === "undefined" || document.hasFocus());
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
                this.inherited = false;
                this.end();
            }
            return;
        }
        if (e.type !== "keydown") {
            return;
        }
        if (isBareHoldKey(e, this.holdKey)) {
            // A held modifier repeats on some systems: the first press counts.
            if (e.repeat || this.armed || this.shown || this.inherited) {
                return;
            }
            if (this.focusedAt != null && this.now() - this.focusedAt < FocusGraceMs) {
                this.inherited = true;
                return;
            }
            this.timer = this.timers.set(() => {
                this.timer = null;
                if (!this.isFocused()) {
                    return;
                }
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
        this.focusedAt = null;
        this.inherited = false;
        this.end();
    }

    focus() {
        this.focusedAt = this.now();
    }
}
