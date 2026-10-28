// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Hold ⌘ to show the shortcut overlay, ⌘/ to keep it (FR-SHELL-090, TC-SHELL-169).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayController, OverlayMode } from "./overlay-controller";
import { HoldDelayMs, HoldDetector } from "./overlay-hold";

function ev(type: "keydown" | "keyup", key: string, mods: Partial<WaveKeyboardEvent> = {}): WaveKeyboardEvent {
    const meta = key === "Meta" || !!mods.meta;
    const alt = key === "Alt" || !!mods.alt;
    return {
        type,
        key,
        code: key,
        meta,
        alt,
        control: !!mods.control,
        shift: !!mods.shift,
        cmd: meta,
        option: alt,
        repeat: !!mods.repeat,
        location: 0,
    } as WaveKeyboardEvent;
}

function detector() {
    const shown: string[] = [];
    const d = new HoldDetector({
        holdKey: "Meta",
        onShow: () => shown.push("show"),
        onHide: () => shown.push("hide"),
    });
    return { d, shown };
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("hold ⌘ (FR-SHELL-090)", () => {
    it("shows after 0.8 s of ⌘ alone and hides on release", () => {
        const { d, shown } = detector();
        d.key(ev("keydown", "Meta"));
        vi.advanceTimersByTime(HoldDelayMs - 1);
        expect(shown).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(shown).toEqual(["show"]);
        d.key(ev("keyup", "Meta"));
        expect(shown).toEqual(["show", "hide"]);
    });

    it("shows nothing when another key comes within 0.8 s: the chord is the user's", () => {
        const { d, shown } = detector();
        d.key(ev("keydown", "Meta"));
        vi.advanceTimersByTime(300);
        d.key(ev("keydown", "d", { meta: true }));
        vi.advanceTimersByTime(5000);
        d.key(ev("keyup", "Meta"));
        expect(shown).toEqual([]);
    });

    it("shows nothing for a release before 0.8 s, a click, ⌘ with another modifier, or a lost focus", () => {
        const { d, shown } = detector();
        d.key(ev("keydown", "Meta"));
        d.key(ev("keyup", "Meta"));
        d.key(ev("keydown", "Meta"));
        d.pointer();
        d.key(ev("keydown", "Meta", { shift: true }));
        vi.advanceTimersByTime(5000);
        d.key(ev("keydown", "Meta"));
        d.blur();
        vi.advanceTimersByTime(5000);
        expect(shown).toEqual([]);
    });

    it("counts the first press only when the held key repeats", () => {
        const { d, shown } = detector();
        d.key(ev("keydown", "Meta"));
        vi.advanceTimersByTime(500);
        d.key(ev("keydown", "Meta", { repeat: true }));
        vi.advanceTimersByTime(300);
        expect(shown).toEqual(["show"]);
    });

    it("holds Alt off macOS", () => {
        const shown: string[] = [];
        const d = new HoldDetector({ holdKey: "Alt", onShow: () => shown.push("show"), onHide: () => {} });
        d.key(ev("keydown", "Meta"));
        vi.advanceTimersByTime(HoldDelayMs);
        expect(shown).toEqual([]);
        d.key(ev("keydown", "Alt"));
        vi.advanceTimersByTime(HoldDelayMs);
        expect(shown).toEqual(["show"]);
    });
});

describe("overlay controller (FR-SHELL-090)", () => {
    function controller(canOpen = true) {
        const modes: OverlayMode[] = [];
        const ctl = new OverlayController({
            mac: true,
            canOpen: () => canOpen,
            loader: async () => ({
                mountShortcutOverlay: () => ({
                    setMode: (m: OverlayMode) => modes.push(m),
                    close: () => {},
                    contains: (n: Node) => n === InsideNode,
                }),
            }),
        });
        return { ctl, modes };
    }
    const InsideNode = {} as Node;

    it("keeps an overlay opened by ⌘/ after ⌘ is released, until Escape", async () => {
        const { ctl, modes } = controller();
        ctl.key(ev("keydown", "Meta"));
        ctl.key(ev("keydown", "/", { meta: true }));
        ctl.toggle();
        await vi.runAllTimersAsync();
        expect(ctl.mode).toBe("pinned");
        ctl.key(ev("keyup", "Meta"));
        expect(ctl.mode).toBe("pinned");
        expect(ctl.key(ev("keydown", "Escape"))).toBe(true);
        expect(ctl.mode).toBe("closed");
        expect(modes).toEqual(["pinned", "closed"]);
    });

    it("closes on any shortcut and lets it run (not swallowed), and on a click outside only", async () => {
        const { ctl } = controller();
        ctl.toggle();
        await vi.runAllTimersAsync();
        expect(ctl.key(ev("keydown", "d", { meta: true }))).toBe(false);
        expect(ctl.mode).toBe("closed");
        ctl.toggle();
        ctl.pointer(InsideNode);
        expect(ctl.mode).toBe("pinned");
        ctl.pointer(null);
        expect(ctl.mode).toBe("closed");
    });

    it("shows on a hold, hides on release, and turns a held overlay into a kept one with ⌘/", async () => {
        const { ctl } = controller();
        ctl.key(ev("keydown", "Meta"));
        await vi.advanceTimersByTimeAsync(HoldDelayMs);
        expect(ctl.mode).toBe("held");
        ctl.key(ev("keyup", "Meta"));
        expect(ctl.mode).toBe("closed");
        ctl.key(ev("keydown", "Meta"));
        await vi.advanceTimersByTimeAsync(HoldDelayMs);
        ctl.toggle();
        ctl.key(ev("keyup", "Meta"));
        expect(ctl.mode).toBe("pinned");
        ctl.toggle();
        expect(ctl.mode).toBe("closed");
    });

    it("opens nothing under a dialog", async () => {
        const { ctl, modes } = controller(false);
        ctl.toggle();
        ctl.key(ev("keydown", "Meta"));
        await vi.advanceTimersByTimeAsync(HoldDelayMs);
        expect(ctl.mode).toBe("closed");
        expect(modes).toEqual([]);
    });
});
