// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk as a kind colleague, owned once by Electron main (FR-BOSS-009, AC72 to AC77, #2203, #2221). A fake clock, a fake
// model and a fake meta: nothing here waits, and no model is ever called.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { MomentKind, Proximity } from "../frontend/moltenterm-shell/boss/brokk-colleague";
import { BreakAfterMs, currentMoment, momentLine, TickMs } from "../frontend/moltenterm-shell/boss/brokk-colleague";
import { MomentsUpdate, PageFacts } from "../frontend/moltenterm-shell/boss/brokk-colleague-wire";
import {
    ColleagueMetaKey,
    ColleagueOwner,
    makeSerialWriter,
    PhraseAnswer,
    PhraseCommand,
    PhraseRequest,
    PhraseRouteId,
    PhraseTimeoutMs,
} from "./moltenterm-colleague-owner";

const Min = 60 * 1000;
const Hour = 60 * Min;
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute, 0).getTime();

// The client's meta, as the owner writes it.
class FakeMeta {
    text: string = null;
    writes: string[] = [];
    write(text: string) {
        this.writes.push(text);
        this.text = text;
    }
}

// The app's scheduler, ticked by hand: no clock, no timer.
function ticker() {
    const jobs = new Set<() => void>();
    const periods: number[] = [];
    return {
        periods,
        every: (ms: number, run: () => void) => {
            periods.push(ms);
            jobs.add(run);
            return () => jobs.delete(run);
        },
        fire: () => [...jobs].forEach((run) => run()),
        count: () => jobs.size,
    };
}

type Rig = {
    owner: ColleagueOwner;
    meta: FakeMeta;
    clock: { now: number };
    asked: PhraseRequest[];
    answer: { next: () => Promise<PhraseAnswer> };
    // What the pages say about themselves: the agents at work, the setting, the language.
    facts: PageFacts;
    ticks: ReturnType<typeof ticker>;
    published: MomentsUpdate[];
    // This computer's idle time, in seconds; null where it cannot be read.
    idle: { sec: number };
    advance: (ms: number) => void;
    // An input of the developer, with the facts of the page it comes from.
    input: () => void;
    moments: (kind?: MomentKind) => ReturnType<ColleagueOwner["update"]>["moments"];
};

// Settles the promises the owner awaits (the answer of the fake model) without any wait.
const flush = async () => {
    for (let i = 0; i < 5; i++) {
        await Promise.resolve();
    }
};

function rig(start: number, meta: FakeMeta = new FakeMeta(), proximity: Proximity = "colleague"): Rig {
    const clock = { now: start };
    const asked: PhraseRequest[] = [];
    const answer = { next: async (): Promise<PhraseAnswer> => ({ status: "none" }) };
    const ticks = ticker();
    const idle = { sec: null as number };
    const published: MomentsUpdate[] = [];
    const facts: PageFacts = { working: 0, proximity, language: "fr" };
    const owner = new ColleagueOwner(
        {
            idleSec: async () => idle.sec,
            now: () => clock.now,
            every: ticks.every,
            random: () => 0.5,
            write: (text) => meta.write(text),
            ask: (request) => {
                asked.push(request);
                return answer.next();
            },
            publish: (update) => published.push(update),
        },
        meta.text
    );
    owner.setFacts({ ...facts });
    return {
        owner,
        meta,
        clock,
        asked,
        answer,
        facts,
        ticks,
        published,
        idle,
        advance: (ms) => {
            clock.now += ms;
        },
        input: () => owner.noteInput({ ...facts }),
        moments: (kind) => owner.update().moments.filter((m) => kind == null || m.kind === kind),
    };
}

// The developer is active from the clock's now for `ms`, one input every minute.
function type(r: Rig, ms: number) {
    for (let spent = 0; spent <= ms; spent += Min) {
        r.input();
        r.advance(Min);
    }
}

