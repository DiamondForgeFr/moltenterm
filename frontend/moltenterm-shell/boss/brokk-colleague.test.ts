// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk as a kind colleague (FR-BOSS-009, AC71 to AC77, #2203). Every test moves a fake clock by hand: nothing here waits.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { flattenKeys, resolveKey, shippedDictionary } from "../i18n/i18n-core";
import {
    afterInput,
    afterPhrased,
    afterPresence,
    afterSeen,
    afterShown,
    allPhraseKeys,
    atLeast,
    BreakAfterMs,
    BreakLifeMs,
    ColleagueFacts,
    ColleagueMemory,
    currentMoment,
    dayKey,
    decodeMemory,
    DefaultProximity,
    EmptyColleague,
    encodeMemory,
    evaluate,
    eveningKey,
    helloCue,
    HelloCueFacts,
    helloDayKey,
    HelloLifeMs,
    helloPartOf,
    HelloParts,
    HelloPhrasings,
    LongAbsenceMs,
    MaxLineChars,
    modelPhrasingOn,
    Moment,
    MomentKind,
    momentLine,
    MomentPhrasings,
    momentsOn,
    momentStep,
    PauseMs,
    phraseKey,
    phraseSet,
    pickIndex,
    Proximities,
    Proximity,
    proximityOf,
    savedPresence,
    setSize,
    validModelLine,
} from "./brokk-colleague";

const Min = 60 * 1000;
const Hour = 60 * Min;

// Local times, so the rules that read the clock of the day hold in any time zone.
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute, 0).getTime();

function facts(now: number, partial: Partial<ColleagueFacts> = {}): ColleagueFacts {
    return { now, proximity: "colleague", working: 0, random: () => 0.5, ...partial };
}

function momentsOf(memory: ColleagueMemory, kind?: MomentKind): Moment[] {
    return memory.moments.filter((moment) => kind == null || moment.kind === kind);
}

// The developer is active from `from` to `to`, one input every `every`.
function work(memory: ColleagueMemory, from: number, to: number, every: number, partial: Partial<ColleagueFacts> = {}) {
    let next = memory;
    for (let now = from; now <= to; now += every) {
        next = afterInput(next, facts(now, partial));
    }
    return next;
}

describe("how near he stands (FR-BOSS-009, AC75)", () => {
    it("is a scale that grows, Colleague by default, and an unknown level reads as the default", () => {
        expect(Proximities).toEqual(["discreet", "colleague"]);
        expect(DefaultProximity).toBe("colleague");
        expect(proximityOf("discreet")).toBe("discreet");
        expect(proximityOf("colleague")).toBe("colleague");
        for (const unknown of [undefined, null, "", "close", "partner", 3, true]) {
            expect(proximityOf(unknown)).toBe("colleague");
        }
    });

    it("asks 'at least this close', so that a level added after Colleague keeps its moments and its model", () => {
        expect(atLeast("colleague", "discreet")).toBe(true);
        expect(atLeast("discreet", "colleague")).toBe(false);
        expect(momentsOn("discreet")).toBe(false);
        expect(modelPhrasingOn("discreet")).toBe(false);
        expect(momentsOn("colleague")).toBe(true);
        expect(modelPhrasingOn("colleague")).toBe(true);
    });
});

