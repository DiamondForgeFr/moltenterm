// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BrokkSituation } from "./brokk-ask-model";
import {
    EmptyMood,
    HandledMs,
    moodAfter,
    MoodEvent,
    MoodFacts,
    MoodMemory,
    NewsMs,
    ReliefMs,
    SatisfiedMentionMs,
} from "./brokk-mood";
import { ExpressionMs, KeyQuietMs } from "./brokk-queue";
import { brokkScene, BrokkScene, CaptionLine, LongThoughtMs, SceneInput, TypingCalmMs } from "./brokk-scene";

const Min = 60_000;
// Ten in the morning, local time: not the night.
const Day = new Date(2026, 10, 6, 10, 0, 0).getTime();
const Night = new Date(2026, 10, 6, 23, 30, 0).getTime();

function situation(partial: Partial<BrokkSituation> = {}): BrokkSituation {
    return { working: 0, waiting: 0, cardOpen: false, away: false, ...partial };
}

function memoryAfter(events: [MoodEvent, number][]): MoodMemory {
    return events.reduce((memory, [event, now]) => moodAfter(memory, event, now), EmptyMood);
}

function facts(partial: Partial<MoodFacts> = {}): MoodFacts {
    return { failing: false, waiting: 0, oldest: null, ...partial };
}

function scene(partial: Partial<SceneInput> = {}): BrokkScene {
    const input: SceneInput = {
        situation: situation(),
        now: Day,
        memory: EmptyMood,
        facts: facts(),
        top: null,
        worker: "",
        badge: { count: 0, tone: "waiting", text: "" },
        asked: null,
        speaking: false,
        motion: true,
        pinned: false,
        lastKeyAt: null,
        workingSince: 0,
        usage: null,
        ...partial,
    };
    // The badge counts what waits: the two agree unless the test says otherwise.
    if (partial.badge == null) {
        input.badge = { count: input.situation.waiting, tone: "waiting", text: String(input.situation.waiting) };
    }
    return brokkScene(input);
}

const Status = (s: BrokkScene) => s.caption.status;
const Detail = (s: BrokkScene) => s.caption.detail;
const Line = (text: string): CaptionLine => ({ text });