describe("the hello, the nudge and the hand-over, from the developer's inputs (FR-BOSS-009, AC72)", () => {
    it("greets the first input of the day, once, and keeps the day across a restart", () => {
        const first = rig(at(10, 8, 0));
        first.input();
        expect(first.moments("hello")).toHaveLength(1);
        // #2217: the day is greeted once the line was on screen.
        expect(first.meta.text).toContain('"helloDay":""');
        first.owner.noteShown(first.moments("hello")[0].id);
        expect(first.meta.text).toContain('"helloDay":"2026-11-10"');

        const second = rig(at(10, 12, 0), first.meta);
        second.input();
        expect(second.moments("hello")).toHaveLength(0);
        const nextDay = rig(at(11, 8, 0), first.meta);
        nextDay.input();
        expect(nextDay.moments("hello")).toHaveLength(1);
    });

    // #2216 (audit #2214, C1, AC-1): the build restarted at 00:35 greeted its first input, the computer slept, and the
    // morning found the day already greeted.
    it("greets the morning after a restart at half past midnight, not the restart", () => {
        const evening = rig(at(10, 23, 30));
        type(evening, 60 * Min);
        const restarted = rig(at(11, 0, 35), evening.meta);
        restarted.input();
        expect(restarted.moments("hello")).toHaveLength(0);
        restarted.clock.now = at(11, 8, 58);
        restarted.input();
        expect(restarted.moments("hello")).toHaveLength(1);
        expect(restarted.moments("hello")[0].set).toBe("hello.morning");
    });

    // #2216 (AC-2): after a wake, the view that shows is often built anew; it used to take its empty memory for a night.
    it("raises no hello for a developer who is at work, whichever view is rebuilt", async () => {
        const working = rig(at(10, 22, 0));
        type(working, 7 * Hour + 10 * Min);
        const rebuilt = rig(at(11, 5, 25), working.meta);
        rebuilt.idle.sec = 20;
        rebuilt.owner.setListening(true);
        await flush();
        rebuilt.input();
        expect(rebuilt.moments("hello")).toHaveLength(0);
    });

    it("greets a return the idle time saw before any input in a view, and says it once", async () => {
        const evening = rig(at(10, 18, 0));
        evening.input();
        evening.owner.noteSeen(evening.moments("hello")[0].id);
        const morning = rig(at(11, 8, 58), evening.meta);
        morning.idle.sec = 5;
        morning.owner.tick();
        await flush();
        expect(morning.moments("hello")).toHaveLength(1);
        morning.advance(Min);
        morning.input();
        expect(morning.moments("hello")).toHaveLength(1);
    });

    it("saves the last presence at most once a minute", () => {
        const r = rig(at(10, 9, 0));
        r.input();
        const writes = r.meta.writes.length;
        for (let i = 0; i < 20; i++) {
            r.advance(2 * 1000);
            r.input();
        }
        expect(r.meta.writes.length - writes).toBeLessThanOrEqual(1);
    });

    it("tells his model the part of the day of a hello", async () => {
        const r = rig(at(10, 5, 30));
        r.input();
        await flush();
        expect(r.asked[0]).toMatchObject({ kind: "hello", part: "early", clock: "05:30" });
    });

    // The pages' localStorage is gone at every restart (#1763): the day greeted lives in the client's meta, and no page
    // keeps a run of its own.
    it("keeps nothing in the pages' localStorage", () => {
        const sources = [
            join(__dirname, "moltenterm-colleague-owner.ts"),
            join(__dirname, "moltenterm-colleague.ts"),
            join(__dirname, "../frontend/moltenterm-shell/boss/brokk-colleague-store.ts"),
        ];
        for (const file of sources) {
            const source = readFileSync(file, "utf8").replace(/\/\/.*$/gm, "");
            expect(source, file).not.toMatch(/\blocalStorage\b|\bsessionStorage\b/);
        }
        expect(ColleagueMetaKey).toBe("moltenterm:brokkcolleague");
    });

    it("nudges after two hours of continuous activity, once, with no wall-clock wait", () => {
        const r = rig(at(10, 9, 0));
        type(r, BreakAfterMs - 5 * Min);
        expect(r.moments("break")).toHaveLength(0);
        type(r, 10 * Min);
        expect(r.moments("break")).toHaveLength(1);
        const [nudge] = r.moments("break");
        // Three more hours without a pause: it lapses unseen, and the same stretch never nudges twice.
        type(r, 3 * Hour);
        expect(r.moments("break").filter((moment) => moment.id === nudge.id)).toHaveLength(0);
        expect(r.moments("break")).toHaveLength(0);
        expect(r.asked.filter((request) => request.kind === "break")).toHaveLength(1);
    });

    it("hands over in the evening while agents work, and not without them", () => {
        const idle = rig(at(10, 21, 30));
        idle.input();
        expect(idle.moments("handover")).toHaveLength(0);
        const busy = rig(at(10, 21, 30));
        busy.facts.working = 2;
        busy.input();
        expect(busy.moments("handover")).toHaveLength(1);
        expect(busy.meta.text).toContain('"handoverEvening":"2026-11-10"');
    });

    it("shows a moment once: after the group saw it and closed, it is gone", () => {
        const r = rig(at(10, 8, 0));
        r.input();
        const [hello] = r.moments("hello");
        r.owner.noteShown(hello.id);
        expect(currentMoment(r.moments()).shownAt).toBe(at(10, 8, 0));
        r.owner.noteSeen(hello.id);
        expect(r.moments()).toHaveLength(0);
    });

    it("is raised by the clock alone while the developer is active, and lapses by it too", () => {
        const r = rig(at(10, 9, 0));
        r.owner.setListening(true);
        r.input();
        for (let i = 0; i < 119; i++) {
            r.advance(Min);
            r.input();
        }
        expect(r.moments("break")).toHaveLength(0);
        // The last input was a minute ago and the stretch reached its length: the clock tells it, with no input.
        r.advance(Min);
        r.ticks.fire();
        expect(r.moments("break")).toHaveLength(1);
        r.advance(20 * Min);
        r.ticks.fire();
        expect(r.moments("break")).toHaveLength(0);
    });

    it("runs its clock while a window listens, and stops it when the last one goes", () => {
        const r = rig(at(10, 9, 0));
        const tick = vi.spyOn(r.owner, "tick");
        r.owner.setListening(true);
        r.owner.setListening(true);
        expect(r.ticks.periods).toEqual([TickMs]);
        r.ticks.fire();
        r.ticks.fire();
        expect(tick).toHaveBeenCalledTimes(2);
        r.owner.setListening(false);
        expect(r.ticks.count()).toBe(0);
        r.owner.setListening(false);
    });

    it("looks again when the agents change or the developer moves the setting", () => {
        // An evening of work with no agent: nothing to hand over.
        const r = rig(at(10, 21, 30));
        r.input();
        expect(r.moments("handover")).toHaveLength(0);
        r.owner.setFacts({ ...r.facts, working: 2 });
        expect(r.moments("handover")).toHaveLength(1);
        r.owner.setFacts({ ...r.facts, working: 2, proximity: "discreet" });
        expect(r.moments()).toHaveLength(0);
    });

    it("tells the windows every change of the moments, in order, and nothing when they stay", () => {
        const r = rig(at(10, 8, 0));
        r.input();
        const [hello] = r.moments("hello");
        r.advance(2000);
        r.input();
        r.owner.noteShown(hello.id);
        r.owner.noteSeen(hello.id);
        expect(r.published.map((update) => update.moments.length)).toEqual([1, 1, 0]);
        const revs = r.published.map((update) => update.rev);
        expect(revs).toEqual([...revs].sort((a, b) => a - b));
        expect(new Set(revs).size).toBe(revs.length);
        expect(r.owner.update().rev).toBe(revs[revs.length - 1]);
    });
});