describe("the hello (FR-BOSS-009, AC72, AC-2)", () => {
    it("greets the first activity ever, once, in the phrasing set of the hour", () => {
        const memory = afterInput(EmptyColleague, facts(at(10, 8, 15)));
        const [hello] = momentsOf(memory, "hello");
        expect(hello).toMatchObject({ kind: "hello", set: "hello.morning", clock: "08:15" });
        // #2217: the day is greeted once the line was on screen, not when the hello is raised.
        expect(memory.helloDay).toBe("");
        expect(afterShown(memory, hello.id, at(10, 8, 16)).helloDay).toBe(dayKey(at(10, 8, 15)));
    });

    it("picks the set from the hour of that first activity: early, morning, late morning, back", () => {
        expect(HelloParts).toEqual(["early", "morning", "lateMorning", "back"]);
        const cases: [number, number, string][] = [
            [5, 0, "early"],
            [6, 59, "early"],
            [7, 0, "morning"],
            [9, 59, "morning"],
            [10, 0, "lateMorning"],
            [11, 59, "lateMorning"],
            [12, 0, "back"],
            [18, 30, "back"],
            [23, 59, "back"],
        ];
        for (const [hour, minute, part] of cases) {
            expect(helloPartOf(at(10, hour, minute)), `${hour}:${minute}`).toBe(part);
            const memory = afterInput(EmptyColleague, facts(at(10, hour, minute)));
            expect(momentsOf(memory, "hello")[0].set).toBe(`hello.${part}`);
        }
    });

    it("says hello once a day: more activity the same day greets nobody, even after a long pause", () => {
        let memory = afterInput(EmptyColleague, facts(at(10, 8, 0)));
        memory = afterSeen(memory, momentsOf(memory)[0].id);
        expect(memory.moments).toHaveLength(0);
        memory = afterInput(memory, facts(at(10, 8, 1)));
        memory = afterInput(memory, facts(at(10, 8, 1) + LongAbsenceMs + Min));
        expect(momentsOf(memory, "hello")).toHaveLength(0);
    });

    it("greets again on the next day, after the night", () => {
        let memory = afterInput(EmptyColleague, facts(at(10, 8, 0)));
        memory = afterSeen(memory, momentsOf(memory)[0].id);
        memory = afterInput(memory, facts(at(10, 18, 0)));
        memory = afterInput(memory, facts(at(11, 7, 30)));
        expect(momentsOf(memory, "hello")).toHaveLength(1);
        expect(momentsOf(memory, "hello")[0].set).toBe("hello.morning");
    });

    it("does not greet a developer who works past midnight: no pause of four hours, no new greeting", () => {
        let memory = afterInput(EmptyColleague, facts(at(10, 20, 0)));
        memory = afterSeen(memory, momentsOf(memory)[0].id);
        memory = work(memory, at(10, 20, 10), at(11, 1, 0), 10 * Min);
        expect(momentsOf(memory, "hello")).toHaveLength(0);
    });

    it("does not greet again when the window restarts the same day: the day greeted is kept across a restart", () => {
        const first = afterInput(EmptyColleague, facts(at(10, 8, 0)));
        const restarted = decodeMemory(encodeMemory(first));
        const again = afterInput(restarted, facts(at(10, 10, 0)));
        expect(momentsOf(again, "hello")).toHaveLength(0);
        const nextDay = afterInput(restarted, facts(at(11, 8, 0)));
        expect(momentsOf(nextDay, "hello")).toHaveLength(1);
    });

    // #2216 (audit #2214, T5): at one in the morning he said "You beat the sun to it".
    it("raises no hello between midnight and five: a late return is still the evening", () => {
        for (const [hour, minute] of [
            [0, 0],
            [0, 35],
            [4, 59],
        ]) {
            const memory = afterInput(EmptyColleague, facts(at(11, hour, minute)));
            expect(momentsOf(memory, "hello"), `${hour}:${minute}`).toHaveLength(0);
            expect(memory.helloDay).toBe("");
        }
        expect(helloDayKey(at(11, 0, 35))).toBe(dayKey(at(10, 12, 0)));
        expect(helloDayKey(at(11, 5, 0))).toBe(dayKey(at(11, 12, 0)));
    });

    // #2216 (audit #2214, C1, AC-1): a build restarted at 00:35 spent the day's hello on its first input, the computer
    // slept until morning, and the morning found the day already greeted.
    it("greets the morning after a restart at half past midnight and a night of sleep", () => {
        // The evening's work, the hello of that day already said.
        let memory = afterInput(EmptyColleague, facts(at(10, 9, 0)));
        memory = afterSeen(memory, momentsOf(memory)[0].id);
        memory = work(memory, at(10, 22, 0), at(11, 0, 34), 2 * Min);
        // The restart: only what the meta keeps comes back.
        memory = decodeMemory(encodeMemory(memory));
        memory = afterInput(memory, facts(at(11, 0, 35)));
        expect(momentsOf(memory, "hello")).toHaveLength(0);
        // The night, then the first input of the morning.
        memory = decodeMemory(encodeMemory(memory));
        memory = afterInput(memory, facts(at(11, 8, 58)));
        const [hello] = momentsOf(memory, "hello");
        expect(hello).toMatchObject({ set: "hello.morning", clock: "08:58" });
        expect(afterShown(memory, hello.id, at(11, 8, 59)).helloDay).toBe(dayKey(at(11, 8, 58)));
    });

    it("does not count a restart as an absence: the last presence is kept across it", () => {
        let memory = afterInput(EmptyColleague, facts(at(10, 9, 0)));
        memory = afterSeen(memory, momentsOf(memory)[0].id);
        memory = work(memory, at(10, 9, 0), at(10, 23, 0), 30 * Min);
        // A new day's key with the old rule, the same evening with the new one: no hello either way at 23:10.
        const restarted = decodeMemory(encodeMemory({ ...memory, helloDay: "" }));
        expect(restarted.presentAt).toBe(savedPresence(at(10, 23, 0)));
        const again = afterInput(restarted, facts(at(10, 23, 10)));
        expect(momentsOf(again, "hello")).toHaveLength(0);
    });

    // #2216 (AC-2): after a wake, the view that shows is often built anew, with no memory of the page.
    it("raises no hello by itself in a view rebuilt after a wake", () => {
        // A long night of work, the day of the 10th greeted, then a short sleep of the computer at 04:50.
        let memory = afterInput(EmptyColleague, facts(at(10, 18, 0)));
        memory = afterSeen(memory, momentsOf(memory)[0].id);
        memory = work(memory, at(10, 18, 0), at(11, 4, 50), 10 * Min);
        // The view on screen is built anew after the wake: it starts from the meta, with no input of its own.
        const rebuilt = decodeMemory(encodeMemory(memory));
        expect(rebuilt.lastInputAt).toBeNull();
        const first = afterInput(rebuilt, facts(at(11, 5, 10)));
        expect(momentsOf(first, "hello")).toHaveLength(0);
        // A real absence after it is still greeted.
        const morning = afterInput(first, facts(at(11, 9, 30)));
        expect(momentsOf(morning, "hello")).toHaveLength(1);
    });

    it("greets the morning after the night in a view rebuilt after the wake", () => {
        let memory = afterInput(EmptyColleague, facts(at(10, 18, 0)));
        memory = afterSeen(memory, momentsOf(memory)[0].id);
        const rebuilt = decodeMemory(encodeMemory(memory));
        expect(momentsOf(afterInput(rebuilt, facts(at(11, 8, 58))), "hello")).toHaveLength(1);
    });

    it("greets a return that only this computer's idle time saw, before any input in a view", () => {
        let memory = afterInput(EmptyColleague, facts(at(10, 18, 0)));
        memory = afterSeen(memory, momentsOf(memory)[0].id);
        // At the wake, the idle time is short: the developer is back, though no view had an input yet.
        memory = afterPresence(memory, at(11, 8, 58), facts(at(11, 8, 59)));
        expect(momentsOf(memory, "hello")).toHaveLength(1);
        expect(momentsOf(memory, "hello")[0].set).toBe("hello.morning");
        // A reading during the night (the idle time running since the evening) is no presence.
        let night = afterInput(EmptyColleague, facts(at(10, 18, 0)));
        night = afterSeen(night, momentsOf(night)[0].id);
        expect(afterPresence(night, at(10, 18, 0) - Min, facts(at(11, 3, 0)))).toBe(night);
    });

    it("takes input elsewhere on this computer as presence: no hello after a day spent in another application", () => {
        let memory = afterInput(EmptyColleague, facts(at(10, 9, 0)));
        memory = afterSeen(memory, momentsOf(memory)[0].id);
        for (let t = at(10, 9, 0); t <= at(10, 15, 0); t += 30 * Min) {
            memory = afterPresence(memory, t, facts(t));
        }
        expect(momentsOf(afterInput(memory, facts(at(10, 15, 1))), "hello")).toHaveLength(0);
    });

    it("saves the presence to the minute", () => {
        expect(savedPresence(at(10, 9, 0) + 59 * 1000)).toBe(at(10, 9, 0));
        expect(savedPresence(null)).toBeNull();
        expect(decodeMemory(JSON.stringify({ presentAt: "yesterday" })).presentAt).toBeNull();
        expect(decodeMemory(JSON.stringify({ presentAt: -3 })).presentAt).toBeNull();
    });

    // #2217 (AC-3): a hello never shown (the window hidden, quiet hours) leaves the day ungreeted and waits for its chance.
    it("waits, never shown, for the rest of its day, and leaves the day ungreeted meanwhile", () => {
        const memory = afterInput(EmptyColleague, facts(at(10, 8, 0)));
        const later = evaluate(memory, facts(at(10, 16, 0)));
        expect(momentsOf(later, "hello")).toHaveLength(1);
        expect(later.helloDay).toBe("");
        expect(momentsOf(evaluate(memory, facts(at(11, 4, 59))), "hello")).toHaveLength(1);
        const nextDay = evaluate(memory, facts(at(11, 5, 0)));
        expect(momentsOf(nextDay, "hello")).toHaveLength(0);
        expect(nextDay.helloDay).toBe("");
    });

    it("lapses an hour after it was shown, when nobody closed the group on it", () => {
        let memory = afterInput(EmptyColleague, facts(at(10, 8, 0)));
        memory = afterShown(memory, momentsOf(memory)[0].id, at(10, 8, 30));
        expect(momentsOf(evaluate(memory, facts(at(10, 8, 30) + HelloLifeMs - 1)), "hello")).toHaveLength(1);
        expect(momentsOf(evaluate(memory, facts(at(10, 8, 30) + HelloLifeMs)), "hello")).toHaveLength(0);
    });

    it("goes when another window has greeted its day", () => {
        const memory = afterInput(EmptyColleague, facts(at(10, 8, 0)));
        const elsewhere = { ...memory, helloDay: dayKey(at(10, 8, 0)) };
        expect(momentsOf(evaluate(elsewhere, facts(at(10, 8, 1))), "hello")).toHaveLength(0);
    });

    it("takes the written set of the part of the day it shows in", () => {
        let memory = afterInput(EmptyColleague, facts(at(10, 6, 30)));
        const hello = momentsOf(memory, "hello")[0];
        expect(hello.set).toBe("hello.early");
        memory = afterPhrased(memory, hello.id, "Up with the larks today, are we.");
        memory = afterShown(memory, hello.id, at(10, 8, 5));
        const shown = momentsOf(memory, "hello")[0];
        expect(shown).toMatchObject({ set: "hello.morning", index: hello.index });
        expect(shown.line).toBeUndefined();
        expect(momentLine(shown)).toEqual({ key: phraseKey("hello.morning", hello.index) });
        // Shown in the part it was raised in, it keeps his model's line.
        let same = afterInput(EmptyColleague, facts(at(10, 8, 0)));
        const id = momentsOf(same, "hello")[0].id;
        same = afterShown(afterPhrased(same, id, "The fire is lit, tools are out."), id, at(10, 8, 10));
        expect(momentLine(momentsOf(same, "hello")[0])).toEqual({ text: "The fire is lit, tools are out." });
    });
});

