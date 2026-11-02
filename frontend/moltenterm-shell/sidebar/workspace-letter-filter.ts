// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Hold a letter or digit over the bottom switcher to show only the workspaces whose name starts with it (FR-SHELL-082,
// #1784). The hold is timed from the first press, so auto-repeat never restarts it and a tap shorter than the delay
// shows nothing. The filter never switches a workspace: only a click does. While the pointer is over the switcher, a
// plain letter or digit is taken here, so a held key never auto-repeats into the focused terminal or editor.

import { globalStore } from "@/app/store/jotaiStore";
import * as keyutil from "@/util/keyutil";
import * as jotai from "jotai";
import { modalIsOpen } from "../modal-open";

export const LetterHoldDelayMs = 1000;

type TimerApi = {
    set: (fn: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
};

const DefaultTimers: TimerApi = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

// The letter a name starts with, folded to lower case without accents: "É" and "e" both give "e".
export function foldLetter(text: string): string {
    const first = Array.from((text ?? "").trim())[0] ?? "";
    return first.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

// A plain letter or digit. ⌘, Ctrl and Alt combinations are never taken; Shift only types a capital.
export function isFilterKey(e: WaveKeyboardEvent): boolean {
    if (e.meta || e.control || e.alt) {
        return false;
    }
    return /^[\p{L}\p{N}]$/u.test(e.key ?? "");
}

// The entries the switcher shows while a letter is held: the matches, in rail order. The active entry keeps its
// place even when it does not match; it is only not drawn while the filter holds.
export function filterEntries<T>(entries: T[], nameOf: (entry: T) => string, letter: string): T[] {
    if (letter == null) {
        return entries;
    }
    return entries.filter((entry) => foldLetter(nameOf(entry)) === letter);
}

// The hold of one letter. `key` gets every keydown and keyup of the window, in order, and returns true when the event
// is the switcher's: the caller then stops it, so the terminal and the editor never see it.
export class LetterHold {
    delayMs: number;
    timers: TimerApi;
    canTake: () => boolean;
    onShow: (letter: string) => void;
    onHide: () => void;
    pointerOver = false;
    // The physical key being held (its code), set from the first press until its release.
    heldCode: string = null;
    timer: unknown = null;
    shown = false;

    constructor(opts: {
        onShow: (letter: string) => void;
        onHide: () => void;
        canTake?: () => boolean;
        delayMs?: number;
        timers?: TimerApi;
    }) {
        this.onShow = opts.onShow;
        this.onHide = opts.onHide;
        this.canTake = opts.canTake ?? (() => true);
        this.delayMs = opts.delayMs ?? LetterHoldDelayMs;
        this.timers = opts.timers ?? DefaultTimers;
    }

    setPointerOver(over: boolean) {
        this.pointerOver = over;
    }

    key(e: WaveKeyboardEvent): boolean {
        if (e.type === "keyup") {
            return this.release(codeOf(e));
        }
        if (e.type !== "keydown") {
            return false;
        }
        if (this.heldCode != null && codeOf(e) === this.heldCode && !e.repeat) {
            this.release(this.heldCode);
        }
        if (this.heldCode != null) {
            return isFilterKey(e);
        }
        if (!isFilterKey(e) || e.repeat || !this.pointerOver || !this.canTake()) {
            return false;
        }
        this.heldCode = codeOf(e);
        const letter = foldLetter(e.key);
        this.timer = this.timers.set(() => {
            this.timer = null;
            this.shown = true;
            this.onShow(letter);
        }, this.delayMs);
        return true;
    }

    // Drops the hold without a release (the window lost focus): nothing stays filtered.
    reset() {
        this.heldCode = null;
        this.disarm();
        this.hide();
    }

    private release(code: string): boolean {
        if (this.heldCode == null || code !== this.heldCode) {
            return false;
        }
        this.heldCode = null;
        this.disarm();
        this.hide();
        return true;
    }

    private disarm() {
        if (this.timer == null) {
            return;
        }
        this.timers.clear(this.timer);
        this.timer = null;
    }

    private hide() {
        if (!this.shown) {
            return;
        }
        this.shown = false;
        this.onHide();
    }
}

// The physical key, so a Shift released before the letter still ends its hold.
function codeOf(e: WaveKeyboardEvent): string {
    return e.code || e.key;
}

export class WorkspaceLetterFilter {
    private static instance: WorkspaceLetterFilter = null;

    letterAtom: jotai.PrimitiveAtom<string> = jotai.atom(null) as jotai.PrimitiveAtom<string>;
    hold: LetterHold;

    private constructor() {
        this.hold = new LetterHold({
            onShow: (letter) => globalStore.set(this.letterAtom, letter),
            onHide: () => globalStore.set(this.letterAtom, null),
            canTake: () => !modalIsOpen(),
        });
    }

    static getInstance(): WorkspaceLetterFilter {
        if (!WorkspaceLetterFilter.instance) {
            WorkspaceLetterFilter.instance = new WorkspaceLetterFilter();
        }
        return WorkspaceLetterFilter.instance;
    }

    pointer(over: boolean) {
        this.hold.setPointerOver(over);
    }
}

let installed = false;

// Once per window, from the shortcuts' key registration. A key typed into a field of the sidebar (the new-workspace
// name) is never taken: that field is the developer's own typing.
export function installWorkspaceLetterFilter() {
    if (typeof document === "undefined" || installed) {
        return;
    }
    installed = true;
    const filter = WorkspaceLetterFilter.getInstance();
    const take = (e: KeyboardEvent) => {
        if (isSidebarField(e.target)) {
            return;
        }
        if (filter.hold.key(keyutil.adaptFromReactOrNativeKeyEvent(e))) {
            e.preventDefault();
            e.stopPropagation();
        }
    };
    document.addEventListener("keydown", take, true);
    document.addEventListener("keyup", take, true);
    window.addEventListener("blur", () => filter.hold.reset());
}

function isSidebarField(target: EventTarget): boolean {
    const el = target as HTMLElement;
    if (el?.closest?.("aside") == null) {
        return false;
    }
    return el.matches("input, textarea") || el.isContentEditable === true;
}
