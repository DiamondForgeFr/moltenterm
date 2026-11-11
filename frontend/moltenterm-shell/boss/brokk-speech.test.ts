// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return { atoms: { prefersReducedMotionAtom: atom(false) } };
});
const Asked = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("./brokk-expressions", () => ({
    BrokkExpressionsModel: { getInstance: () => ({ ask: (...args: unknown[]) => Asked.calls.push(args) }) },
}));
// His session's exchange is read as it is; the session itself has its own tests (brokk-session).
vi.mock("./brokk-session", async () => {
    const { atom } = await import("jotai");
    const session = { exchangeAtom: atom([] as any[]) };
    return { BrokkSession: { getInstance: () => session } };
});

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import type { PrimitiveAtom } from "jotai";
import { withAnswer, withMessage } from "./brokk-exchange-model";
import { BrokkSession } from "./brokk-session";
import { BrokkSpeech, latestAnswer, NothingShown } from "./brokk-speech";
import { RevealCapMs, SpeakingSettleMs } from "./brokk-speech-model";

const reducedAtom = atoms.prefersReducedMotionAtom as unknown as PrimitiveAtom<boolean>;

// A fake transcript, read the way his session reads it: synthetic text only (FR-BOSS-009, AC87, AC88, #2259).
class Clock {
    now = 0;
    timers: { at: number; run: () => void }[] = [];
    set = (run: () => void, ms: number) => {
        const timer = { at: this.now + ms, run };
        this.timers.push(timer);
        return timer;
    };
    clear = (timer: unknown) => {
        this.timers = this.timers.filter((other) => other !== timer);
    };
    advance(ms: number) {
        const until = this.now + ms;
        for (;;) {
            const next = this.timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
            if (next == null) {
                break;
            }
            this.clear(next);
            this.now = next.at;
            next.run();
        }
        this.now = until;
    }
}

class Target {
    listeners = new Map<string, Set<(event: unknown) => void>>();
    addEventListener(type: string, listener: (event: unknown) => void) {
        if (!this.listeners.has(type)) {
            this.listeners.set(type, new Set());
        }
        this.listeners.get(type).add(listener);
    }
    removeEventListener(type: string, listener: (event: unknown) => void) {
        this.listeners.get(type)?.delete(listener);
    }
    fire(type: string) {
        this.listeners.get(type)?.forEach((listener) => listener({}));
    }
}

const exchangeAtom = (BrokkSession.getInstance() as any).exchangeAtom;

function read(markdown: string, final = false) {
    globalStore.set(exchangeAtom, (items: any[]) => withAnswer(items, "m1", { markdown, turn: 1, at: 1, final }));
}

function shownText(speech: BrokkSpeech): string {
    const shown = globalStore.get(speech.shownAtom);
    const item = latestAnswer(globalStore.get(exchangeAtom));
    return shown.id == null ? item.text : item.text.slice(0, shown.count);
}