describe("the hello shows itself on the folded avatar (FR-BOSS-009, AC74, #2217)", () => {
    const hello = () => momentsOf(afterInput(EmptyColleague, facts(at(10, 8, 0))), "hello");
    const free: HelloCueFacts = { visible: true, quiet: false, groupOpen: false, sceneUp: false };

    it("shows the hello waiting when the avatar can be seen, outside quiet hours, with the group closed", () => {
        const moments = hello();
        expect(helloCue(moments, free)).toBe(moments[0]);
    });

    it("never while it cannot be seen, in quiet hours, with the group open or a scene in his place", () => {
        const moments = hello();
        for (const blocked of [
            { visible: false },
            { quiet: true },
            { groupOpen: true },
            { sceneUp: true },
        ] as Partial<HelloCueFacts>[]) {
            expect(helloCue(moments, { ...free, ...blocked }), JSON.stringify(blocked)).toBeNull();
        }
    });

    it("shows only a hello, and only one never shown", () => {
        let memory = work(EmptyColleague, at(10, 9, 0), at(10, 11, 5), 5 * Min);
        memory = afterSeen(memory, momentsOf(memory, "hello")[0].id);
        expect(momentsOf(memory, "break")).toHaveLength(1);
        expect(helloCue(memory.moments, free)).toBeNull();
        const raised = afterInput(EmptyColleague, facts(at(10, 8, 0)));
        const shown = afterShown(raised, raised.moments[0].id, at(10, 8, 1));
        expect(helloCue(shown.moments, free)).toBeNull();
    });
});