// One test per row of the behaviour matrix of #1959. The face, the gesture, the caption, the loader, the round and the
// hover card are all read from the one scene.
describe("the scene, row by row (FR-BOSS-007, AC10 and AC11, #1959)", () => {
    it("calm: nothing works, nothing waits, you are there", () => {
        const s = scene();
        expect(s.face).toBe("listening");
        expect(s.gesture).toBeNull();
        expect(Status(s)).toEqual({ key: "boss.screen.quiet" });
        expect(Detail(s)).toBeUndefined();
        expect(s.loader).toBe(false);
        expect(s.round).toMatchObject({ count: 0, calling: false });
        expect(s.card.status).toEqual(Status(s));
        expect(s.mood.mood).toBe("neutral");
        expect(s.rhythm).toBe("normal");
    });

    it("one agent works: he thinks, says who works, then that nothing is for you, and the domino turns", () => {
        const s = scene({ situation: situation({ working: 1 }), worker: "Arthur" });
        expect(s.face).toBe("thinking");
        expect(Status(s)).toEqual({ key: "boss.screen.working", vars: { name: "Arthur" } });
        expect(Detail(s)).toEqual({ key: "boss.screen.nothingForYou" });
        expect(s.loader).toBe(true);
        expect(s.card.status).toEqual(Status(s));
        expect(s.round.count).toBe(0);
    });

    it("several agents work: the count, and a calmer blink after five minutes of thought", () => {
        const working = situation({ working: 3 });
        const fresh = scene({ situation: working, workingSince: Day - Min });
        expect(Status(fresh)).toEqual({ key: "boss.screen.workingCount", count: 3 });
        expect(fresh.loader).toBe(true);
        expect(fresh.rhythm).toBe("normal");
        const long = scene({ situation: working, workingSince: Day - LongThoughtMs });
        expect(long.rhythm).toBe("calm");
        expect(scene({ situation: situation(), workingSince: Day - LongThoughtMs }).rhythm).toBe("normal");
    });

    it("an agent finishes while others work: no gesture, he says it for two minutes", () => {
        const memory = memoryAfter([[{ type: "finished", name: "Arthur", all: false }, Day - Min]]);
        const s = scene({ situation: situation({ working: 2 }), memory });
        expect(s.face).toBe("thinking");
        expect(s.gesture).toBeNull();
        expect(Status(s)).toEqual({ key: "boss.screen.finished", vars: { name: "Arthur" } });
        expect(Detail(s)).toEqual({ key: "boss.screen.workingCount", count: 2 });
        expect(s.loader).toBe(true);
        expect(s.round.count).toBe(0);
        expect(s.card.status).toEqual(Status(s));
        const later = scene({ situation: situation({ working: 2 }), memory, now: Day - Min + NewsMs });
        expect(Status(later)).toEqual({ key: "boss.screen.workingCount", count: 2 });
    });

    it("the wave of work ends: he looks up, nods once and is satisfied", () => {
        const memory = memoryAfter([[{ type: "finished", name: "Arthur", all: true }, Day]]);
        const s = scene({ memory, asked: { expression: "nod", cue: 1, at: Day } });
        expect(s.face).toBe("listening");
        expect(s.gesture).toBe("nod");
        expect(Status(s)).toEqual({ key: "boss.screen.finishedAll" });
        expect(Detail(s)).toEqual({ key: "boss.screen.nothingForYou" });
        expect(s.loader).toBe(false);
        expect(s.mood.mood).toBe("satisfied");
        expect(s.card.status).toEqual(Status(s));
    });

    it("something arrives: he looks at you and calls once, the round and the screen say the row's own words", () => {
        const s = scene({
            situation: situation({ waiting: 1 }),
            facts: facts({ waiting: 1 }),
            top: Line("Olivia waits for you"),
            asked: { expression: "call", cue: 1, at: Day },
            badge: { count: 1, tone: "waiting", text: "1" },
        });
        expect(s.face).toBe("listening");
        expect(s.gesture).toBe("call");
        expect(s.round).toEqual({ count: 1, tone: "waiting", text: "1", calling: true });
        expect(Status(s)).toEqual(Line("Olivia waits for you"));
        expect(s.card.status).toEqual(Status(s));
        expect(s.mood.mood).toBe("attentive");
        expect(s.loader).toBe(false);
    });

    it("several arrive: the count, then who works", () => {
        const s = scene({ situation: situation({ waiting: 3, working: 2 }), top: Line("Olivia waits for you") });
        expect(Status(s)).toEqual({ key: "boss.screen.toHandle", count: 3 });
        expect(Detail(s)).toEqual({ key: "boss.screen.workingCount", count: 2 });
        expect(s.loader).toBe(true);
        expect(s.card.status).toEqual(Status(s));
    });

    it("something waits while agents work: a waiting human beats background work, he listens and the domino still turns", () => {
        const s = scene({
            situation: situation({ waiting: 1, working: 2 }),
            facts: facts({ waiting: 1 }),
            top: Line("Olivia waits for you"),
            asked: { expression: "call", cue: 1, at: Day },
        });
        expect(s.face).toBe("listening");
        expect(s.gesture).toBe("call");
        expect(Status(s)).toEqual(Line("Olivia waits for you"));
        expect(Detail(s)).toEqual({ key: "boss.screen.workingCount", count: 2 });
        expect(s.loader).toBe(true);
        expect(s.mood.mood).toBe("attentive");
        // Thinking leads only when nothing waits.
        expect(scene({ situation: situation({ waiting: 0, working: 2 }) }).face).toBe("thinking");
        for (const working of [1, 3, 9]) {
            for (const waiting of [1, 2, 7]) {
                expect(scene({ situation: situation({ waiting, working }) }).face).toBe("listening");
            }
        }
    });

    it("a failure while agents work: he listens, concerned, and frowns once; the loop he is left in is the listening one", () => {
        const failing = {
            situation: situation({ waiting: 2, working: 1 }),
            facts: facts({ failing: true, waiting: 2 }),
            top: Line("Arthur stopped on an error"),
            worker: "Jérôme",
            badge: { count: 2, tone: "error" as const, text: "2" },
        };
        const arriving = scene({ ...failing, asked: { expression: "frown", cue: 1, at: Day } });
        expect(arriving.face).toBe("listening");
        expect(arriving.gesture).toBe("frown");
        expect(arriving.mood.mood).toBe("concerned");
        expect(Status(arriving)).toEqual(Line("Arthur stopped on an error"));
        expect(arriving.round.tone).toBe("error");
        expect(arriving.loader).toBe(true);
        const settled = scene({
            ...failing,
            asked: { expression: "frown", cue: 1, at: Day },
            now: Day + ExpressionMs.frown,
        });
        expect(settled.gesture).toBeNull();
        expect(settled.face).toBe("listening");
        expect(settled.mood.mood).toBe("concerned");
    });

    it("a row waits long: he is impatient, and says how long", () => {
        const oldest = { key: "agent:a", name: "Olivia", since: Day - 12 * Min, agent: true };
        const s = scene({ situation: situation({ waiting: 1 }), facts: facts({ waiting: 1, oldest }), top: Line("x") });
        expect(s.mood.mood).toBe("impatient");
        expect(Status(s)).toEqual({ key: "boss.screen.waitedFor", vars: { name: "Olivia", minutes: 12 } });
        expect(s.card.status).toEqual(Status(s));
        expect(s.round.tone).toBe("waiting");
        const other = scene({
            situation: situation({ waiting: 1 }),
            facts: facts({ waiting: 1, oldest: { ...oldest, name: "Chloé: Fix the login", agent: false } }),
            top: Line("x"),
        });
        expect(Status(other)).toEqual({
            key: "boss.screen.waitedLine",
            vars: { line: "Chloé: Fix the login", minutes: 12 },
        });
    });

    it("a failure: he is concerned, frowns, and the badge is red", () => {
        const s = scene({
            situation: situation({ waiting: 1 }),
            facts: facts({ failing: true, waiting: 1 }),
            top: Line("CI failing: build (#1955)"),
            asked: { expression: "frown", cue: 1, at: Day },
            badge: { count: 1, tone: "error", text: "1" },
        });
        expect(s.mood.mood).toBe("concerned");
        expect(s.gesture).toBe("frown");
        expect(Status(s)).toEqual(Line("CI failing: build (#1955)"));
        expect(s.round.tone).toBe("error");
        expect(s.card.status).toEqual(Status(s));
    });

    it("a failure among others: the failure first, then the count", () => {
        const s = scene({
            situation: situation({ waiting: 3 }),
            facts: facts({ failing: true, waiting: 3 }),
            top: Line("Arthur stopped on an error"),
        });
        expect(Status(s)).toEqual(Line("Arthur stopped on an error"));
        expect(Detail(s)).toEqual({ key: "boss.screen.toHandle", count: 3 });
    });

    it("the failure is settled: relieved for a minute, then calm", () => {
        const memory = memoryAfter([[{ type: "settled" }, Day]]);
        const s = scene({ memory, now: Day + 1000 });
        expect(Status(s)).toEqual({ key: "boss.screen.relieved" });
        expect(s.card.status).toEqual(Status(s));
        expect(Status(scene({ memory, now: Day + ReliefMs }))).toEqual({ key: "boss.screen.quiet" });
    });

    it("you open the card on rows to handle: he looks at you and says them for a moment, then the count", () => {
        const base = {
            situation: situation({ waiting: 2, cardOpen: true }),
            top: Line("Olivia waits for your approval"),
            badge: { count: 2, tone: "waiting" as const, text: "2" },
        };
        const speaking = scene({ ...base, speaking: true });
        expect(speaking.face).toBe("speaking");
        expect(Status(speaking)).toEqual({
            key: "boss.screen.speech",
            count: 2,
            vars: { line: "Olivia waits for your approval" },
        });
        expect(Detail(speaking)).toBeUndefined();
        // The hover card is hidden while the card is open: it keeps the plain headline.
        expect(speaking.card.status).toEqual({ key: "boss.screen.toHandle", count: 2 });
        const after = scene({ ...base, speaking: false });
        expect(after.face).toBe("listening");
        expect(Status(after)).toEqual({ key: "boss.screen.toHandle", count: 2 });
    });

    it("you open the card while agents work and nothing waits: he looks up, and the screen still says they work", () => {
        const s = scene({ situation: situation({ working: 2, cardOpen: true }), speaking: true });
        expect(s.face).toBe("listening");
        expect(Status(s)).toEqual({ key: "boss.screen.workingCount", count: 2 });
        expect(Detail(s)).toEqual({ key: "boss.screen.nothingForYou" });
        expect(s.loader).toBe(true);
    });

    it("a hover is no visit: he keeps to his work, whatever the screen shows", () => {
        const s = scene({ situation: situation({ working: 2, cardOpen: false }) });
        expect(s.face).toBe("thinking");
    });

    it("you answer a row: the screen says it was noted for three seconds, the hover card does not", () => {
        for (const kind of ["answer", "rerun", "handoff", "done"] as const) {
            const memory = memoryAfter([[{ type: "handled", kind }, Day]]);
            const s = scene({ memory, now: Day + 1000, situation: situation({ waiting: 1, cardOpen: true }) });
            expect(Status(s)).toEqual({ key: `boss.screen.handled.${kind}` });
            expect(s.card.status.key).not.toContain("handled");
        }
        const memory = memoryAfter([[{ type: "handled", kind: "answer" }, Day]]);
        const gone = scene({ memory, now: Day + HandledMs, situation: situation({ waiting: 1, cardOpen: true }) });
        expect(Status(gone).key).toBe("boss.screen.toHandle");
    });

    it("the list is cleared: a smile, 'all handled', then 'nice work' for five minutes, satisfied for ten", () => {
        const memory = memoryAfter([[{ type: "cleared" }, Day]]);
        const s = scene({ memory, asked: { expression: "smile", cue: 1, at: Day } });
        expect(s.gesture).toBe("smile");
        expect(Status(s)).toEqual({ key: "boss.screen.cleared" });
        expect(Detail(s)).toEqual({ key: "boss.screen.thanks" });
        expect(s.round.count).toBe(0);
        expect(s.mood.mood).toBe("satisfied");
        const later = scene({ memory, now: Day + NewsMs });
        expect(Status(later)).toEqual({ key: "boss.screen.quiet" });
        expect(Detail(later)).toEqual({ key: "boss.screen.niceWork" });
        const faded = scene({ memory, now: Day + SatisfiedMentionMs });
        expect(Detail(faded)).toBeUndefined();
        expect(faded.mood.mood).toBe("satisfied");
    });

    it("a pull request merges: a smile, and he says which for two minutes", () => {
        const memory = memoryAfter([[{ type: "merged", number: 1955 }, Day]]);
        const s = scene({ memory, asked: { expression: "smile", cue: 1, at: Day } });
        expect(s.gesture).toBe("smile");
        expect(Status(s)).toEqual({ key: "boss.screen.merged", vars: { number: 1955 } });
        expect(s.card.status).toEqual(Status(s));
        const busy = scene({ memory, situation: situation({ working: 2 }) });
        expect(Detail(busy)).toEqual({ key: "boss.screen.workingCount", count: 2 });
    });

    it("you type: the pose holds, the badge is up to date at once, and the blinks calm down for a moment", () => {
        const typing = scene({
            situation: situation({ working: 2, waiting: 1 }),
            lastKeyAt: Day - 1000,
            badge: { count: 1, tone: "waiting", text: "1" },
        });
        expect(typing.round.count).toBe(1);
        expect(typing.rhythm).toBe("calm");
        const paused = scene({ situation: situation({ working: 2 }), lastKeyAt: Day - TypingCalmMs });
        expect(paused.rhythm).toBe("normal");
        expect(paused.face).toBe("thinking");
    });

    it("you stop typing: the calm ends after a short while, and the scene asks to be drawn again then (#2010)", () => {
        const lastKeyAt = Day - 1000;
        const typing = scene({ lastKeyAt });
        expect(typing.rhythm).toBe("calm");
        expect(typing.until).toBe(lastKeyAt + TypingCalmMs);
        const between = scene({ lastKeyAt, now: lastKeyAt + KeyQuietMs });
        expect(between.rhythm).toBe("calm");
        const after = scene({ lastKeyAt, now: typing.until });
        expect(after.rhythm).toBe("normal");
        expect(after.until).toBeGreaterThan(typing.until);
        const atNight = scene({ lastKeyAt: Night - 1000, now: Night - 1000 + TypingCalmMs });
        expect(atNight.rhythm).toBe("calm");
    });

    it("you are away and nothing goes on: he sleeps; with work or a row, he stays awake", () => {
        const asleep = scene({ situation: situation({ away: true }) });
        expect(asleep.face).toBe("rest");
        expect(Status(asleep)).toEqual({ key: "boss.screen.asleep" });
        expect(asleep.card.status).toEqual(Status(asleep));
        expect(asleep.loader).toBe(false);
        expect(scene({ situation: situation({ away: true, working: 1 }), worker: "A" }).face).toBe("thinking");
        expect(scene({ situation: situation({ away: true, waiting: 1 }) }).face).toBe("listening");
    });

    it("you come back after a long absence: the welcome and what happened, for a minute", () => {
        const finished = memoryAfter([
            [{ type: "finished", name: "Arthur", all: false }, Day - 20 * Min],
            [{ type: "returned", since: Day - 40 * Min }, Day],
        ]);
        const s = scene({ memory: finished, now: Day + 1000 });
        expect(Status(s)).toEqual({ key: "boss.screen.welcomeBack" });
        expect(Detail(s)).toEqual({
            key: "boss.screen.backFinished",
            count: 1,
            vars: { names: "Arthur" },
        });
        // The hover card carries the two lines too: a return is worth them.
        expect(s.card).toEqual(s.caption);

        const arrived = memoryAfter([
            [{ type: "arrived" }, Day - 20 * Min],
            [{ type: "arrived" }, Day - 10 * Min],
            [{ type: "returned", since: Day - 40 * Min }, Day],
        ]);
        expect(Detail(scene({ memory: arrived, now: Day + 1000 }))).toEqual({
            key: "boss.screen.backArrived",
            count: 2,
        });

        const nothing = memoryAfter([[{ type: "returned", since: Day - 40 * Min }, Day]]);
        expect(Detail(scene({ memory: nothing, now: Day + 1000 }))).toEqual({ key: "boss.screen.backNothing" });
        expect(Status(scene({ memory: nothing, now: Day + Min }))).toEqual({ key: "boss.screen.quiet" });
    });

    it("it is night: a mention in the caption and a calmer blink, with no other change", () => {
        const working = scene({ situation: situation({ working: 2 }), now: Night });
        expect(working.face).toBe("thinking");
        expect(Status(working)).toEqual({ key: "boss.screen.workingCount", count: 2 });
        expect(Detail(working)).toEqual({ key: "boss.screen.lateNight" });
        expect(working.mood.tired).toBe(true);
        expect(working.rhythm).toBe("calm");
        const calm = scene({ now: Night });
        expect(Status(calm)).toEqual({ key: "boss.screen.quiet" });
        expect(Detail(calm)).toEqual({ key: "boss.screen.lateNight" });
        expect(scene({ now: Day }).mood.tired).toBe(false);
    });

    it("the plan is nearly used up: a mention, only when nothing more important takes the place, and no gesture", () => {
        const usage = { key: "boss.peek.usage", vars: { agent: "Claude Code", label: "5-hour", used: "86 %" } };
        const calm = scene({ usage });
        expect(Detail(calm)).toEqual(usage);
        expect(calm.gesture).toBeNull();
        expect(Detail(scene({ usage, situation: situation({ working: 1 }), worker: "A" }))).toEqual({
            key: "boss.screen.nothingForYou",
        });
        expect(Detail(scene({ usage, situation: situation({ waiting: 1 }) }))).toBeUndefined();
        expect(Detail(scene({ usage, now: Night }))).toEqual({ key: "boss.screen.lateNight" });
    });

    it("reduced motion: the same words and loader, no gesture, the still everywhere", () => {
        const input = {
            situation: situation({ waiting: 2, working: 1 }),
            worker: "Arthur",
            asked: { expression: "call" as const, cue: 3, at: Day },
        };
        const moving = scene(input);
        const still = scene({ ...input, motion: false });
        expect(moving.gesture).toBe("call");
        expect(still.gesture).toBeNull();
        expect(still.round.calling).toBe(false);
        expect(still.caption).toEqual(moving.caption);
        expect(still.loader).toBe(true);
        expect(still.card).toEqual(moving.card);
    });

    it("the card's header shows the still while the screen stands beside it", () => {
        expect(scene({ pinned: true }).headerStill).toBe(true);
        expect(scene({ pinned: false }).headerStill).toBe(false);
    });
});

