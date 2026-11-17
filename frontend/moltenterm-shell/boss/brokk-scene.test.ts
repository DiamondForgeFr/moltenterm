// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BrokkSituation } from "./brokk-ask-model";
import { EmptyMood, moodAfter, MoodEvent, MoodFacts, MoodMemory, ReliefMs, SatisfiedMs } from "./brokk-mood";
import { ExpressionMs, KeyQuietMs } from "./brokk-queue";
import { brokkScene, BrokkScene, LongThoughtMs, SceneInput, TypingCalmMs } from "./brokk-scene";

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
        badge: { count: 0, tone: "waiting", text: "" },
        asked: null,
        speaking: false,
        motion: true,
        pinned: false,
        lastKeyAt: null,
        workingSince: 0,
        ...partial,
    };
    // The badge counts what waits: the two agree unless the test says otherwise.
    if (partial.badge == null) {
        input.badge = { count: input.situation.waiting, tone: "waiting", text: String(input.situation.waiting) };
    }
    return brokkScene(input);
}

// One test per row of the behaviour matrix of #1959. The face, the gesture, the loader, the round and the card's header
// are all read from the one scene. It has no caption: the line under his square is his own answer or a moment of a kind
// colleague (brokk-colleague.ts, #2203).
describe("the scene, row by row (FR-BOSS-007, AC10, #1959)", () => {
    it("calm: nothing works, nothing waits, you are there", () => {
        const s = scene();
        expect(s.face).toBe("listening");
        expect(s.gesture).toBeNull();
        expect(s.loader).toBe(false);
        expect(s.round).toMatchObject({ count: 0, calling: false });
        expect(s.mood.mood).toBe("neutral");
        expect(s.rhythm).toBe("normal");
    });

    it("one agent works: he thinks and the domino turns", () => {
        const s = scene({ situation: situation({ working: 1 }) });
        expect(s.face).toBe("thinking");
        expect(s.loader).toBe(true);
        expect(s.round.count).toBe(0);
    });

    it("several agents work: a calmer blink after five minutes of thought", () => {
        const working = situation({ working: 3 });
        const fresh = scene({ situation: working, workingSince: Day - Min });
        expect(fresh.loader).toBe(true);
        expect(fresh.rhythm).toBe("normal");
        const long = scene({ situation: working, workingSince: Day - LongThoughtMs });
        expect(long.rhythm).toBe("calm");
        expect(scene({ situation: situation(), workingSince: Day - LongThoughtMs }).rhythm).toBe("normal");
    });

    it("an agent finishes while others work: no gesture, he keeps thinking", () => {
        const memory = memoryAfter([[{ type: "finished", name: "Arthur", all: false }, Day - Min]]);
        const s = scene({ situation: situation({ working: 2 }), memory });
        expect(s.face).toBe("thinking");
        expect(s.gesture).toBeNull();
        expect(s.loader).toBe(true);
        expect(s.round.count).toBe(0);
    });

    it("the wave of work ends: he looks up, nods once and is satisfied", () => {
        const memory = memoryAfter([[{ type: "finished", name: "Arthur", all: true }, Day]]);
        const s = scene({ memory, asked: { expression: "nod", cue: 1, at: Day } });
        expect(s.face).toBe("listening");
        expect(s.gesture).toBe("nod");
        expect(s.loader).toBe(false);
        expect(s.mood.mood).toBe("satisfied");
    });

    it("something arrives: he looks at you and calls once, the round carries the badge", () => {
        const s = scene({
            situation: situation({ waiting: 1 }),
            facts: facts({ waiting: 1 }),
            asked: { expression: "call", cue: 1, at: Day },
            badge: { count: 1, tone: "waiting", text: "1" },
        });
        expect(s.face).toBe("listening");
        expect(s.gesture).toBe("call");
        expect(s.round).toEqual({ count: 1, tone: "waiting", text: "1", calling: true });
        expect(s.mood.mood).toBe("attentive");
        expect(s.loader).toBe(false);
    });

    it("something waits while agents work: a waiting human beats background work, he listens and the domino still turns", () => {
        const s = scene({
            situation: situation({ waiting: 1, working: 2 }),
            facts: facts({ waiting: 1 }),
            asked: { expression: "call", cue: 1, at: Day },
        });
        expect(s.face).toBe("listening");
        expect(s.gesture).toBe("call");
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
            badge: { count: 2, tone: "error" as const, text: "2" },
        };
        const arriving = scene({ ...failing, asked: { expression: "frown", cue: 1, at: Day } });
        expect(arriving.face).toBe("listening");
        expect(arriving.gesture).toBe("frown");
        expect(arriving.mood.mood).toBe("concerned");
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

    it("a row waits long: he is impatient", () => {
        const oldest = { key: "agent:a", name: "Olivia", since: Day - 12 * Min, agent: true };
        const s = scene({ situation: situation({ waiting: 1 }), facts: facts({ waiting: 1, oldest }) });
        expect(s.mood.mood).toBe("impatient");
        expect(s.mood.waitedMin).toBe(12);
        expect(s.round.tone).toBe("waiting");
    });

    it("a failure: he is concerned, frowns, and the badge is red", () => {
        const s = scene({
            situation: situation({ waiting: 1 }),
            facts: facts({ failing: true, waiting: 1 }),
            asked: { expression: "frown", cue: 1, at: Day },
            badge: { count: 1, tone: "error", text: "1" },
        });
        expect(s.mood.mood).toBe("concerned");
        expect(s.gesture).toBe("frown");
        expect(s.round.tone).toBe("error");
    });

    it("the failure is settled: relieved for a minute, then calm", () => {
        const memory = memoryAfter([[{ type: "settled" }, Day]]);
        expect(scene({ memory, now: Day + 1000 }).mood.relieved).toBe(true);
        expect(scene({ memory, now: Day + ReliefMs }).mood.relieved).toBe(false);
    });

    it("you open the card on rows to handle: he looks at you and speaks for a moment, then listens", () => {
        const base = {
            situation: situation({ waiting: 2, cardOpen: true }),
            badge: { count: 2, tone: "waiting" as const, text: "2" },
        };
        expect(scene({ ...base, speaking: true }).face).toBe("speaking");
        expect(scene({ ...base, speaking: false }).face).toBe("listening");
    });

    it("you open the card while agents work and nothing waits: he looks up", () => {
        const s = scene({ situation: situation({ working: 2, cardOpen: true }), speaking: true });
        expect(s.face).toBe("listening");
        expect(s.loader).toBe(true);
    });

    it("a hover is no visit: he keeps to his work", () => {
        const s = scene({ situation: situation({ working: 2, cardOpen: false }) });
        expect(s.face).toBe("thinking");
    });

    it("the list is cleared: a smile, and satisfied for ten minutes", () => {
        const memory = memoryAfter([[{ type: "cleared" }, Day]]);
        const s = scene({ memory, asked: { expression: "smile", cue: 1, at: Day } });
        expect(s.gesture).toBe("smile");
        expect(s.round.count).toBe(0);
        expect(s.mood.mood).toBe("satisfied");
        expect(scene({ memory, now: Day + SatisfiedMs }).mood.mood).toBe("neutral");
    });

    it("a pull request merges: a smile", () => {
        const memory = memoryAfter([[{ type: "merged", number: 1955 }, Day]]);
        const s = scene({ memory, asked: { expression: "smile", cue: 1, at: Day } });
        expect(s.gesture).toBe("smile");
        expect(s.mood.mood).toBe("satisfied");
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
        expect(asleep.loader).toBe(false);
        expect(scene({ situation: situation({ away: true, working: 1 }) }).face).toBe("thinking");
        expect(scene({ situation: situation({ away: true, waiting: 1 }) }).face).toBe("listening");
    });

    it("it is night: a calmer blink, with no other change", () => {
        const working = scene({ situation: situation({ working: 2 }), now: Night });
        expect(working.face).toBe("thinking");
        expect(working.mood.tired).toBe(true);
        expect(working.rhythm).toBe("calm");
        expect(scene({ now: Day }).mood.tired).toBe(false);
    });

    it("reduced motion: the same loader, no gesture, the still everywhere", () => {
        const input = {
            situation: situation({ waiting: 2, working: 1 }),
            asked: { expression: "call" as const, cue: 3, at: Day },
        };
        const moving = scene(input);
        const still = scene({ ...input, motion: false });
        expect(moving.gesture).toBe("call");
        expect(still.gesture).toBeNull();
        expect(still.round.calling).toBe(false);
        expect(still.loader).toBe(true);
    });

    it("the card's header shows the still while the screen stands beside it", () => {
        expect(scene({ pinned: true }).headerStill).toBe(true);
        expect(scene({ pinned: false }).headerStill).toBe(false);
    });
});

// #2203: the line under his square used to repeat the Notifications panel and the rail's badges, so the scene no longer
// has a caption, a card headline or the inputs that only fed them.
describe("the scene says nothing in words (FR-BOSS-009, AC71, #2203)", () => {
    it("has no caption and no card headline, whatever the situation", () => {
        const cases: Partial<SceneInput>[] = [
            {},
            { situation: situation({ working: 2 }) },
            { situation: situation({ waiting: 1 }) },
            { situation: situation({ waiting: 4, working: 1 }) },
            { situation: situation({ away: true }) },
            { memory: memoryAfter([[{ type: "finished", name: "Arthur", all: true }, Day]]) },
            { memory: memoryAfter([[{ type: "returned", since: Day - 40 * Min }, Day]]) },
            { now: Night },
        ];
        for (const partial of cases) {
            const s = scene(partial) as Record<string, unknown>;
            expect(Object.keys(s)).not.toContain("caption");
            expect(Object.keys(s)).not.toContain("card");
        }
    });

    it("takes no sentence, no name of an agent and no plan reading as input", () => {
        const input: SceneInput = {
            situation: situation(),
            now: Day,
            memory: EmptyMood,
            facts: facts(),
            badge: { count: 0, tone: "waiting", text: "" },
            asked: null,
            speaking: false,
            motion: true,
            pinned: false,
            lastKeyAt: null,
            workingSince: 0,
        };
        expect(Object.keys(input).sort()).toEqual(
            [
                "situation",
                "now",
                "memory",
                "facts",
                "badge",
                "asked",
                "speaking",
                "motion",
                "pinned",
                "lastKeyAt",
                "workingSince",
            ].sort()
        );
        const source = readFileSync(join(__dirname, "brokk-scene.ts"), "utf8").replace(/\/\/.*$/gm, "");
        expect(source).not.toContain("boss.screen.");
        expect(source).not.toContain("ScreenCaption");
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
});

describe("the scene, in general (#1959)", () => {
    it("shows a gesture only while its clip lasts", () => {
        const asked = { expression: "smile" as const, cue: 1, at: Day };
        expect(scene({ asked, now: Day + ExpressionMs.smile - 1 }).gesture).toBe("smile");
        expect(scene({ asked, now: Day + ExpressionMs.smile }).gesture).toBeNull();
    });

    it("shows the domino exactly while agents work", () => {
        for (const working of [0, 1, 3]) {
            expect(scene({ situation: situation({ working }) }).loader).toBe(working > 0);
        }
    });

    it("says when it changes by itself: a wait that crosses a limit, a gesture that ends, the night", () => {
        expect(scene().until).toBe(new Date(2026, 10, 6, 23, 0, 0).getTime());
        const waiting = scene({
            situation: situation({ waiting: 1 }),
            facts: facts({ waiting: 1, oldest: { key: "agent:a", name: "O", since: Day - 3 * Min, agent: true } }),
        });
        expect(waiting.until).toBe(Day - 3 * Min + 10 * Min);
        const gesture = scene({ asked: { expression: "nod", cue: 1, at: Day } });
        expect(gesture.until).toBe(Day + ExpressionMs.nod);
    });

    it("does not wake itself for a mention it no longer makes", () => {
        const handled = memoryAfter([[{ type: "handled", kind: "answer" }, Day]]);
        const cleared = memoryAfter([[{ type: "cleared" }, Day]]);
        const nightFall = new Date(2026, 10, 6, 23, 0, 0).getTime();
        expect(scene({ memory: handled }).until).toBe(nightFall);
        expect(scene({ memory: cleared }).until).toBe(Day + SatisfiedMs);
    });
});