describe("the break nudge (FR-BOSS-009, AC72, AC-3)", () => {
    const start = at(10, 9, 0);

    it("comes after two hours of continuous activity, once, and not before", () => {
        let memory = work(EmptyColleague, start, start + BreakAfterMs - Min, 5 * Min);
        expect(momentsOf(memory, "break")).toHaveLength(0);
        memory = afterInput(memory, facts(start + BreakAfterMs));
        const [nudge] = momentsOf(memory, "break");
        expect(nudge).toMatchObject({ kind: "break", set: "break", workedMin: 120 });
        // The hello of nine o'clock was never shown: it still waits for its chance, beside the nudge (#2217).
        expect(memory.moments.map((moment) => moment.kind)).toEqual(["hello", "break"]);
    });

    it("does not come back for the same stretch, even after it was seen", () => {
        let memory = work(EmptyColleague, start, start + BreakAfterMs, 5 * Min);
        memory = afterSeen(memory, momentsOf(memory, "break")[0].id);
        memory = work(memory, start + BreakAfterMs + 5 * Min, start + 5 * Hour, 5 * Min);
        expect(momentsOf(memory, "break")).toHaveLength(0);
    });

    it("counts a pause of fifteen minutes or more as a real one: the stretch starts again", () => {
        // 1 h 50 of work, a 15 min pause, then 1 h 50 more: never two hours in a row.
        let memory = work(EmptyColleague, start, start + 110 * Min, 5 * Min);
        memory = work(memory, start + 110 * Min + PauseMs, start + 220 * Min + PauseMs, 5 * Min);
        expect(momentsOf(memory, "break")).toHaveLength(0);
    });

    it("counts fourteen minutes as no pause", () => {
        let memory = work(EmptyColleague, start, start + 60 * Min, 5 * Min);
        memory = work(memory, start + 60 * Min + PauseMs - Min, start + BreakAfterMs + 5 * Min, 5 * Min);
        expect(momentsOf(memory, "break")).toHaveLength(1);
    });

    it("is quiet again after a real pause, and comes once more after another two hours", () => {
        let memory = work(EmptyColleague, start, start + BreakAfterMs, 5 * Min);
        const first = momentsOf(memory, "break")[0];
        memory = afterSeen(memory, first.id);
        const back = start + BreakAfterMs + 30 * Min;
        memory = work(memory, back, back + BreakAfterMs, 5 * Min);
        const second = momentsOf(memory, "break");
        expect(second).toHaveLength(1);
        expect(second[0].id).not.toBe(first.id);
    });

    it("lapses at the first real pause, and after 45 minutes unseen", () => {
        const memory = work(EmptyColleague, start, start + BreakAfterMs, 5 * Min);
        const nudgedAt = start + BreakAfterMs;
        expect(momentsOf(evaluate(memory, facts(nudgedAt + 10 * Min)), "break")).toHaveLength(1);
        expect(momentsOf(evaluate(memory, facts(nudgedAt + PauseMs)), "break")).toHaveLength(0);
        const keepGoing = work(memory, nudgedAt + 5 * Min, nudgedAt + BreakLifeMs, 5 * Min);
        expect(momentsOf(keepGoing, "break")).toHaveLength(0);
    });

    it("is not raised by the clock alone when nobody has been active", () => {
        const memory = work(EmptyColleague, start, start + 100 * Min, 5 * Min);
        expect(momentsOf(evaluate(memory, facts(start + BreakAfterMs + 30 * Min)), "break")).toHaveLength(0);
    });

    it("is raised by the clock while the developer stays active, with no new input needed in the same instant", () => {
        const memory = work(EmptyColleague, start, start + BreakAfterMs - Min, Min);
        expect(momentsOf(memory, "break")).toHaveLength(0);
        // The last input was a minute ago: the stretch reached its length, the tick tells it.
        expect(momentsOf(evaluate(memory, facts(start + BreakAfterMs)), "break")).toHaveLength(1);
    });
});

