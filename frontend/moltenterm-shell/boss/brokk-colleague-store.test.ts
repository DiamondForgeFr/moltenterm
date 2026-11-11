// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The window's side of Brokk as a kind colleague (FR-BOSS-009, AC72 to AC77, #2203). A fake clock, a fake model and a fake
// meta: nothing here waits, and no model is ever called.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const Sources = vi.hoisted(() => ({
    store: null as any,
    proximity: null as any,
    agents: null as any,
    call: null as any,
    client: null as any,
    clientId: "client-1" as string,
    setMeta: null as any,
}));
vi.mock("@/app/store/jotaiStore", async () => {
    Sources.store = (await import("jotai")).createStore();
    return { globalStore: Sources.store };
});
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    Sources.proximity = atom("colleague");
    return { globalStore: Sources.store, getSettingsKeyAtom: () => Sources.proximity };
});
vi.mock("@/app/store/wshrpcutil", () => {
    Sources.call = vi.fn();
    return { TabRpcClient: { wshRpcCall: (...args: unknown[]) => Sources.call(...args) } };
});
vi.mock("@/app/store/client-model", async () => {
    const { atom } = await import("jotai");
    Sources.client = atom({ meta: {} as Record<string, unknown> });
    return { ClientModel: { getInstance: () => ({ clientAtom: Sources.client, clientId: Sources.clientId }) } };
});
vi.mock("@/app/store/wos", () => ({ makeORef: (type: string, id: string) => `${type}:${id}` }));
vi.mock("@/app/store/wshclientapi", () => {
    Sources.setMeta = vi.fn(async () => {});
    return { RpcApi: { SetMetaCommand: (...args: unknown[]) => Sources.setMeta(...args) } };
});
vi.mock("@/util/util", () => ({ fireAndForget: (run: () => Promise<unknown>) => void run() }));
vi.mock("../tab-activity", () => ({
    TabActivity: { getInstance: () => ({ every: () => () => {} }) },
    whileShown: (ms: number) => ({ active: ms }),
}));
vi.mock("../agent-state-store", async () => {
    const { atom } = await import("jotai");
    Sources.agents = atom({ states: {}, versions: {} } as any);
    return { AgentStates: { getInstance: () => ({ dataAtom: Sources.agents }) } };
});

import { globalStore } from "@/app/store/jotaiStore";
import type { MomentKind, Proximity } from "./brokk-colleague";
import { BreakAfterMs, currentMoment, MaxModelCallsPerDay, momentLine, TickMs } from "./brokk-colleague";
import {
    BrokkColleagueModel,
    ColleagueMetaKey,
    InputEveryMs,
    PhraseAnswer,
    PhraseCommand,
    PhraseRequest,
    PhraseRouteId,
    PhraseTimeoutMs,
    WriteEchoMs,
} from "./brokk-colleague-store";

const Min = 60 * 1000;
const Hour = 60 * Min;
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute, 0).getTime();