describe("the models are surface-agnostic (#1959, for #1995)", () => {
    // A sidebar form must be able to read the same scene and the same mood: none of the pure models may know where the
    // bubble sits or how large it is, nor reach a surface's own modules.
    const pure = ["brokk-scene.ts", "brokk-mood.ts", "brokk-queue.ts", "brokk-watch.ts"];

    function code(file: string): string {
        return readFileSync(join(__dirname, file), "utf8").replace(/\/\/.*$/gm, "");
    }

    it("import nothing of the bubble's place, the screen's size, the store or the components", () => {
        for (const file of pure) {
            for (const specifier of [...code(file).matchAll(/from "([^"]+)"/g)].map((m) => m[1])) {
                expect(specifier, `${file} imports ${specifier}`).not.toMatch(
                    /boss-place|boss-screen|boss-store|boss-bubble|boss-card|boss-portrait|use-brokk-live/
                );
            }
        }
    });

    it("speak of no corner, size or rectangle", () => {
        for (const file of pure) {
            expect(code(file), file).not.toMatch(
                /\b(corner|BubbleSize|ScreenSize|Rect|getBoundingClientRect|innerWidth)\b|\d\s?px\b/
            );
        }
    });

    it("take the surface's own facts as inputs, so that any surface can give them", () => {
        const fields = Object.keys({
            situation: 0,
            now: 0,
            memory: 0,
            facts: 0,
            top: 0,
            worker: 0,
            badge: 0,
            asked: 0,
            speaking: 0,
            motion: 0,
            pinned: 0,
            lastKeyAt: 0,
            workingSince: 0,
            usage: 0,
        });
        const input: SceneInput = {
            situation: situation(),
            now: Day,
            memory: EmptyMood,
            facts: facts(),
            top: null,
            worker: "",
            badge: { count: 0, tone: "waiting", text: "" },
            asked: null,
            speaking: false,
            motion: true,
            pinned: false,
            lastKeyAt: null,
            workingSince: 0,
            usage: null,
        };
        expect(Object.keys(input).sort()).toEqual(fields.sort());
        expect(brokkScene(input).caption.status).toEqual({ key: "boss.screen.quiet" });
    });
});

