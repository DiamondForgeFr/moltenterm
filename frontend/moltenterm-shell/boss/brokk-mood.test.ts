// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
    BackMs,
    DefaultQuietHours,
    dueWaits,
    EmptyMood,
    ImpatientAfterMs,
    inQuietHours,
    isNight,
    minutesOfDay,
    moodAfter,
    MoodEvent,
    MoodFacts,
    MoodMemory,
    moodOf,
    nextClockTime,
    nextNightChange,
    nextQuietChange,
    parseClock,
    ReliefMs,
    ReplayEveryMs,
    replayOf,
    SatisfiedMentionMs,
    SatisfiedMs,
} from "./brokk-mood";

const Min = 60_000;
// Ten in the morning, local time: not the night.
const Day = new Date(2026, 10, 6, 10, 0, 0).getTime();

function at(hour: number, minute = 0): number {
    return new Date(2026, 10, 6, hour, minute, 0).getTime();
}

function after(events: [MoodEvent, number][], memory: MoodMemory = EmptyMood): MoodMemory {
    return events.reduce((current, [event, now]) => moodAfter(current, event, now), memory);
}

function facts(partial: Partial<MoodFacts> = {}): MoodFacts {
    return { failing: false, waiting: 0, oldest: null, ...partial };
}

const Waiter = (since: number, key = "agent:a") => ({ key, name: "Olivia", since, agent: true });

