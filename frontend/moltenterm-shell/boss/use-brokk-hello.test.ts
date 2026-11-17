// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The hello shows itself once, with a nod and a bubble (FR-BOSS-009, AC74, #2217). The showing runs on the colleague's
// real rules (brokk-colleague.ts) and a clock moved by hand: nothing here waits.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    afterInput,
    afterSeen,
    afterShown,
    ColleagueMemory,
    dayKey,
    EmptyColleague,
    evaluate,
    helloCue,
    HelloCueFacts,
    momentLine,
} from "./brokk-colleague";
import { helloBubblePlace, HelloGapPx } from "./brokk-hello-bubble";
import { HelloBubble, HelloBubbleMs, HelloShow } from "./use-brokk-hello";

const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute, 0).getTime();
const facts = (now: number) => ({ now, proximity: "colleague" as const, working: 0, random: () => 0.5 });
const Free: HelloCueFacts = { visible: true, quiet: false, groupOpen: false, sceneUp: false };

// The colleague's memory, the avatar's showing of it, and what reached the screen.
function rig(start: number, motion = true) {
    const state = { now: start, memory: afterInput(EmptyColleague, facts(start)) as ColleagueMemory };
    const timers: { at: number; run: () => void }[] = [];
    const seen = { nods: 0, bubbles: [] as HelloBubble[] };
    const show = new HelloShow({
        shown: (id) => {
            state.memory = afterShown(state.memory, id, state.now);
            return state.memory.moments.find((moment) => moment.id === id) ?? null;
        },
        seen: (id) => {
            state.memory = afterSeen(state.memory, id);
        },
        nod: () => seen.nods++,
        motion: () => motion,
        text: (moment) => momentLine(moment).text ?? momentLine(moment).key,
        onBubble: (bubble) => seen.bubbles.push(bubble),
        setTimer: (run, ms) => {
            const timer = { at: state.now + ms, run };
            timers.push(timer);
            return timer;
        },
        clearTimer: (timer) => {
            const i = timers.indexOf(timer as (typeof timers)[number]);
            if (i >= 0) {
                timers.splice(i, 1);
            }
        },
    });
    const update = (cueFacts: Partial<HelloCueFacts> = {}) => {
        const f = { ...Free, ...cueFacts };
        show.update(helloCue(state.memory.moments, f), f.groupOpen || f.sceneUp || !f.visible);
    };
    const advance = (ms: number) => {
        state.now += ms;
        for (const timer of timers.filter((t) => t.at <= state.now)) {
            timers.splice(timers.indexOf(timer), 1);
            timer.run();
        }
        state.memory = evaluate(state.memory, facts(state.now));
    };
    return { state, show, seen, update, advance };
}

describe("the first hello of the day shows itself (AC-1)", () => {
    it("nods and shows its line beside the folded avatar, once, for a few seconds", () => {
        const r = rig(at(11, 8, 58));
        r.update();
        expect(r.seen.nods).toBe(1);
        expect(r.seen.bubbles).toHaveLength(1);
        expect(r.seen.bubbles[0].text).toMatch(/^boss\.moment\.hello\.morning\.p\d$/);
        // Every redraw of the avatar while the bubble is up asks nothing more.
        r.update();
        r.advance(HelloBubbleMs - 1);
        r.update();
        expect(r.seen.nods).toBe(1);
        expect(r.seen.bubbles).toHaveLength(1);
        r.advance(1);
        expect(r.seen.bubbles).toEqual([r.seen.bubbles[0], null]);
        expect(r.state.memory.moments).toHaveLength(0);
        // The rest of the day he does not greet again, even after a long absence.
        r.advance(5 * 60 * 60 * 1000);
        r.state.memory = afterInput(r.state.memory, facts(r.state.now));
        r.update();
        expect(r.seen.nods).toBe(1);
        expect(r.seen.bubbles).toHaveLength(2);
    });

    it("greets the day once its line is on screen, not before", () => {
        const r = rig(at(11, 8, 58));
        expect(r.state.memory.helloDay).toBe("");
        r.update();
        expect(r.state.memory.helloDay).toBe(dayKey(at(11, 8, 58)));
    });

    it("keeps the bubble and drops the nod under reduced motion", () => {
        const r = rig(at(11, 8, 58), false);
        r.update();
        expect(r.seen.nods).toBe(0);
        expect(r.seen.bubbles).toHaveLength(1);
    });

    it("ends the bubble when the group opens on it: the line was seen", () => {
        const r = rig(at(11, 8, 58));
        r.update();
        r.update({ groupOpen: true });
        expect(r.seen.bubbles.at(-1)).toBeNull();
        expect(r.state.memory.moments).toHaveLength(0);
        expect(r.state.memory.helloDay).toBe(dayKey(at(11, 8, 58)));
    });

    it("counts as shown when the face leaves the page with the bubble up", () => {
        const r = rig(at(11, 8, 58));
        r.update();
        r.show.end();
        expect(r.state.memory.moments).toHaveLength(0);
    });
});

describe("a hello never shown leaves the day ungreeted (AC-3)", () => {
    it("waits while the window is hidden or in quiet hours, and shows once it can", () => {
        const r = rig(at(11, 7, 30));
        r.update({ visible: false });
        r.update({ quiet: true });
        r.update({ sceneUp: true });
        r.update({ groupOpen: false, visible: false });
        expect(r.seen.bubbles).toHaveLength(0);
        expect(r.seen.nods).toBe(0);
        expect(r.state.memory.helloDay).toBe("");
        // Quiet hours end at eight: the hello is still there, in the morning's words.
        r.advance(31 * 60 * 1000);
        r.update();
        expect(r.seen.bubbles).toHaveLength(1);
        expect(r.state.memory.helloDay).toBe(dayKey(at(11, 8, 1)));
    });

    it("never shows on the collapsed strip, which is out of sight at rest", () => {
        const source = readFileSync(join(__dirname, "brokk-avatar.tsx"), "utf8");
        expect(source).toContain('useBrokkHello(faceVisible && variant !== "edge", sceneUp)');
    });
});

describe("no unfold, no badge (AC-2)", () => {
    it("asks nothing of the group, the strip, the badge or a visit", () => {
        const source = readFileSync(join(__dirname, "use-brokk-hello.ts"), "utf8").replace(/\/\/.*$/gm, "");
        for (const opener of [
            "openCard",
            "pinCard",
            "hub.open",
            "BrokkEdgeModel",
            "peek",
            "badgeAtom",
            "cueAtom",
            "visit",
            "toast",
            "notify",
        ]) {
            expect(source, opener).not.toContain(opener);
        }
    });

    it("takes no pointer and no focus: it is drawn over the page, beside the avatar", () => {
        const css = readFileSync(join(__dirname, "brokk-hello-bubble.css"), "utf8");
        expect(css).toMatch(/\.mt-brokk-hello\s*\{[^}]*pointer-events:\s*none/);
        const view = readFileSync(join(__dirname, "brokk-hello-bubble.tsx"), "utf8");
        expect(view).toContain('role="status"');
        expect(view).not.toMatch(/tabIndex|autoFocus|\.focus\(/);
    });

    it("stands under the avatar: on its left edge in the sidebar, on its right edge when it hangs at the window's right", () => {
        const rect = { left: 200, right: 226, bottom: 40 };
        expect(helloBubblePlace(rect, "row", 1200)).toEqual({ top: 40 + HelloGapPx, left: 200 });
        expect(helloBubblePlace(rect, "hanging", 1200)).toEqual({ top: 40 + HelloGapPx, right: 1200 - 226 });
    });
});