describe("the scene, in general (#1959)", () => {
    it("shows a gesture only while its clip lasts", () => {
        const asked = { expression: "smile" as const, cue: 1, at: Day };
        expect(scene({ asked, now: Day + ExpressionMs.smile - 1 }).gesture).toBe("smile");
        expect(scene({ asked, now: Day + ExpressionMs.smile }).gesture).toBeNull();
    });

    it("never says there is nothing to handle while an agent works or something waits", () => {
        for (const working of [0, 1, 4]) {
            for (const waiting of [0, 1, 4]) {
                if (working === 0 && waiting === 0) {
                    continue;
                }
                const s = scene({ situation: situation({ working, waiting }), worker: "Arthur", top: Line("x") });
                expect(Status(s).key).not.toBe("boss.screen.quiet");
                expect(Detail(s)?.key).not.toBe("boss.screen.quiet");
            }
        }
    });

    it("shows the domino exactly while agents work", () => {
        for (const working of [0, 1, 3]) {
            expect(scene({ situation: situation({ working }) }).loader).toBe(working > 0);
        }
    });

    it("gives the same sentence to the screen and to the hover card, whatever the situation", () => {
        const memory = memoryAfter([[{ type: "finished", name: "Arthur", all: true }, Day]]);
        const cases: Partial<SceneInput>[] = [
            {},
            { situation: situation({ working: 2 }), worker: "A" },
            { situation: situation({ waiting: 1 }), top: Line("Olivia waits for you") },
            { situation: situation({ waiting: 4, working: 1 }) },
            { situation: situation({ away: true }) },
            { memory },
            { now: Night },
        ];
        for (const partial of cases) {
            const s = scene(partial);
            expect(s.card.status).toEqual(s.caption.status);
        }
    });

    it("says when it changes by itself: a mention that runs out, a wait that crosses a limit, the night", () => {
        expect(scene().until).toBe(new Date(2026, 10, 6, 23, 0, 0).getTime());
        const handled = memoryAfter([[{ type: "handled", kind: "answer" }, Day]]);
        expect(scene({ memory: handled }).until).toBe(Day + HandledMs);
        const cleared = memoryAfter([[{ type: "cleared" }, Day]]);
        expect(scene({ memory: cleared }).until).toBe(Day + NewsMs);
        const waiting = scene({
            situation: situation({ waiting: 1 }),
            facts: facts({ waiting: 1, oldest: { key: "agent:a", name: "O", since: Day - 3 * Min, agent: true } }),
        });
        expect(waiting.until).toBe(Day - 3 * Min + 10 * Min);
        const gesture = scene({ asked: { expression: "nod", cue: 1, at: Day } });
        expect(gesture.until).toBe(Day + ExpressionMs.nod);
        // While impatient, the minutes counted in the caption move on.
        const impatient = scene({
            situation: situation({ waiting: 1 }),
            facts: facts({
                waiting: 1,
                oldest: { key: "agent:a", name: "O", since: Day - 12 * Min - 5000, agent: true },
            }),
        });
        expect(impatient.until).toBe(Day - 12 * Min - 5000 + 13 * Min);
    });
});