describe("the moods Brokk feels (FR-BOSS-007, AC12)", () => {
    describe("concerned, then relieved", () => {
        it("is concerned for as long as something fails, with no decline", () => {
            for (const elapsed of [0, 5 * Min, 90 * Min, 600 * Min]) {
                expect(moodOf(EmptyMood, facts({ failing: true, waiting: 1 }), Day + elapsed).mood).toBe("concerned");
            }
        });

        it("is relieved for a minute once the failure is settled, and not before it is", () => {
            const settled = after([[{ type: "settled" }, Day]]);
            expect(moodOf(settled, facts(), Day + ReliefMs - 1).relieved).toBe(true);
            expect(moodOf(settled, facts(), Day + ReliefMs).relieved).toBe(false);
            expect(moodOf(settled, facts({ failing: true, waiting: 1 }), Day + 1000).relieved).toBe(false);
        });

        it("loses the relief and the good mood to a new failure", () => {
            const memory = after([
                [{ type: "cleared" }, Day],
                [{ type: "settled" }, Day],
                [{ type: "failed" }, Day + 1000],
            ]);
            expect(memory.satisfiedAt).toBeNull();
            expect(memory.reliefAt).toBeNull();
            expect(moodAfter(EmptyMood, { type: "failed" }, Day)).toBe(EmptyMood);
        });
    });

    describe("impatient", () => {
        it("is impatient from the tenth minute of the longest wait, and says how long", () => {
            const since = Day - 10 * Min + 1;
            expect(moodOf(EmptyMood, facts({ waiting: 1, oldest: Waiter(since) }), Day).mood).toBe("attentive");
            const view = moodOf(EmptyMood, facts({ waiting: 1, oldest: Waiter(since) }), Day + 1);
            expect(view.mood).toBe("impatient");
            expect(view.waitedMin).toBe(10);
            expect(moodOf(EmptyMood, facts({ waiting: 1, oldest: Waiter(Day - 12 * Min) }), Day).waitedMin).toBe(12);
        });

        it("tells a doubtful look at ten minutes, then at thirty, and never more for the same row", () => {
            const rows = [{ key: "agent:a", since: Day }];
            let told: Record<string, number> = {};
            expect(dueWaits(rows, told, Day + 10 * Min - 1).due).toEqual([]);
            expect(dueWaits(rows, told, Day + 10 * Min - 1).nextAt).toBe(Day + 10 * Min);

            const first = dueWaits(rows, told, Day + 10 * Min);
            expect(first.due).toEqual([{ key: "agent:a", afterMs: 10 * Min }]);
            expect(first.nextAt).toBe(Day + 30 * Min);
            told = after([[{ type: "told", key: "agent:a", afterMs: 10 * Min }, Day + 10 * Min]]).told;
            expect(dueWaits(rows, told, Day + 20 * Min).due).toEqual([]);

            const second = dueWaits(rows, told, Day + 30 * Min);
            expect(second.due).toEqual([{ key: "agent:a", afterMs: 30 * Min }]);
            expect(second.nextAt).toBeNull();
            told = after([[{ type: "told", key: "agent:a", afterMs: 30 * Min }, Day + 30 * Min]], {
                ...EmptyMood,
                told,
            }).told;
            expect(dueWaits(rows, told, Day + 600 * Min).due).toEqual([]);
        });

        it("owes one look for a wait that crossed both limits unseen, not two", () => {
            const rows = [{ key: "agent:a", since: Day }];
            expect(dueWaits(rows, {}, Day + 45 * Min).due).toEqual([{ key: "agent:a", afterMs: 30 * Min }]);
        });

        it("forgets the rows that no longer wait, so that one that waits again is told again", () => {
            const memory = after([
                [{ type: "told", key: "agent:a", afterMs: 10 * Min }, Day],
                [{ type: "told", key: "agent:b", afterMs: 30 * Min }, Day],
            ]);
            const still = moodAfter(memory, { type: "still", keys: ["agent:a"] }, Day);
            expect(still.told).toEqual({ "agent:a": 10 * Min });
            expect(moodAfter(still, { type: "still", keys: ["agent:a"] }, Day)).toBe(still);
        });

        it("ignores a row whose start is unknown", () => {
            expect(dueWaits([{ key: "x", since: 0 }], {}, Day + 99 * Min)).toEqual({ due: [], nextAt: null });
        });

        it("names the milestones it plays at", () => {
            expect(ImpatientAfterMs).toEqual([10 * Min, 30 * Min]);
        });
    });

    describe("satisfied", () => {
        it("lasts ten minutes after the list is cleared, a pull request merges or a wave of work ends", () => {
            for (const event of [
                { type: "cleared" },
                { type: "merged", number: 12 },
                { type: "finished", name: "Arthur", all: true },
            ] as MoodEvent[]) {
                const memory = after([[event, Day]]);
                expect(moodOf(memory, facts(), Day + SatisfiedMs - 1).mood).toBe("satisfied");
                expect(moodOf(memory, facts(), Day + SatisfiedMs).mood).toBe("neutral");
            }
        });

        it("is not made by an agent that finishes while others work", () => {
            const memory = after([[{ type: "finished", name: "Arthur", all: false }, Day]]);
            expect(memory.satisfiedAt).toBeNull();
            expect(memory.news).toMatchObject({ kind: "finished", name: "Arthur", all: false });
        });

        it("has the caption mention the good work for five minutes only", () => {
            const memory = after([[{ type: "cleared" }, Day]]);
            expect(moodOf(memory, facts(), Day + SatisfiedMentionMs - 1).satisfiedMention).toBe(true);
            expect(moodOf(memory, facts(), Day + SatisfiedMentionMs).satisfiedMention).toBe(false);
        });

        it("gives way to what is waiting", () => {
            const memory = after([[{ type: "cleared" }, Day]]);
            expect(moodOf(memory, facts({ waiting: 1 }), Day + Min).mood).toBe("attentive");
        });
    });

    describe("the order of the moods", () => {
        it("is concerned, impatient, attentive, satisfied, neutral", () => {
            const long = Waiter(Day - 20 * Min);
            const memory = after([[{ type: "cleared" }, Day - Min]]);
            expect(moodOf(memory, facts({ failing: true, waiting: 2, oldest: long }), Day).mood).toBe("concerned");
            expect(moodOf(memory, facts({ waiting: 2, oldest: long }), Day).mood).toBe("impatient");
            expect(moodOf(memory, facts({ waiting: 2, oldest: Waiter(Day - Min) }), Day).mood).toBe("attentive");
            expect(moodOf(memory, facts(), Day).mood).toBe("satisfied");
            expect(moodOf(EmptyMood, facts(), Day).mood).toBe("neutral");
        });
    });

    describe("tired", () => {
        it("is the night, from 23:00 to 06:00 local time, and is added to the mood, never in its place", () => {
            expect(isNight(at(22, 59))).toBe(false);
            expect(isNight(at(23, 0))).toBe(true);
            expect(isNight(at(0, 30))).toBe(true);
            expect(isNight(at(5, 59))).toBe(true);
            expect(isNight(at(6, 0))).toBe(false);
            expect(isNight(at(12, 0))).toBe(false);
            const view = moodOf(EmptyMood, facts({ failing: true, waiting: 1 }), at(23, 30));
            expect(view.mood).toBe("concerned");
            expect(view.tired).toBe(true);
        });

        it("knows when the night begins and ends", () => {
            expect(nextNightChange(at(10, 0))).toBe(at(23, 0));
            expect(nextNightChange(at(23, 30))).toBe(new Date(2026, 10, 7, 6, 0, 0).getTime());
            expect(nextNightChange(at(2, 0))).toBe(at(6, 0));
            expect(nextNightChange(at(6, 0))).toBe(at(23, 0));
        });
    });
});

