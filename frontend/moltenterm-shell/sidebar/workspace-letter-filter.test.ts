// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Hold a letter over the bottom switcher to filter the workspaces by their first letter (FR-SHELL-082, #1784).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LetterHold, LetterHoldDelayMs, filterEntries, foldLetter, isFilterKey } from "./workspace-letter-filter";

function ev(type: "keydown" | "keyup", key: string, mods: Partial<WaveKeyboardEvent> = {}): WaveKeyboardEvent {
    return {
        type,
        key,
        code: mods.code ?? `Key${key.toUpperCase()}`,
        meta: !!mods.meta,
        alt: !!mods.alt,
        control: !!mods.control,
        shift: !!mods.shift,
        cmd: !!mods.meta,
        option: !!mods.alt,
        repeat: !!mods.repeat,
        location: 0,
    } as WaveKeyboardEvent;
}

function holdOf(opts: { canTake?: () => boolean } = {}) {
    const shown: string[] = [];
    let hides = 0;
    const hold = new LetterHold({
        onShow: (letter) => shown.push(letter),
        onHide: () => hides++,
        canTake: opts.canTake,
    });
    hold.setPointerOver(true);
    return { hold, shown, hides: () => hides };
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("first letter of a workspace name (FR-SHELL-082)", () => {
    it("folds accents and case: é matches E", () => {
        expect(foldLetter("Été")).toBe("e");
        expect(foldLetter("élan")).toBe("e");
        expect(foldLetter("  Zeta")).toBe("z");
        expect(foldLetter("")).toBe("");
    });

    it("keeps the workspaces that start with the letter, in rail order", () => {
        const entries = [{ name: "Alpha" }, { name: "Beta" }, { name: "Ébène" }, { name: "avril" }];
        expect(filterEntries(entries, (w) => w.name, "a").map((w) => w.name)).toEqual(["Alpha", "avril"]);
        expect(filterEntries(entries, (w) => w.name, "e").map((w) => w.name)).toEqual(["Ébène"]);
        expect(filterEntries(entries, (w) => w.name, "z")).toEqual([]);
    });

    it("shows every workspace when no letter is held", () => {
        const entries = [{ name: "Alpha" }, { name: "Beta" }];
        expect(filterEntries(entries, (w) => w.name, null)).toBe(entries);
    });
});

describe("which keys are taken", () => {
    it("takes a plain letter or digit, Shift included", () => {
        expect(isFilterKey(ev("keydown", "e"))).toBe(true);
        expect(isFilterKey(ev("keydown", "E", { shift: true }))).toBe(true);
        expect(isFilterKey(ev("keydown", "7"))).toBe(true);
    });

    it("never takes a modifier combination or a non-character key", () => {
        expect(isFilterKey(ev("keydown", "e", { meta: true }))).toBe(false);
        expect(isFilterKey(ev("keydown", "e", { control: true }))).toBe(false);
        expect(isFilterKey(ev("keydown", "e", { alt: true }))).toBe(false);
        expect(isFilterKey(ev("keydown", "Shift"))).toBe(false);
        expect(isFilterKey(ev("keydown", "Enter"))).toBe(false);
        expect(isFilterKey(ev("keydown", " "))).toBe(false);
    });
});

describe("holding a letter over the switcher", () => {
    it("starts nothing and takes nothing while the pointer is elsewhere", () => {
        const { hold, shown } = holdOf();
        hold.setPointerOver(false);
        expect(hold.key(ev("keydown", "e"))).toBe(false);
        vi.advanceTimersByTime(LetterHoldDelayMs * 2);
        expect(shown).toEqual([]);
    });

    it("shows the letter once the key has been held for the delay", () => {
        const { hold, shown } = holdOf();
        expect(hold.key(ev("keydown", "e"))).toBe(true);
        vi.advanceTimersByTime(LetterHoldDelayMs - 1);
        expect(shown).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(shown).toEqual(["e"]);
    });

    it("keeps auto-repeat away from the terminal and does not restart the hold", () => {
        const { hold, shown } = holdOf();
        hold.key(ev("keydown", "e"));
        vi.advanceTimersByTime(LetterHoldDelayMs / 2);
        expect(hold.key(ev("keydown", "e", { repeat: true }))).toBe(true);
        vi.advanceTimersByTime(LetterHoldDelayMs / 2);
        expect(shown).toEqual(["e"]);
    });

    it("a tap shorter than the delay shows nothing and ends with its release", () => {
        const { hold, shown, hides } = holdOf();
        hold.key(ev("keydown", "e"));
        expect(hold.key(ev("keyup", "e"))).toBe(true);
        vi.advanceTimersByTime(LetterHoldDelayMs * 2);
        expect(shown).toEqual([]);
        expect(hides()).toBe(0);
    });

    it("releasing after the filter shows hides it once", () => {
        const { hold, shown, hides } = holdOf();
        hold.key(ev("keydown", "e"));
        vi.advanceTimersByTime(LetterHoldDelayMs);
        expect(hold.key(ev("keyup", "e"))).toBe(true);
        expect(shown).toEqual(["e"]);
        expect(hides()).toBe(1);
    });

    it("keeps the first letter when another letter is pressed meanwhile", () => {
        const { hold, shown } = holdOf();
        hold.key(ev("keydown", "e"));
        expect(hold.key(ev("keydown", "b"))).toBe(true);
        vi.advanceTimersByTime(LetterHoldDelayMs);
        expect(shown).toEqual(["e"]);
    });

    it("a modifier combination is not a hold: the key goes through", () => {
        const { hold, shown } = holdOf();
        expect(hold.key(ev("keydown", "e", { control: true }))).toBe(false);
        expect(hold.key(ev("keydown", "e", { meta: true }))).toBe(false);
        vi.advanceTimersByTime(LetterHoldDelayMs);
        expect(shown).toEqual([]);
    });

    it("an auto-repeat that started before the pointer came in is not taken", () => {
        const { hold, shown } = holdOf();
        hold.setPointerOver(false);
        hold.key(ev("keydown", "e"));
        hold.setPointerOver(true);
        expect(hold.key(ev("keydown", "e", { repeat: true }))).toBe(false);
        vi.advanceTimersByTime(LetterHoldDelayMs);
        expect(shown).toEqual([]);
    });

    it("a hold that started over the switcher still takes its repeats after the pointer leaves", () => {
        const { hold, shown } = holdOf();
        hold.key(ev("keydown", "e"));
        hold.setPointerOver(false);
        expect(hold.key(ev("keydown", "e", { repeat: true }))).toBe(true);
        vi.advanceTimersByTime(LetterHoldDelayMs);
        expect(shown).toEqual(["e"]);
    });

    it("a held letter is released by its physical key even when Shift went up first", () => {
        const { hold, hides } = holdOf();
        hold.key(ev("keydown", "E", { shift: true, code: "KeyE" }));
        vi.advanceTimersByTime(LetterHoldDelayMs);
        expect(hold.key(ev("keyup", "e", { code: "KeyE" }))).toBe(true);
        expect(hides()).toBe(1);
    });

    it("a fresh press of the same key, its release unseen, starts a new hold", () => {
        const { hold, shown } = holdOf();
        hold.key(ev("keydown", "e"));
        vi.advanceTimersByTime(LetterHoldDelayMs);
        expect(hold.key(ev("keydown", "e"))).toBe(true);
        vi.advanceTimersByTime(LetterHoldDelayMs);
        expect(shown).toEqual(["e", "e"]);
    });

    it("does nothing while a dialog is open", () => {
        const { hold, shown } = holdOf({ canTake: () => false });
        expect(hold.key(ev("keydown", "e"))).toBe(false);
        vi.advanceTimersByTime(LetterHoldDelayMs);
        expect(shown).toEqual([]);
    });

    it("the window losing focus ends a shown filter without a release", () => {
        const { hold, hides } = holdOf();
        hold.key(ev("keydown", "e"));
        vi.advanceTimersByTime(LetterHoldDelayMs);
        hold.reset();
        expect(hides()).toBe(1);
        vi.advanceTimersByTime(LetterHoldDelayMs);
        expect(hides()).toBe(1);
    });
});