describe("Brokk says his answer while his group shows (AC87, AC88)", () => {
    let clock: Clock;
    let target: Target;
    let speech: BrokkSpeech;
    let stop: () => void;

    beforeEach(() => {
        BrokkSpeech.resetInstance();
        Asked.calls = [];
        clock = new Clock();
        target = new Target();
        globalStore.set(reducedAtom, false);
        globalStore.set(exchangeAtom, withMessage([], "m1", "How are you?", 0));
        speech = BrokkSpeech.getInstance();
        speech.useClock(() => clock.now, { set: clock.set, clear: clock.clear });
        stop = speech.watch(target);
    });

    afterEach(() => {
        stop();
    });

    it("smiles, then speaks while his words show, then settles", () => {
        clock.advance(3000);
        read("[[smile]]\nFine, thanks. The forge is warm and the coffee is hot.", true);
        expect(Asked.calls).toEqual([["smile", { answer: true }]]);
        expect(globalStore.get(speech.speakingAtom)).toBe(true);
        expect(shownText(speech)).toBe("");
        clock.advance(300);
        const part = shownText(speech);
        expect(part.length).toBeGreaterThan(0);
        expect("Fine, thanks. The forge is warm and the coffee is hot.".startsWith(part)).toBe(true);
        clock.advance(RevealCapMs);
        expect(globalStore.get(speech.shownAtom)).toEqual(NothingShown);
        expect(shownText(speech)).toBe("Fine, thanks. The forge is warm and the coffee is hot.");
        expect(globalStore.get(speech.speakingAtom)).toBe(true);
        clock.advance(60000);
        expect(globalStore.get(speech.speakingAtom)).toBe(false);
        expect(clock.timers).toHaveLength(0);
    });

    it("never shows the marker, even cut in two readings", () => {
        read("[[conc");
        expect(shownText(speech)).toBe("");
        expect(Asked.calls).toEqual([]);
        read("[[concerned]] The checks of PR 12 came back red.");
        expect(Asked.calls).toEqual([["frown", { answer: true }]]);
        clock.advance(RevealCapMs);
        expect(shownText(speech)).toBe("The checks of PR 12 came back red.");
    });

    it("plays no gesture without a tone or with an unknown one, and still speaks", () => {
        read("[[furious]] Two agents run now.");
        expect(Asked.calls).toEqual([]);
        expect(globalStore.get(speech.speakingAtom)).toBe(true);
        expect(shownText(speech)).not.toContain("[[");
    });

    it("shows a long answer whole within the cap, and the rest at once on a click or a key", () => {
        const long = Array.from({ length: 300 }, () => "anvil").join(" ");
        read(long);
        clock.advance(500);
        expect(shownText(speech).length).toBeLessThan(long.length);
        target.fire("pointerdown");
        expect(shownText(speech)).toBe(long);
        expect(globalStore.get(speech.speakingAtom)).toBe(true);
        clock.advance(SpeakingSettleMs + 2500);
        expect(globalStore.get(speech.speakingAtom)).toBe(false);

        globalStore.set(exchangeAtom, (items: any[]) =>
            withAnswer(withMessage(items, "m2", "And now?", 1), "m2", { markdown: long, turn: 2, at: 2, final: true })
        );
        clock.advance(100);
        expect(shownText(speech).length).toBeLessThan(long.length);
        target.fire("keydown");
        expect(shownText(speech)).toBe(long);
    });

    it("shows it at once with reduced motion, and when reduced motion is turned on", () => {
        globalStore.set(reducedAtom, true);
        read("Fine, thanks. The forge is warm.");
        expect(shownText(speech)).toBe("Fine, thanks. The forge is warm.");
        globalStore.set(reducedAtom, false);
        read("Fine, thanks. The forge is warm. And more to say, much more.");
        expect(shownText(speech)).not.toBe("Fine, thanks. The forge is warm. And more to say, much more.");
        globalStore.set(reducedAtom, true);
        expect(shownText(speech)).toBe("Fine, thanks. The forge is warm. And more to say, much more.");
    });

    it("does not say again what was there before the group showed", () => {
        stop();
        Asked.calls = [];
        stop = speech.watch(target);
        expect(globalStore.get(speech.shownAtom)).toEqual(NothingShown);
        expect(globalStore.get(speech.speakingAtom)).toBe(false);
        read("[[smile]] An answer that came while the group was closed.");
        stop();
        read("[[smile]] An answer that came while the group was closed. More.");
        stop = speech.watch(target);
        expect(globalStore.get(speech.shownAtom)).toEqual(NothingShown);
        expect(Asked.calls).toEqual([["smile", { answer: true }]]);
    });

    it("stops listening to clicks and keys when the group goes", () => {
        stop();
        expect(target.listeners.get("keydown").size).toBe(0);
        expect(target.listeners.get("pointerdown").size).toBe(0);
        stop = speech.watch(target);
    });
});