describe("a mood plays its expression when the screen or the card opens (FR-BOSS-007, AC12)", () => {
    const failing = facts({ failing: true, waiting: 1 });

    it("frowns when concerned, looks doubtful when impatient, smiles when satisfied", () => {
        expect(replayOf(EmptyMood, moodOf(EmptyMood, failing, Day), Day)).toBe("frown");
        const long = facts({ waiting: 1, oldest: Waiter(Day - 15 * Min) });
        expect(replayOf(EmptyMood, moodOf(EmptyMood, long, Day), Day)).toBe("doubtful");
        const cleared = after([[{ type: "cleared" }, Day - Min]]);
        expect(replayOf(cleared, moodOf(cleared, facts(), Day), Day)).toBe("smile");
    });

    it("plays nothing when attentive or neutral, nor for a good mood that has faded from the caption", () => {
        const waiting = facts({ waiting: 1, oldest: Waiter(Day - Min) });
        expect(replayOf(EmptyMood, moodOf(EmptyMood, waiting, Day), Day)).toBeNull();
        expect(replayOf(EmptyMood, moodOf(EmptyMood, facts(), Day), Day)).toBeNull();
        const old = after([[{ type: "cleared" }, Day]]);
        const view = moodOf(old, facts(), Day + SatisfiedMentionMs + 1);
        expect(view.mood).toBe("satisfied");
        expect(replayOf(old, view, Day + SatisfiedMentionMs + 1)).toBeNull();
    });

    it("plays at most every five minutes, once the last replay has played", () => {
        const memory = after([[{ type: "replayed" }, Day]]);
        const view = moodOf(memory, failing, Day);
        expect(replayOf(memory, view, Day + ReplayEveryMs - 1)).toBeNull();
        expect(replayOf(memory, view, Day + ReplayEveryMs)).toBe("frown");
    });
});

describe("his greeting when the developer is back (FR-BOSS-007, AC14)", () => {
    it("summarises what happened while they were away, and forgets it afterwards", () => {
        const memory = after([
            [{ type: "arrived" }, Day - 50 * Min],
            [{ type: "finished", name: "Arthur", all: false }, Day - 40 * Min],
            [{ type: "finished", name: "Arthur", all: false }, Day - 35 * Min],
            [{ type: "finished", name: "Olivia", all: false }, Day - 10 * Min],
            [{ type: "arrived" }, Day - 5 * Min],
            [{ type: "returned", since: Day - 45 * Min }, Day],
        ]);
        expect(memory.back).toEqual({
            at: Day,
            summary: { finished: ["Arthur", "Olivia"], arrived: 1 },
        });
        expect(memory.log).toEqual([]);
    });

    // #2217 (audit #2214, C6, A2): the mood's greeting nod had no caller left; the kind colleague's hello owns the nod.
    it("has no greeting of its own: the hello of the kind colleague greets", async () => {
        const mood = await import("./brokk-mood");
        expect("greetingDue" in mood).toBe(false);
        expect("GreetWithinMs" in mood).toBe(false);
    });

    it("keeps the welcome in the memory for a minute", () => {
        expect(BackMs).toBe(Min);
    });
});

describe("the memory", () => {
    it("is the same object when an event changes nothing, so that no one draws again", () => {
        const told = after([[{ type: "told", key: "a", afterMs: 30 * Min }, Day]]);
        expect(moodAfter(told, { type: "told", key: "a", afterMs: 10 * Min }, Day)).toBe(told);
        expect(moodAfter(EmptyMood, { type: "still", keys: [] }, Day)).toBe(EmptyMood);
    });

    it("keeps only the last fifty things that happened", () => {
        const many = Array.from({ length: 80 }, (_, i) => [{ type: "arrived" }, Day + i] as [MoodEvent, number]);
        expect(after(many).log).toHaveLength(50);
    });

    it("remembers the last answer for the caption", () => {
        const memory = after([[{ type: "handled", kind: "rerun" }, Day]]);
        expect(memory.handled).toEqual({ at: Day, kind: "rerun" });
    });
});