// The client's meta, as the model reads and writes it. `late`: a write comes back only when the test says so, as the
// echo of a real one does.
class FakeMeta {
    text: string = null;
    writes: string[] = [];
    late = false;
    private echoed: string = null;
    read() {
        return this.late ? this.echoed : this.text;
    }
    write(text: string) {
        this.writes.push(text);
        this.text = text;
        if (!this.late) {
            this.echoed = text;
        }
    }
    echo() {
        this.echoed = this.text;
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
    model: BrokkColleagueModel;
    meta: FakeMeta;
    clock: { now: number };
    asked: PhraseRequest[];
    answer: { next: () => Promise<PhraseAnswer> };
    working: { count: number };
    ticks: ReturnType<typeof ticker>;
    // This computer's idle time, in seconds; null where it cannot be read.
    idle: { sec: number };
    advance: (ms: number) => void;
};

// Settles the promises the model awaits (the answer of the fake model) without any wait.
const flush = async () => {
    for (let i = 0; i < 5; i++) {
        await Promise.resolve();
    }
};

function rig(start: number, meta: FakeMeta = new FakeMeta()): Rig {
    BrokkColleagueModel.resetInstance();
    const model = BrokkColleagueModel.getInstance();
    const clock = { now: start };
    const asked: PhraseRequest[] = [];
    const answer = { next: async (): Promise<PhraseAnswer> => ({ status: "none" }) };
    const working = { count: 0 };
    const ticks = ticker();
    const idle = { sec: null as number };
    model.useDeps({
        idleSec: async () => idle.sec,
        now: () => clock.now,
        every: ticks.every,
        random: () => 0.5,
        read: () => meta.read(),
        write: (text) => meta.write(text),
        ask: (request) => {
            asked.push(request);
            return answer.next();
        },
        language: () => "fr",
        proximity: () => globalStore.get(Sources.proximity) as Proximity,
        working: () => working.count,
    });
    return {
        model,
        meta,
        clock,
        asked,
        answer,
        working,
        ticks,
        idle,
        advance: (ms) => {
            clock.now += ms;
        },
    };
}

function moments(kind?: MomentKind) {
    return globalStore
        .get(BrokkColleagueModel.getInstance().momentsAtom)
        .filter((m) => kind == null || m.kind === kind);
}

// The developer is active from the clock's now for `ms`, one input every minute.
function type(r: Rig, ms: number) {
    for (let spent = 0; spent <= ms; spent += Min) {
        r.model.noteInput();
        r.advance(Min);
    }
}

beforeEach(() => {
    globalStore.set(Sources.proximity, "colleague");
    Sources.call.mockReset();
});

afterEach(() => {
    BrokkColleagueModel.resetInstance();
    vi.useRealTimers();
});

describe("the hello, the nudge and the hand-over, from the developer's inputs (FR-BOSS-009, AC72)", () => {
    it("greets the first input of the day, once, and keeps the day across a restart", () => {
        const first = rig(at(10, 8, 0));
        first.model.noteInput();
        expect(moments("hello")).toHaveLength(1);
        expect(first.meta.text).toContain('"helloDay":"2026-11-10"');

        const second = rig(at(10, 12, 0), first.meta);
        second.model.noteInput();
        expect(moments("hello")).toHaveLength(0);
        const nextDay = rig(at(11, 8, 0), first.meta);
        nextDay.model.noteInput();
        expect(moments("hello")).toHaveLength(1);
    });

    // #2216 (audit #2214, C1, AC-1): the build restarted at 00:35 greeted its first input, the computer slept, and the
    // morning found the day already greeted.
    it("greets the morning after a restart at half past midnight, not the restart", async () => {
        const evening = rig(at(10, 23, 30));
        type(evening, 60 * Min);
        const restarted = rig(at(11, 0, 35), evening.meta);
        restarted.model.noteInput();
        expect(moments("hello")).toHaveLength(0);
        restarted.clock.now = at(11, 8, 58);
        restarted.model.noteInput();
        expect(moments("hello")).toHaveLength(1);
        expect(moments("hello")[0].set).toBe("hello.morning");
    });

    // #2216 (AC-2): the tab view on screen is rebuilt after a wake; it used to take its empty memory for a night.
    it("raises no hello in a view rebuilt after a wake while the developer is at work", async () => {
        // A night of work from the evening: the evening's hello said, none owed past midnight.
        const working = rig(at(10, 22, 0));
        type(working, 7 * Hour + 10 * Min);
        const rebuilt = rig(at(11, 5, 25), working.meta);
        rebuilt.idle.sec = 20;
        rebuilt.model.start();
        await flush();
        rebuilt.model.noteInput();
        expect(moments("hello")).toHaveLength(0);
    });

    it("greets a return the idle time saw before any input in a view, and says it once", async () => {
        const evening = rig(at(10, 18, 0));
        evening.model.noteInput();
        evening.model.noteSeen(moments("hello")[0].id);
        const morning = rig(at(11, 8, 58), evening.meta);
        morning.idle.sec = 5;
        morning.model.tick();
        await flush();
        expect(moments("hello")).toHaveLength(1);
        morning.advance(Min);
        morning.model.noteInput();
        expect(moments("hello")).toHaveLength(1);
    });

    it("saves the last presence at most once a minute", () => {
        const r = rig(at(10, 9, 0));
        r.model.noteInput();
        const writes = r.meta.writes.length;
        for (let i = 0; i < 20; i++) {
            r.advance(2 * 1000);
            r.model.noteInput();
        }
        expect(r.meta.writes.length - writes).toBeLessThanOrEqual(1);
    });

    it("tells his model the part of the day of a hello", async () => {
        const r = rig(at(10, 5, 30));
        r.model.noteInput();
        await flush();
        expect(r.asked[0]).toMatchObject({ kind: "hello", part: "early", clock: "05:30" });
    });

    // The pages' localStorage is gone at every restart (#1763): the day greeted lives in the client's meta.
    it("keeps nothing in the pages' localStorage", () => {
        const source = readFileSync(join(__dirname, "brokk-colleague-store.ts"), "utf8").replace(/\/\/.*$/gm, "");
        expect(source).not.toMatch(/\blocalStorage\b|\bsessionStorage\b/);
        expect(ColleagueMetaKey).toBe("moltenterm:brokkcolleague");
    });

    it("does not say the same hello in each window of the computer: they share what was said", () => {
        const meta = new FakeMeta();
        const r = rig(at(10, 8, 0), meta);
        // This window was open already and read the meta empty...
        r.model.tick();
        // ...then another window greeted at its first input and saved the day.
        meta.text = JSON.stringify({
            helloDay: "2026-11-10",
            last: { "hello.morning": 3 },
            handoverEvening: "",
            modelDay: "",
            modelCalls: 0,
        });
        r.model.noteInput();
        expect(moments("hello")).toHaveLength(0);
        // The next day it greets, and not with the phrasing the other window used last.
        r.advance(24 * Hour);
        r.model.noteInput();
        expect(moments("hello")[0].index).not.toBe(3);
    });

    it("does not take an older meta for another window's while its own write has not come back", () => {
        const meta = new FakeMeta();
        meta.late = true;
        const r = rig(at(10, 8, 0), meta);
        r.model.noteInput();
        expect(moments("hello")).toHaveLength(1);
        // The write is on its way: the meta still reads empty, and a later input must not forget the day greeted.
        r.advance(5 * Hour);
        r.model.noteInput();
        expect(moments("hello")).toHaveLength(0);
        expect(meta.writes.length).toBeGreaterThan(0);
        meta.echo();
        r.advance(Hour);
        r.model.noteInput();
        expect(moments("hello")).toHaveLength(0);
    });

    it("stops waiting for a write that never came back, so that it cannot hide the other windows'", () => {
        const meta = new FakeMeta();
        meta.late = true;
        const r = rig(at(10, 8, 0), meta);
        r.model.noteInput();
        r.advance(WriteEchoMs + Min);
        meta.text = JSON.stringify({
            helloDay: "2026-11-10",
            last: { "hello.morning": 2 },
            handoverEvening: "2026-11-09",
            modelDay: "",
            modelCalls: 0,
        });
        meta.echo();
        r.model.noteInput();
        // Taken: the next day's hello avoids the phrasing the other window said last (with 2 said, the middle pick is 3;
        // without it, the middle pick of the five would be 2).
        r.advance(24 * Hour);
        r.model.noteInput();
        expect(moments("hello")[0].index).toBe(3);
    });

    it("reads many inputs a second as one: the pointer moves by the hundred", () => {
        const r = rig(at(10, 8, 0));
        r.model.noteInput();
        const before = globalStore.get(r.model.momentsAtom);
        for (let i = 0; i < 100; i++) {
            r.advance(5);
            r.model.noteInput();
        }
        expect(globalStore.get(r.model.momentsAtom)).toBe(before);
        r.advance(InputEveryMs);
        r.model.noteInput();
        expect(globalStore.get(r.model.momentsAtom)).toBe(before);
    });

    it("nudges after two hours of continuous activity, once, with no wall-clock wait", () => {
        const r = rig(at(10, 9, 0));
        type(r, BreakAfterMs - 5 * Min);
        expect(moments("break")).toHaveLength(0);
        type(r, 10 * Min);
        expect(moments("break")).toHaveLength(1);
        const [nudge] = moments("break");
        // Three more hours without a pause: it lapses unseen, and the same stretch never nudges twice.
        type(r, 3 * Hour);
        expect(moments("break").filter((moment) => moment.id === nudge.id)).toHaveLength(0);
        expect(moments("break")).toHaveLength(0);
        expect(r.asked.filter((request) => request.kind === "break")).toHaveLength(1);
    });

    it("hands over in the evening while agents work, and not without them", () => {
        const idle = rig(at(10, 21, 30));
        idle.model.noteInput();
        expect(moments("handover")).toHaveLength(0);
        const busy = rig(at(10, 21, 30));
        busy.working.count = 2;
        busy.model.noteInput();
        expect(moments("handover")).toHaveLength(1);
        expect(busy.meta.text).toContain('"handoverEvening":"2026-11-10"');
    });

    it("shows a moment once: after the group saw it and closed, it is gone", () => {
        const r = rig(at(10, 8, 0));
        r.model.noteInput();
        const [hello] = moments("hello");
        r.model.noteShown(hello.id);
        expect(currentMoment(moments()).shownAt).toBe(at(10, 8, 0));
        r.model.noteSeen(hello.id);
        expect(moments()).toHaveLength(0);
    });

    it("is raised by the clock alone while the developer is active, and lapses by it too", () => {
        const r = rig(at(10, 9, 0));
        const stop = r.model.start();
        r.model.noteInput();
        for (let i = 0; i < 119; i++) {
            r.advance(Min);
            r.model.noteInput();
        }
        expect(moments("break")).toHaveLength(0);
        // The last input was a minute ago and the stretch reached its length: the clock tells it, with no input.
        r.advance(Min);
        r.ticks.fire();
        expect(moments("break")).toHaveLength(1);
        r.advance(20 * Min);
        r.ticks.fire();
        expect(moments("break")).toHaveLength(0);
        stop();
    });

    it("stops its timer and its listening when the bubble goes", () => {
        const r = rig(at(10, 9, 0));
        const tick = vi.spyOn(r.model, "tick");
        const stop = r.model.start();
        expect(r.ticks.periods).toEqual([TickMs]);
        r.ticks.fire();
        r.ticks.fire();
        expect(tick).toHaveBeenCalledTimes(2);
        stop();
        expect(r.ticks.count()).toBe(0);
        globalStore.set(Sources.agents, { states: {}, versions: {} });
        globalStore.set(Sources.proximity, "discreet");
        expect(tick).toHaveBeenCalledTimes(2);
    });

    it("looks again when the agents change or the developer moves the setting", () => {
        const r = rig(at(10, 9, 0));
        const tick = vi.spyOn(r.model, "tick");
        const stop = r.model.start();
        globalStore.set(Sources.agents, { states: { a: { state: "working" } }, versions: {} });
        globalStore.set(Sources.proximity, "discreet");
        expect(tick).toHaveBeenCalledTimes(2);
        stop();
    });
});

describe("Discreet (FR-BOSS-009, AC75)", () => {
    it("raises no moment and asks no model, whatever the day brings", async () => {
        globalStore.set(Sources.proximity, "discreet");
        const r = rig(at(10, 21, 30));
        r.working.count = 3;
        type(r, 3 * Hour);
        await flush();
        expect(moments()).toHaveLength(0);
        expect(r.asked).toEqual([]);
    });

    it("drops the moments that wait the moment the developer chooses it", () => {
        const r = rig(at(10, 8, 0));
        const stop = r.model.start();
        r.model.noteInput();
        expect(moments()).toHaveLength(1);
        globalStore.set(Sources.proximity, "discreet");
        expect(moments()).toHaveLength(0);
        stop();
    });

    it("greets again, the day long, once he comes closer", () => {
        globalStore.set(Sources.proximity, "discreet");
        const r = rig(at(10, 8, 0));
        r.model.noteInput();
        expect(moments()).toHaveLength(0);
        globalStore.set(Sources.proximity, "colleague");
        r.advance(5 * Hour);
        r.model.noteInput();
        expect(moments("hello")).toHaveLength(1);
    });
});

// FR-BOSS-009, AC77: the model phrases a moment within strict limits and the written phrasing is always the fallback.
describe("his model phrases a moment (FR-BOSS-009, AC77)", () => {
    it("is asked once for a moment, and shows its line when it arrives before the moment is shown", async () => {
        const r = rig(at(10, 8, 15));
        r.answer.next = async () => ({ status: "line", line: "Morning. The fire is lit, tools are out." });
        r.model.noteInput();
        expect(r.asked).toEqual([{ kind: "hello", language: "fr", clock: "08:15", part: "morning" }]);
        await flush();
        expect(momentLine(moments("hello")[0])).toEqual({ text: "Morning. The fire is lit, tools are out." });
    });

    it("tells him only the local signals: the time, the language, how long the stretch lasted and how many agents run", async () => {
        const r = rig(at(10, 21, 0));
        r.working.count = 3;
        r.model.noteInput();
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
        r.model.noteInput();
        const [hello] = moments("hello");
        r.model.noteShown(hello.id);
        arrive({ status: "line", line: "A line that comes too late." });
        await flush();
        expect(momentLine(moments("hello")[0])).toEqual({
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
        for (const [i, answer] of answers.entries()) {
            const r = rig(at(10 + (i % 15), 8, 0));
            r.answer.next = answer;
            r.model.noteInput();
            await flush();
            expect(r.asked, `answer ${i}`).toHaveLength(1);
            expect(momentLine(moments("hello")[0]), `answer ${i}`).toEqual({
                key: expect.stringMatching(/^boss\.moment\.hello\.morning\.p[1-5]$/),
            });
        }
    });

    it("never blocks: a model that never answers leaves the written phrasing in place at once", () => {
        const r = rig(at(10, 8, 0));
        r.answer.next = () => new Promise<PhraseAnswer>(() => {});
        r.model.noteInput();
        expect(momentLine(moments("hello")[0]).key).toMatch(/^boss\.moment\.hello\.morning\.p[1-5]$/);
        expect(r.asked).toHaveLength(1);
    });

    it("is asked at most five times a day, then writes the moments itself, and starts again the next day", async () => {
        // Just after midnight, so that six stretches of work fit in the one day the limit counts.
        const r = rig(at(10, 0, 10));
        r.answer.next = async () => ({ status: "none" });
        // Each pause of half an hour ends a stretch; two hours of work make a nudge: one question each time.
        let start = at(10, 0, 10);
        for (let i = 0; i < MaxModelCallsPerDay + 1; i++) {
            r.clock.now = start;
            type(r, BreakAfterMs + 5 * Min);
            start = r.clock.now + 30 * Min;
            await flush();
        }
        expect(r.asked.length).toBe(MaxModelCallsPerDay);
        expect(JSON.parse(r.meta.text).modelCalls).toBe(MaxModelCallsPerDay);
        const tomorrow = rig(at(11, 8, 0), r.meta);
        tomorrow.model.noteInput();
        expect(tomorrow.asked).toHaveLength(1);
    });

    it("goes on when the meta refuses: it only costs a second greeting after a restart", async () => {
        const refusing = new FakeMeta();
        refusing.read = () => {
            throw new Error("blocked");
        };
        refusing.write = () => {
            throw new Error("blocked");
        };
        const r = rig(at(10, 8, 0), refusing);
        r.model.noteInput();
        await flush();
        expect(moments("hello")).toHaveLength(1);
        expect(r.asked).toHaveLength(1);
    });

    // The meta of the client is what the pages share and what survives a restart (#1763).
    it("saves what has to outlive a run in the client's meta, and reads it back from there", () => {
        BrokkColleagueModel.resetInstance();
        const live = BrokkColleagueModel.getInstance();
        const clock = { now: at(10, 8, 0) };
        Sources.setMeta.mockClear();
        globalStore.set(Sources.client, { meta: {} });
        live.useDeps({ now: () => clock.now, working: () => 0 });
        live.noteInput();
        // One write when the hello is raised, one when his model is asked for it: the last holds both.
        expect(Sources.setMeta).toHaveBeenCalledTimes(2);
        const [, data] = Sources.setMeta.mock.calls[1];
        expect(data.oref).toBe("client:client-1");
        expect(Object.keys(data.meta)).toEqual([ColleagueMetaKey]);
        expect(JSON.parse(data.meta[ColleagueMetaKey]).helloDay).toBe("2026-11-10");

        // After a restart the client's meta still holds it: no second hello that day.
        BrokkColleagueModel.resetInstance();
        const restarted = BrokkColleagueModel.getInstance();
        globalStore.set(Sources.client, { meta: { [ColleagueMetaKey]: data.meta[ColleagueMetaKey] } });
        restarted.useDeps({ now: () => clock.now + 3 * Hour, working: () => 0 });
        restarted.noteInput();
        expect(moments("hello")).toHaveLength(0);
    });

    it("writes nothing while the client is not known yet, and reads a meta that is not text as nothing", () => {
        BrokkColleagueModel.resetInstance();
        const live = BrokkColleagueModel.getInstance();
        Sources.setMeta.mockClear();
        Sources.clientId = null;
        globalStore.set(Sources.client, { meta: { [ColleagueMetaKey]: 42 } });
        live.useDeps({ now: () => at(10, 8, 0), working: () => 0 });
        live.noteInput();
        expect(Sources.setMeta).not.toHaveBeenCalled();
        expect(moments("hello")).toHaveLength(1);
        Sources.clientId = "client-1";
    });

    it("reaches his session's route with the command and a timeout longer than wavesrv's own", async () => {
        BrokkColleagueModel.resetInstance();
        const live = BrokkColleagueModel.getInstance();
        const clock = { now: at(10, 8, 0) };
        const meta = new FakeMeta();
        live.useDeps({
            now: () => clock.now,
            read: () => meta.read(),
            write: (text) => meta.write(text),
            working: () => 0,
        });
        Sources.call.mockResolvedValue({ status: "line", line: "Good morning, colleague, ready?" });
        live.noteInput();
        await flush();
        expect(Sources.call).toHaveBeenCalledTimes(1);
        const [command, request, options] = Sources.call.mock.calls[0];
        expect(command).toBe(PhraseCommand);
        expect(request).toMatchObject({ kind: "hello", clock: "08:00" });
        expect(options).toEqual({ route: PhraseRouteId, timeout: PhraseTimeoutMs });
        expect(PhraseCommand).toBe("moltenbrokkphrase");
        expect(PhraseRouteId).toBe("molten:brokk");
        expect(PhraseTimeoutMs).toBeGreaterThan(25_000);
    });
});