describe("the evening hand-over (FR-BOSS-009, AC72, AC-4)", () => {
    it("shows from 21:00, only with agents at work and the developer active, and says nothing before", () => {
        const before = afterInput(EmptyColleague, facts(at(10, 20, 59), { working: 2 }));
        expect(momentsOf(before, "handover")).toHaveLength(0);
        const evening = afterInput(EmptyColleague, facts(at(10, 21, 0), { working: 2 }));
        expect(momentsOf(evening, "handover")).toHaveLength(1);
        expect(momentsOf(evening, "handover")[0]).toMatchObject({ set: "handover", agents: 2, clock: "21:00" });
    });

    it("does not show without agents at work: nothing is true to say", () => {
        const memory = afterInput(EmptyColleague, facts(at(10, 22, 30), { working: 0 }));
        expect(momentsOf(memory, "handover")).toHaveLength(0);
        expect(momentsOf(evaluate(memory, facts(at(10, 22, 31), { working: 0 })), "handover")).toHaveLength(0);
    });

    it("does not show to a developer who is not there, and shows when one comes", () => {
        const away = evaluate(EmptyColleague, facts(at(10, 22, 0), { working: 3 }));
        expect(momentsOf(away, "handover")).toHaveLength(0);
        const back = afterInput(away, facts(at(10, 22, 5), { working: 3 }));
        expect(momentsOf(back, "handover")).toHaveLength(1);
    });

    it("is raised once an evening, one o'clock in the morning being the evening that began the day before", () => {
        let memory = afterInput(EmptyColleague, facts(at(10, 21, 30), { working: 1 }));
        memory = afterSeen(memory, momentsOf(memory, "handover")[0].id);
        memory = afterInput(memory, facts(at(10, 23, 0), { working: 1 }));
        memory = afterInput(memory, facts(at(11, 1, 0), { working: 1 }));
        expect(momentsOf(memory, "handover")).toHaveLength(0);
        expect(eveningKey(at(11, 1, 0))).toBe(eveningKey(at(10, 22, 0)));
        const nextEvening = afterInput(memory, facts(at(11, 21, 15), { working: 1 }));
        expect(momentsOf(nextEvening, "handover")).toHaveLength(1);
    });

    it("lapses the moment the agents have finished, and at five in the morning", () => {
        const memory = afterInput(EmptyColleague, facts(at(10, 21, 30), { working: 2 }));
        expect(momentsOf(evaluate(memory, facts(at(10, 21, 40), { working: 2 })), "handover")).toHaveLength(1);
        expect(momentsOf(evaluate(memory, facts(at(10, 21, 40), { working: 0 })), "handover")).toHaveLength(0);
        expect(momentsOf(evaluate(memory, facts(at(11, 5, 0), { working: 2 })), "handover")).toHaveLength(0);
    });

    it("says nothing of night work, a queue, a message or a wake-up: it promises only what MoltenTerm does", () => {
        const promises: Record<string, RegExp> = {
            en: /\b(tonight|overnight|night shift|night work|wake you|text you|email you|send you|report to you|I will (call|message|tell you))\b/i,
            fr: /(cette nuit|toute la nuit|de nuit|vous réveill|vous enverrai|vous écrirai|vous appellerai|vous préviendrai|rapport)/i,
        };
        for (const code of ["en", "fr"]) {
            const dict = shippedDictionary(code);
            for (let i = 0; i < MomentPhrasings; i++) {
                const text = resolveKey(dict, phraseKey("handover", i));
                expect(text, `${code} handover p${i + 1}`).not.toMatch(promises[code]);
            }
        }
    });
});