describe("Discreet (FR-BOSS-009, AC75)", () => {
    it("raises no moment and asks no model, whatever the day brings", async () => {
        const r = rig(at(10, 21, 30), new FakeMeta(), "discreet");
        r.facts.working = 3;
        type(r, 3 * Hour);
        await flush();
        expect(r.moments()).toHaveLength(0);
        expect(r.asked).toEqual([]);
    });

    it("drops the moments that wait the moment the developer chooses it", () => {
        const r = rig(at(10, 8, 0));
        r.input();
        expect(r.moments()).toHaveLength(1);
        r.owner.setFacts({ ...r.facts, proximity: "discreet" });
        expect(r.moments()).toHaveLength(0);
    });

    it("greets again, the day long, once he comes closer", () => {
        const r = rig(at(10, 8, 0), new FakeMeta(), "discreet");
        r.input();
        expect(r.moments()).toHaveLength(0);
        r.facts.proximity = "colleague";
        r.advance(5 * Hour);
        r.input();
        expect(r.moments("hello")).toHaveLength(1);
    });
});

// FR-BOSS-009, AC77: the model phrases a moment within strict limits and the written phrasing is always the fallback.
describe("his model phrases a moment (FR-BOSS-009, AC77)", () => {
    it("is asked once for a moment, and shows its line when it arrives before the moment is shown", async () => {
        const r = rig(at(10, 8, 15));
        r.answer.next = async () => ({ status: "line", line: "Morning. The fire is lit, tools are out." });
        r.input();
        expect(r.asked).toEqual([{ kind: "hello", language: "fr", clock: "08:15", part: "morning" }]);
        await flush();
        expect(momentLine(r.moments("hello")[0])).toEqual({ text: "Morning. The fire is lit, tools are out." });
    });

    it("tells him only the local signals: the time, the language, how long the stretch lasted and how many agents run", async () => {
        const r = rig(at(10, 21, 0));
        r.facts.working = 3;
        r.input();
        type(r, 2 * Hour + 5 * Min);
        await flush();
        const byKind = Object.fromEntries(r.asked.map((request) => [request.kind, request]));
        expect(Object.keys(byKind).sort()).toEqual(["break", "handover", "hello"]);
        expect(byKind.hello).toEqual({ kind: "hello", language: "fr", clock: "21:00", part: "back" });
        expect(byKind.handover).toEqual({ kind: "handover", language: "fr", clock: "21:00", agents: 3 });
        expect(Object.keys(byKind.break).sort()).toEqual(["clock", "kind", "language", "workedmin"]);
        expect(byKind.break.workedmin).toBeGreaterThanOrEqual(120);
        for (const request of r.asked) {
            const text = JSON.stringify(request);
            expect(text).not.toMatch(/notification|pull request|ticket|\/Users\/|\.go|\.ts|@/i);
        }
    });

    it("keeps the written phrasing when the line comes after the moment was shown: it never changes under the eyes", async () => {
        const r = rig(at(10, 8, 0));
        let arrive: (answer: PhraseAnswer) => void;
        r.answer.next = () => new Promise<PhraseAnswer>((resolve) => (arrive = resolve));
        r.input();
        const [hello] = r.moments("hello");
        r.owner.noteShown(hello.id);
        arrive({ status: "line", line: "A line that comes too late." });
        await flush();
        expect(momentLine(r.moments("hello")[0])).toEqual({
            key: expect.stringMatching(/^boss\.moment\.hello\.morning\.p\d$/),
        });
    });

    it("falls back to the written phrasing for a model that is not set up, fails, times out or answers badly", async () => {
        const answers: (() => Promise<PhraseAnswer>)[] = [
            async () => ({ status: "none" }),
            async () => ({ status: "line", line: "" }),
            async () => ({ status: "line", line: "Two lines\nof text, here." }),
            async () => ({ status: "line", line: "A **bold** line to rest a bit" }),
            async () => ({ status: "line", line: "Go to https://example.com now" }),
            async () => ({ status: "line", line: "Rest for 5 minutes, please" }),
            async () => ({ status: "line", line: "x".repeat(500) }),
            async () => ({ status: "failed" }),
            async () => null,
            async () => {
                throw new Error("the model timed out");
            },
        ];
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        for (const [i, answer] of answers.entries()) {
            const r = rig(at(10 + (i % 15), 8, 0));
            r.answer.next = answer;
            r.input();
            await flush();
            expect(r.asked, `answer ${i}`).toHaveLength(1);
            expect(momentLine(r.moments("hello")[0]), `answer ${i}`).toEqual({
                key: expect.stringMatching(/^boss\.moment\.hello\.morning\.p[1-5]$/),
            });
        }
        log.mockRestore();
    });

    it("never blocks: a model that never answers leaves the written phrasing in place at once", () => {
        const r = rig(at(10, 8, 0));
        r.answer.next = () => new Promise<PhraseAnswer>(() => {});
        r.input();
        expect(momentLine(r.moments("hello")[0]).key).toMatch(/^boss\.moment\.hello\.morning\.p[1-5]$/);
        expect(r.asked).toHaveLength(1);
    });

    // #2221 (audit #2214, C5): the count of the day lives in wavesrv, where the call is made
    // (pkg/molten/brokksession/phrase.go, TestPhraseDayBudgetHoldsUnderConcurrentCalls). The owner asks for each moment it
    // raises and keeps no count in the meta, so that one change is one write.
    it("asks for each moment it raises, and keeps no count of the calls in the meta", async () => {
        const r = rig(at(10, 0, 10));
        let start = at(10, 0, 10);
        for (let i = 0; i < 6; i++) {
            r.clock.now = start;
            type(r, BreakAfterMs + 5 * Min);
            start = r.clock.now + 30 * Min;
            await flush();
        }
        expect(r.asked.length).toBe(6);
        expect(r.meta.text).not.toMatch(/modelCalls|modelDay/);
    });

    it("goes on when the meta refuses: it only costs a second greeting after a restart", async () => {
        const asked: PhraseRequest[] = [];
        const owner = new ColleagueOwner(
            {
                idleSec: async () => null,
                now: () => at(10, 8, 0),
                every: () => () => {},
                random: () => 0.5,
                write: () => {
                    throw new Error("blocked");
                },
                ask: async (request) => {
                    asked.push(request);
                    return { status: "none" };
                },
                publish: () => {},
            },
            null
        );
        owner.noteInput({ working: 0, proximity: "colleague", language: "fr" });
        await flush();
        expect(owner.update().moments).toHaveLength(1);
        expect(asked).toHaveLength(1);
    });

    it("starts from nothing when the text it was given cannot be read", () => {
        for (const text of ["not json", "null", "42", ""]) {
            const owner = new ColleagueOwner(
                {
                    idleSec: async () => null,
                    now: () => at(10, 8, 0),
                    every: () => () => {},
                    random: () => 0.5,
                    write: () => {},
                    ask: async () => ({ status: "none" }),
                    publish: () => {},
                },
                text
            );
            owner.noteInput({ working: 0, proximity: "colleague", language: "fr" });
            expect(owner.update().moments, text).toHaveLength(1);
        }
    });

    it("reaches his session's route with a command and a timeout longer than wavesrv's own", () => {
        expect(PhraseCommand).toBe("moltenbrokkphrase");
        expect(PhraseRouteId).toBe("molten:brokk");
        expect(PhraseTimeoutMs).toBeGreaterThan(25_000);
    });
});