describe("the clock of the visits (FR-BOSS-009, AC4)", () => {
    const Default = DefaultQuietHours;

    describe("quiet hours", () => {
        it("are from 22:00 to 08:00 by default, and on", () => {
            expect(Default).toEqual({ on: true, from: 22 * 60, to: 8 * 60 });
        });

        // A window that crosses midnight is on at both of its ends.
        const table: [string, number, boolean][] = [
            ["21:59", at(21, 59), false],
            ["22:00", at(22, 0), true],
            ["23:59", at(23, 59), true],
            ["00:00", new Date(2026, 10, 7, 0, 0).getTime(), true],
            ["07:59", at(7, 59), true],
            ["08:00", at(8, 0), false],
            ["noon", at(12, 0), false],
        ];

        it.each(table)("at %s they are %s", (_name, now, quiet) => {
            expect(inQuietHours(Default, now)).toBe(quiet);
        });

        it("cover a window within a day", () => {
            const lunch = { on: true, from: 12 * 60, to: 14 * 60 };
            expect(inQuietHours(lunch, at(11, 59))).toBe(false);
            expect(inQuietHours(lunch, at(12, 0))).toBe(true);
            expect(inQuietHours(lunch, at(13, 59))).toBe(true);
            expect(inQuietHours(lunch, at(14, 0))).toBe(false);
        });

        it("are never on when turned off, or when they begin and end together", () => {
            expect(inQuietHours({ ...Default, on: false }, at(23, 0))).toBe(false);
            expect(inQuietHours({ on: true, from: 600, to: 600 }, at(10, 0))).toBe(false);
            expect(nextQuietChange({ ...Default, on: false }, at(23, 0))).toBeNull();
            expect(nextQuietChange({ on: true, from: 600, to: 600 }, at(10, 0))).toBeNull();
        });

        it("name the next moment they begin or end", () => {
            expect(nextQuietChange(Default, at(12, 0))).toBe(at(22, 0));
            expect(nextQuietChange(Default, at(22, 0))).toBe(new Date(2026, 10, 7, 8, 0).getTime());
            expect(nextQuietChange(Default, at(23, 30))).toBe(new Date(2026, 10, 7, 8, 0).getTime());
            expect(nextQuietChange(Default, at(2, 0))).toBe(at(8, 0));
            expect(nextQuietChange(Default, at(8, 0))).toBe(at(22, 0));
        });
    });

    describe("clock times", () => {
        it("reads HH:MM as minutes since midnight, and anything else as nothing", () => {
            expect(parseClock("22:00")).toBe(1320);
            expect(parseClock("08:05")).toBe(485);
            expect(parseClock("8:05")).toBe(485);
            expect(parseClock(" 23:59 ")).toBe(1439);
            expect(parseClock("00:00")).toBe(0);
            for (const bad of ["24:00", "12:60", "1200", "12:5", "noon", "", null, undefined, 1200, {}]) {
                expect(parseClock(bad), String(bad)).toBeNull();
            }
        });

        it("names the next time the clock reads a minute, strictly after now", () => {
            expect(nextClockTime(at(10, 0), 18 * 60)).toBe(at(18, 0));
            expect(nextClockTime(at(18, 0), 18 * 60)).toBe(new Date(2026, 10, 7, 18, 0).getTime());
            expect(nextClockTime(at(18, 1), 18 * 60)).toBe(new Date(2026, 10, 7, 18, 0).getTime());
            expect(nextClockTime(at(0, 0), 0)).toBe(new Date(2026, 10, 7, 0, 0).getTime());
        });

        it("reads minutes of the local day", () => {
            expect(minutesOfDay(at(0, 0))).toBe(0);
            expect(minutesOfDay(at(13, 45))).toBe(13 * 60 + 45);
            expect(minutesOfDay(at(23, 59))).toBe(1439);
        });
    });
});