describe("the order of the moments and what the group does with them (FR-BOSS-009, AC72)", () => {
    function moment(kind: MomentKind): Moment {
        return { id: `${kind}:1`, kind, set: phraseSet(kind, "morning"), index: 0, raisedAt: 1, clock: "08:00" };
    }

    it("shows the hello first, then the break, then the evening", () => {
        expect(currentMoment([moment("handover"), moment("break"), moment("hello")]).kind).toBe("hello");
        expect(currentMoment([moment("handover"), moment("break")]).kind).toBe("break");
        expect(currentMoment([moment("handover")]).kind).toBe("handover");
        expect(currentMoment([])).toBeNull();
    });

    it("takes the moment as the group shows, keeps it as it was, and forgets it once the group closed on it", () => {
        const hello = moment("hello");
        const opening = momentStep(null, hello, true);
        expect(opening).toEqual({ kept: hello, shown: hello.id, seen: null });
        const staying = momentStep(hello, { ...hello, line: "changed" }, true);
        expect(staying).toEqual({ kept: hello, shown: null, seen: null });
        const closing = momentStep(hello, null, false);
        expect(closing).toEqual({ kept: hello, shown: null, seen: hello.id });
    });

    it("has nothing to take or forget when there is no moment", () => {
        expect(momentStep(null, null, true)).toEqual({ kept: null, shown: null, seen: null });
        expect(momentStep(null, null, false)).toEqual({ kept: null, shown: null, seen: null });
        expect(momentStep(null, moment("break"), false)).toEqual({ kept: null, shown: null, seen: null });
    });

    it("shows a moment once: after the group closed on it, it is gone", () => {
        let memory = afterInput(EmptyColleague, facts(at(10, 8, 0)));
        const hello = currentMoment(memory.moments);
        memory = afterShown(memory, hello.id, at(10, 8, 1));
        expect(currentMoment(memory.moments)).not.toBeNull();
        memory = afterSeen(memory, hello.id);
        expect(currentMoment(memory.moments)).toBeNull();
        expect(afterSeen(memory, hello.id)).toBe(memory);
    });
});

describe("never a loop (FR-BOSS-009, AC73, AC-5)", () => {
    it("picks any phrasing of the set but the previous one, whatever the random source says", () => {
        for (const size of [2, 5, 20]) {
            for (let last = 0; last < size; last++) {
                const seen = new Set<number>();
                for (let r = 0; r < 1; r += 0.01) {
                    const index = pickIndex(size, last, () => r);
                    expect(index).not.toBe(last);
                    expect(index).toBeGreaterThanOrEqual(0);
                    expect(index).toBeLessThan(size);
                    seen.add(index);
                }
                expect(seen.size, `size ${size}, last ${last}`).toBe(size - 1);
            }
        }
    });

    it("picks within the set when none was shown yet, or when the memory is out of range", () => {
        for (const last of [undefined, null, -1, 20, 3.5, NaN]) {
            const index = pickIndex(20, last as number, () => 0.999999);
            expect(index).toBeGreaterThanOrEqual(0);
            expect(index).toBeLessThan(20);
        }
        expect(pickIndex(1, 0, () => 0.3)).toBe(0);
    });

    it("never shows the same break phrasing twice in a row over many nudges, with the worst random source", () => {
        // A source stuck on the same value is the worst case: it would pick the same phrasing each time.
        let memory: ColleagueMemory = EmptyColleague;
        let previous = -1;
        for (let day = 1; day <= 40; day++) {
            const start = at(1, 9, 0) + day * 2 * 24 * Hour;
            memory = work(memory, start, start + BreakAfterMs, 5 * Min, { random: () => 0 });
            const [nudge] = momentsOf(memory, "break");
            expect(nudge.index).not.toBe(previous);
            previous = nudge.index;
            memory = afterSeen(memory, nudge.id);
        }
    });

    it("keeps the last phrasing of each set across a restart", () => {
        const memory = work(EmptyColleague, at(10, 9, 0), at(10, 11, 0), 5 * Min, { random: () => 0.5 });
        const shown = momentsOf(memory, "break")[0].index;
        const restarted = decodeMemory(encodeMemory(memory));
        expect(restarted.last["break"]).toBe(shown);
        const again = work(restarted, at(11, 9, 0), at(11, 11, 0), 5 * Min, { random: () => 0.5 });
        expect(momentsOf(again, "break")[0].index).not.toBe(shown);
    });

    it("tracks the last phrasing per set, so the hello of another time of day is not held back by it", () => {
        const morning = afterInput(EmptyColleague, facts(at(10, 8, 0), { random: () => 0 }));
        const next = afterInput(morning, facts(at(11, 15, 0), { random: () => 0 }));
        expect(momentsOf(next, "hello").map((m) => m.set)).toEqual(["hello.back"]);
        expect(next.last["hello.morning"]).toBe(0);
        expect(next.last["hello.back"]).toBe(0);
    });
});