describe("the owner writes the meta in order, one text at a time (audit #2214, C5, #2221)", () => {
    function transport() {
        const sent: string[] = [];
        const open: { text: string; done: () => void; fail: (e: unknown) => void }[] = [];
        return {
            sent,
            open,
            send: (text: string) => {
                sent.push(text);
                return new Promise<void>((resolve, reject) => open.push({ text, done: resolve, fail: reject }));
            },
        };
    }

    it("sends the first text at once, and the latest of the others when it is answered", async () => {
        const t = transport();
        const write = makeSerialWriter(t.send);
        write("a");
        write("b");
        write("c");
        expect(t.sent).toEqual(["a"]);
        t.open[0].done();
        await flush();
        expect(t.sent).toEqual(["a", "c"]);
        write("d");
        expect(t.sent).toEqual(["a", "c"]);
        t.open[1].done();
        await flush();
        expect(t.sent).toEqual(["a", "c", "d"]);
        t.open[2].done();
        await flush();
        write("e");
        expect(t.sent).toEqual(["a", "c", "d", "e"]);
    });

    it("goes on after a write that failed, and tells the failure", async () => {
        const t = transport();
        const failures: unknown[] = [];
        const write = makeSerialWriter(t.send, (e) => failures.push(e));
        write("a");
        write("b");
        t.open[0].fail(new Error("refused"));
        await flush();
        expect(failures).toHaveLength(1);
        expect(t.sent).toEqual(["a", "b"]);
    });

    it("survives a transport that throws", async () => {
        const failures: unknown[] = [];
        const write = makeSerialWriter(
            () => {
                throw new Error("no client");
            },
            (e) => failures.push(e)
        );
        write("a");
        await flush();
        write("b");
        await flush();
        expect(failures).toHaveLength(2);
    });

    it("makes one write for one change of the colleague", () => {
        const r = rig(at(10, 8, 0));
        r.input();
        r.owner.noteShown(r.moments("hello")[0].id);
        r.owner.noteSeen(r.moments("hello")[0].id);
        // The hello is raised (nothing to keep yet but the last phrasing), then greeted: one text each.
        expect(r.meta.writes).toHaveLength(2);
        expect(new Set(r.meta.writes).size).toBe(2);
    });
});