describe("Discreet means no moment (FR-BOSS-009, AC75, AC-7)", () => {
    it("raises no hello, no break and no hand-over, and keeps the greeting for when he comes closer", () => {
        let memory = afterInput(EmptyColleague, facts(at(10, 8, 0), { proximity: "discreet" }));
        memory = work(memory, at(10, 8, 5), at(10, 22, 0), 5 * Min, { proximity: "discreet", working: 2 });
        expect(memory.moments).toHaveLength(0);
        expect(memory.helloDay).toBe("");
    });

    it("drops the moments that wait when the developer chooses Discreet", () => {
        const memory = afterInput(EmptyColleague, facts(at(10, 8, 0)));
        expect(memory.moments).toHaveLength(1);
        const discreet: Proximity = "discreet";
        expect(evaluate(memory, facts(at(10, 8, 1), { proximity: discreet })).moments).toHaveLength(0);
    });
});

describe("his model's line (FR-BOSS-009, AC77)", () => {
    const raised = afterInput(EmptyColleague, facts(at(10, 8, 0)));
    const hello = raised.moments[0];

    it("replaces the written phrasing only when it arrives before the moment is shown", () => {
        const early = afterPhrased(raised, hello.id, "Morning, the forge is lit.");
        expect(momentLine(early.moments[0])).toEqual({ text: "Morning, the forge is lit." });
        const shown = afterShown(raised, hello.id, at(10, 8, 1));
        const late = afterPhrased(shown, hello.id, "Too late to change.");
        expect(late).toBe(shown);
        expect(momentLine(late.moments[0])).toEqual({ key: phraseKey(hello.set, hello.index) });
    });

    it("ignores a line for a moment that is gone or an empty line", () => {
        expect(afterPhrased(raised, "break:1", "Rest a bit.")).toBe(raised);
        expect(afterPhrased(raised, hello.id, "")).toBe(raised);
        expect(afterPhrased(raised, hello.id, null)).toBe(raised);
    });

    it("keeps one line, short, with no markdown, link or digit; anything else is discarded", () => {
        const good = [
            "Morning. Fire is lit, tools are out.",
            "  Bonne journée, on tape sur le fer.  ",
            "Take five, the iron can cool.",
        ];
        for (const text of good) {
            expect(validModelLine(text), text).toBe(text.trim());
        }
        const quoted = validModelLine('"Time for a break, colleague."');
        expect(quoted).toBe("Time for a break, colleague.");
        const bad: unknown[] = [
            null,
            undefined,
            42,
            "",
            "short",
            "Two lines.\nOf text.",
            "x".repeat(MaxLineChars + 1),
            "**Take a break** now please",
            "Take a `break` now, please",
            "# A heading for a break",
            "- a list item that is long enough",
            "See [the docs](https://example.com) now",
            "Go to https://example.com for a break",
            "Visit www.example.org for a rest",
            "Mail me at brokk@example.com please",
            "Pause de 2 heures, c'est assez",
            "<b>Rest</b> a little please",
            "Rest a little\u0007 please now",
        ];
        for (const text of bad) {
            expect(validModelLine(text), String(text)).toBeNull();
        }
    });

    it("accepts a line at the cap and refuses one character more", () => {
        expect(validModelLine("a".repeat(MaxLineChars))).toHaveLength(MaxLineChars);
        expect(validModelLine("a".repeat(MaxLineChars + 1))).toBeNull();
    });
});

describe("what is kept across restarts (FR-BOSS-009, AC72)", () => {
    it("round-trips the day greeted, the last phrasings and the evening", () => {
        const memory: ColleagueMemory = {
            ...EmptyColleague,
            helloDay: "2026-11-10",
            last: { break: 4, "hello.morning": 2 },
            handoverEvening: "2026-11-09",
        };
        expect(decodeMemory(encodeMemory(memory))).toEqual(memory);
    });

    // #2221: how many times his model was asked is kept where the call is made (wavesrv), not in this text.
    it("keeps no count of his model's calls, and ignores the one an older text carried", () => {
        const saved = JSON.parse(encodeMemory({ ...EmptyColleague, helloDay: "2026-11-10" }));
        expect(saved).not.toHaveProperty("modelCalls");
        expect(saved).not.toHaveProperty("modelDay");
        const restored = decodeMemory('{"helloDay":"2026-11-10","modelDay":"2026-11-10","modelCalls":4}');
        expect(restored.helloDay).toBe("2026-11-10");
        expect(restored).not.toHaveProperty("modelCalls");
    });

    it("keeps no moment, no stretch and no activity of the page: those are a run's; the last presence is kept", () => {
        const memory = work(EmptyColleague, at(10, 9, 0), at(10, 11, 0), 5 * Min);
        const saved = JSON.parse(encodeMemory(memory));
        expect(Object.keys(saved).sort()).toEqual(["handoverEvening", "helloDay", "last", "presentAt"]);
        const restored = decodeMemory(encodeMemory(memory));
        expect(restored.moments).toEqual([]);
        expect(restored.lastInputAt).toBeNull();
    });

    it("reads anything unreadable as nothing kept", () => {
        for (const text of [
            "",
            "not json",
            "null",
            "[]",
            "42",
            '{"helloDay":7,"last":{"break":-1,"x":"y"},"modelCalls":-4}',
        ]) {
            const restored = decodeMemory(text);
            expect(restored.helloDay).toBe("");
            expect(restored.last).toEqual({});
            expect(restored.moments).toEqual([]);
        }
    });
});

describe("the phrasings, in both languages (FR-BOSS-009, AC73, AC78, AC-5, AC-6)", () => {
    const keys = allPhraseKeys();

    it("are about twenty for the break and the evening, five for each time of the hello", () => {
        expect(MomentPhrasings).toBe(20);
        expect(HelloPhrasings).toBe(5);
        expect(setSize("break")).toBe(20);
        expect(setSize("handover")).toBe(20);
        for (const part of HelloParts) {
            expect(setSize(phraseSet("hello", part))).toBe(5);
        }
        expect(keys).toHaveLength(20 + 20 + 4 * 5);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it("exist in en.json and fr.json, with no more in either, and no placeholder", () => {
        for (const code of ["en", "fr"]) {
            const dict = shippedDictionary(code);
            for (const key of keys) {
                const text = resolveKey(dict, key);
                expect(text, `${code} ${key}`).toMatch(/\S/);
                expect(text, `${code} ${key}`).not.toMatch(/[{}]/);
            }
            const present = flattenKeys(dict).filter((key) => key.startsWith("boss.moment."));
            expect(present.sort(), code).toEqual([...keys].sort());
        }
    });

    it("are one short line each, all different, with no number, no ticket and no link", () => {
        for (const code of ["en", "fr"]) {
            const dict = shippedDictionary(code);
            const texts = keys.map((key) => resolveKey(dict, key));
            expect(new Set(texts).size, code).toBe(texts.length);
            for (const text of texts) {
                expect(text, text).not.toMatch(/\n/);
                expect(text.length, text).toBeLessThanOrEqual(MaxLineChars + 10);
                expect(text, text).not.toMatch(/\d|#|https?:|www\./);
            }
        }
    });

    it("are each different from the others of their set in their opening words, not one sentence said twenty ways", () => {
        for (const code of ["en", "fr"]) {
            const dict = shippedDictionary(code);
            for (const set of [phraseSet("break"), phraseSet("handover")]) {
                const firstWords = Array.from({ length: MomentPhrasings }, (_, i) =>
                    resolveKey(dict, phraseKey(set, i)).split(/\s+/).slice(0, 3).join(" ").toLowerCase()
                );
                expect(new Set(firstWords).size, `${code} ${set}`).toBeGreaterThanOrEqual(MomentPhrasings - 2);
            }
        }
    });

    it("name no one: no notification, no ticket, no pull request, no file and no agent's name", () => {
        const echoes = /notification count|pull request|ticket|\bPR\b|\.go\b|\.ts\b|merged|fusionn/i;
        for (const code of ["en", "fr"]) {
            const dict = shippedDictionary(code);
            for (const key of keys) {
                const text = resolveKey(dict, key);
                expect(text, `${code} ${key}`).not.toMatch(echoes);
            }
        }
    });
});

describe("a moment never reaches the hub, a visit, a gesture or the badge (FR-BOSS-009, AC74)", () => {
    it("is made of modules that know none of them", () => {
        for (const file of ["brokk-colleague.ts", "brokk-colleague-store.ts", "use-brokk-moment.ts"]) {
            const code = readFileSync(join(__dirname, file), "utf8").replace(/\/\/.*$/gm, "");
            for (const specifier of [...code.matchAll(/from "([^"]+)"/g)].map((m) => m[1])) {
                expect(specifier, `${file} imports ${specifier}`).not.toMatch(
                    /brokk-hub|brokk-visit|brokk-gate|brokk-queue|brokk-expressions|brokk-edge|boss-portrait|brokk-live|brokk-portrait|boss-store/
                );
            }
            expect(code, file).not.toMatch(/openCard|showPanel|hub\.|Expressions/);
        }
    });
});
