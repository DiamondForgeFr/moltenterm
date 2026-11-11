// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The window's side of Brokk as a kind colleague (FR-BOSS-009, AC72 to AC77, #2203, #2221). The run itself is owned once
// by Electron main (emain/moltenterm-colleague-owner.test.ts): here a page tells the owner what the developer does and
// shows what it raises. A fake clock and a fake owner, or the real hub for the tests that play several tabs: nothing here
// waits.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const Sources = vi.hoisted(() => ({
    store: null as any,
    proximity: null as any,
    agents: null as any,
    api: {} as Record<string, any>,
}));
vi.mock("@/app/store/jotaiStore", async () => {
    Sources.store = (await import("jotai")).createStore();
    return { globalStore: Sources.store };
});
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    Sources.proximity = atom("colleague");
    return {
        globalStore: Sources.store,
        getSettingsKeyAtom: () => Sources.proximity,
        getApi: () => Sources.api,
    };
});
vi.mock("../agent-state-store", async () => {
    const { atom } = await import("jotai");
    Sources.agents = atom({ states: {}, versions: {} } as any);
    return { AgentStates: { getInstance: () => ({ dataAtom: Sources.agents }) } };
});

import { globalStore } from "@/app/store/jotaiStore";
import { ColleagueHub } from "../../../emain/moltenterm-colleague-hub";
import { BreakAfterMs, Moment, Proximity } from "./brokk-colleague";
import { BrokkColleagueModel, ColleagueTransport, InputEveryMs } from "./brokk-colleague-store";
import { MomentsUpdate, PageFacts } from "./brokk-colleague-wire";

const Min = 60 * 1000;
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute, 0).getTime();

// Settles the promises a page awaits without any wait.
const flush = async () => {
    for (let i = 0; i < 5; i++) {
        await Promise.resolve();
    }
};

const Facts: PageFacts = { working: 0, proximity: "colleague", language: "fr" };

function aMoment(id: string, partial: Partial<Moment> = {}): Moment {
    return { id, kind: "hello", set: "hello.morning", index: 1, raisedAt: 1, clock: "08:00", ...partial };
}

// A page's model, apart from the singleton: the app has one per page, and a test plays several pages.
function aPage(): BrokkColleagueModel {
    return new (BrokkColleagueModel as unknown as new () => BrokkColleagueModel)();
}

function momentsOf(model: BrokkColleagueModel) {
    return globalStore.get(model.momentsAtom);
}

// What the page sent to the owner, and the owner's side as a stand-in.
function fakeOwner(clock: { now: number }) {
    const sent = {
        starts: [] as PageFacts[],
        stops: 0,
        facts: [] as PageFacts[],
        inputs: [] as PageFacts[],
        shown: [] as string[],
        seen: [] as string[],
    };
    const owner = {
        pageFacts: { ...Facts } as PageFacts,
        startAnswer: { rev: 0, moments: [] } as MomentsUpdate,
        shownAnswer: null as Moment,
        push: null as (update: MomentsUpdate) => void,
        unsubscribed: 0,
    };
    const transport: Partial<ColleagueTransport> = {
        now: () => clock.now,
        facts: () => owner.pageFacts,
        start: async (facts) => {
            sent.starts.push(facts);
            return owner.startAnswer;
        },
        stop: () => {
            sent.stops++;
        },
        sendFacts: (facts) => sent.facts.push(facts),
        sendInput: (facts) => sent.inputs.push(facts),
        shown: (id) => {
            sent.shown.push(id);
            return owner.shownAnswer;
        },
        seen: (id) => sent.seen.push(id),
        onMoments: (callback) => {
            owner.push = callback;
            return () => {
                owner.unsubscribed++;
                owner.push = null;
            };
        },
    };
    return { sent, owner, transport };
}

beforeEach(() => {
    globalStore.set(Sources.proximity, "colleague");
    globalStore.set(Sources.agents, { states: {}, versions: {} });
    Sources.api = {};
});

afterEach(() => {
    BrokkColleagueModel.resetInstance();
    vi.useRealTimers();
});

describe("a page tells the owner what the developer does (FR-BOSS-009, AC72)", () => {
    it("sends an input with the facts only a page knows", () => {
        const clock = { now: at(10, 8, 0) };
        const { sent, owner, transport } = fakeOwner(clock);
        owner.pageFacts = { working: 2, proximity: "discreet", language: "en" };
        const page = aPage();
        page.useTransport(transport);
        page.noteInput();
        expect(sent.inputs).toEqual([{ working: 2, proximity: "discreet", language: "en" }]);
    });

    it("reads many inputs a second as one: the pointer moves by the hundred", () => {
        const clock = { now: at(10, 8, 0) };
        const { sent, transport } = fakeOwner(clock);
        const page = aPage();
        page.useTransport(transport);
        page.noteInput();
        for (let i = 0; i < 100; i++) {
            clock.now += 5;
            page.noteInput();
        }
        expect(sent.inputs).toHaveLength(1);
        clock.now += InputEveryMs;
        page.noteInput();
        expect(sent.inputs).toHaveLength(2);
    });

    it("starts listening, shows the moments the owner answers with, and stops when the bubble goes", async () => {
        const clock = { now: at(10, 8, 0) };
        const { sent, owner, transport } = fakeOwner(clock);
        owner.startAnswer = { rev: 3, moments: [aMoment("hello:1")] };
        const page = aPage();
        page.useTransport(transport);
        const stop = page.start();
        await flush();
        expect(sent.starts).toEqual([Facts]);
        expect(momentsOf(page).map((moment) => moment.id)).toEqual(["hello:1"]);
        owner.push({ rev: 4, moments: [aMoment("hello:1"), aMoment("break:2", { kind: "break" })] });
        expect(momentsOf(page).map((moment) => moment.id)).toEqual(["hello:1", "break:2"]);
        stop();
        expect(sent.stops).toBe(1);
        expect(owner.unsubscribed).toBe(1);
    });

    it("keeps the newer moments when an older update comes after them", async () => {
        const clock = { now: at(10, 8, 0) };
        const { owner, transport } = fakeOwner(clock);
        // The push of revision 5 arrives before the first answer, which was read at revision 4.
        owner.startAnswer = { rev: 4, moments: [aMoment("hello:1")] };
        const page = aPage();
        page.useTransport(transport);
        page.start();
        owner.push({ rev: 5, moments: [] });
        await flush();
        expect(momentsOf(page)).toEqual([]);
        owner.push({ rev: 5, moments: [aMoment("hello:9")] });
        owner.push({ rev: 2, moments: [aMoment("hello:8")] });
        expect(momentsOf(page)).toEqual([]);
    });

    it("ignores an update that is not one", async () => {
        const clock = { now: at(10, 8, 0) };
        const { owner, transport } = fakeOwner(clock);
        const page = aPage();
        page.useTransport(transport);
        page.start();
        await flush();
        for (const update of [null, undefined, {}, { rev: 1 }, { rev: 1, moments: "hello" }, "x"]) {
            owner.push(update as MomentsUpdate);
        }
        expect(momentsOf(page)).toEqual([]);
    });

    it("tells the owner when the agents change or the developer moves the setting, once for each change", () => {
        const clock = { now: at(10, 8, 0) };
        const { sent, owner, transport } = fakeOwner(clock);
        const page = aPage();
        page.useTransport(transport);
        const stop = page.start();
        owner.pageFacts = { ...Facts, working: 2 };
        globalStore.set(Sources.agents, { states: { a: { state: "working" } }, versions: {} });
        globalStore.set(Sources.agents, { states: { a: { state: "working" } }, versions: { a: 2 } });
        expect(sent.facts).toEqual([{ ...Facts, working: 2 }]);
        owner.pageFacts = { ...owner.pageFacts, proximity: "discreet" };
        globalStore.set(Sources.proximity, "discreet");
        expect(sent.facts).toEqual([
            { ...Facts, working: 2 },
            { ...Facts, working: 2, proximity: "discreet" },
        ]);
        stop();
        globalStore.set(Sources.proximity, "colleague");
        globalStore.set(Sources.agents, { states: {}, versions: {} });
        expect(sent.facts).toHaveLength(2);
    });

    it("lives without the owner: a page of the preview or a failed start shows nothing and breaks nothing", async () => {
        const clock = { now: at(10, 8, 0) };
        const { transport } = fakeOwner(clock);
        const page = aPage();
        page.useTransport({
            ...transport,
            start: async () => {
                throw new Error("main is not ready");
            },
            shown: () => {
                throw new Error("main is not ready");
            },
        });
        const stop = page.start();
        await flush();
        expect(momentsOf(page)).toEqual([]);
        expect(page.noteShown("hello:1")).toBeNull();
        stop();
    });
});

describe("the moment on screen (FR-BOSS-009, AC74, #2217)", () => {
    it("takes the moment as the owner gives it back: its words may have changed with the part of the day", async () => {
        const clock = { now: at(10, 8, 0) };
        const { sent, owner, transport } = fakeOwner(clock);
        owner.startAnswer = {
            rev: 1,
            moments: [aMoment("hello:1"), aMoment("break:2", { kind: "break", set: "break" })],
        };
        const page = aPage();
        page.useTransport(transport);
        page.start();
        await flush();
        owner.shownAnswer = aMoment("hello:1", { shownAt: clock.now, set: "hello.lateMorning" });
        expect(page.noteShown("hello:1")).toBe(owner.shownAnswer);
        expect(sent.shown).toEqual(["hello:1"]);
        expect(momentsOf(page)[0]).toBe(owner.shownAnswer);
        expect(momentsOf(page)[1].id).toBe("break:2");
    });

    it("leaves the moment alone when another window has it", async () => {
        const clock = { now: at(10, 8, 0) };
        const { owner, transport } = fakeOwner(clock);
        owner.startAnswer = { rev: 1, moments: [aMoment("hello:1")] };
        const page = aPage();
        page.useTransport(transport);
        page.start();
        await flush();
        const before = momentsOf(page);
        owner.shownAnswer = null;
        expect(page.noteShown("hello:1")).toBeNull();
        expect(momentsOf(page)).toBe(before);
    });

    it("tells the owner the developer saw it, and drops it at once", async () => {
        const clock = { now: at(10, 8, 0) };
        const { sent, owner, transport } = fakeOwner(clock);
        owner.startAnswer = {
            rev: 1,
            moments: [aMoment("hello:1"), aMoment("break:2", { kind: "break", set: "break" })],
        };
        const page = aPage();
        page.useTransport(transport);
        page.start();
        await flush();
        page.noteSeen("hello:1");
        expect(sent.seen).toEqual(["hello:1"]);
        expect(momentsOf(page).map((moment) => moment.id)).toEqual(["break:2"]);
        page.noteSeen("gone:3");
        expect(sent.seen).toEqual(["hello:1", "gone:3"]);
        expect(momentsOf(page).map((moment) => moment.id)).toEqual(["break:2"]);
    });
});

describe("the page speaks to Electron main through the preload's API", () => {
    it("sends the inputs, the facts, the moment on screen and the moment seen, and hears the moments", async () => {
        const calls: [string, unknown][] = [];
        let push: (update: MomentsUpdate) => void = null;
        Sources.api = {
            moltentermBrokkStart: async (facts: unknown) => {
                calls.push(["start", facts]);
                return { rev: 1, moments: [aMoment("hello:1")] };
            },
            moltentermBrokkStop: () => calls.push(["stop", null]),
            moltentermBrokkFacts: (facts: unknown) => calls.push(["facts", facts]),
            moltentermBrokkInput: (facts: unknown) => calls.push(["input", facts]),
            moltentermBrokkShown: (id: string) => {
                calls.push(["shown", id]);
                return aMoment(id, { shownAt: 5 });
            },
            moltentermBrokkSeen: (id: string) => calls.push(["seen", id]),
            onMoltentermBrokkMoments: (callback: (update: MomentsUpdate) => void) => {
                push = callback;
                return () => calls.push(["unlisten", null]);
            },
        };
        const page = aPage();
        const stop = page.start();
        await flush();
        expect(momentsOf(page).map((moment) => moment.id)).toEqual(["hello:1"]);
        push({ rev: 2, moments: [aMoment("hello:1"), aMoment("break:2", { kind: "break" })] });
        expect(momentsOf(page)).toHaveLength(2);
        page.noteInput();
        expect(page.noteShown("hello:1")).toMatchObject({ shownAt: 5 });
        page.noteSeen("hello:1");
        stop();
        expect(calls.map(([name]) => name)).toEqual(["start", "input", "shown", "seen", "unlisten", "stop"]);
        for (const [name, payload] of calls.filter(([n]) => n === "start" || n === "input")) {
            expect(payload, name).toEqual({
                working: 0,
                proximity: "colleague",
                language: expect.stringMatching(/^[a-z]{2}/),
            });
        }
    });

    it("does nothing where Electron main does not answer: the preview, an older preload", async () => {
        Sources.api = {};
        const page = aPage();
        const stop = page.start();
        page.noteInput();
        await flush();
        expect(page.noteShown("hello:1")).toBeNull();
        page.noteSeen("hello:1");
        stop();
        expect(momentsOf(page)).toEqual([]);
    });

    it("keeps nothing in the page's own storage: the run is the owner's", () => {
        const source = readFileSync(join(__dirname, "brokk-colleague-store.ts"), "utf8").replace(/\/\/.*$/gm, "");
        expect(source).not.toMatch(/\blocalStorage\b|\bsessionStorage\b/);
        expect(source).not.toMatch(/SetMetaCommand|ClientModel/);
    });
});

// The owner is the real one here; each tab is a page of its own.
describe("several tabs, one colleague (audit #2214, C4, #2221)", () => {
    // `world`: the agents at work, which every tab sees alike.
    function tabsOf(hub: ColleagueHub, clock: { now: number }, count: number, world = { working: 0 }) {
        return Array.from({ length: count }, (_, i) => {
            const id = i + 1;
            let listener: (update: MomentsUpdate) => void = null;
            const page = aPage();
            page.useTransport({
                now: () => clock.now,
                facts: () => ({
                    ...Facts,
                    working: world.working,
                    proximity: globalStore.get(Sources.proximity) as Proximity,
                }),
                start: async (facts) =>
                    hub.start({ id, send: (update) => listener?.(update), alive: () => true }, facts),
                stop: () => hub.stop(id),
                sendFacts: (facts) => hub.facts(facts),
                sendInput: (facts) => hub.input(facts),
                shown: (momentId) => hub.shown(momentId),
                seen: (momentId) => hub.seen(momentId),
                onMoments: (callback) => {
                    listener = callback;
                    return () => {
                        listener = null;
                    };
                },
            });
            return page;
        });
    }

    function makeHub(clock: { now: number }) {
        return new ColleagueHub(
            {
                now: () => clock.now,
                random: () => 0.5,
                write: () => {},
                ask: async () => ({ status: "none" }),
                idleSec: async () => null,
                every: () => () => {},
            },
            JSON.stringify({ helloDay: "2026-11-10" })
        );
    }

    // AC-1 of #2221: each tab saw a gap of twenty minutes between its own inputs and began a new stretch, so the break
    // never came to a developer who works in two tabs.
    it("raises the break nudge for a developer who alternates between two tabs for two hours", async () => {
        const clock = { now: at(10, 9, 0) };
        const hub = makeHub(clock);
        const [first, second] = tabsOf(hub, clock, 2);
        first.start();
        second.start();
        await flush();
        const kinds = (page: BrokkColleagueModel) => momentsOf(page).map((moment) => moment.kind);
        // Twenty minutes in one tab, then twenty in the other, with an input a minute.
        for (let slot = 0; slot * 20 * Min <= BreakAfterMs + 20 * Min; slot++) {
            const tab = slot % 2 === 0 ? first : second;
            for (let minute = 0; minute < 20; minute++) {
                tab.noteInput();
                clock.now += Min;
            }
            if (clock.now - at(10, 9, 0) < BreakAfterMs - 20 * Min) {
                expect(kinds(first)).not.toContain("break");
            }
        }
        expect(kinds(first)).toContain("break");
        expect(kinds(second)).toEqual(kinds(first));
    });

    // AC-2 of #2221: the evening line is raised once for the computer, and a tab that shows it has it for all of them.
    it("raises one evening line for two tabs, and shows it once", async () => {
        const clock = { now: at(10, 22, 10) };
        const hub = makeHub(clock);
        const [first, second] = tabsOf(hub, clock, 2, { working: 2 });
        first.start();
        second.start();
        await flush();
        first.noteInput();
        clock.now += 1000;
        second.noteInput();
        const handovers = (page: BrokkColleagueModel) => momentsOf(page).filter((moment) => moment.kind === "handover");
        expect(handovers(first)).toHaveLength(1);
        expect(handovers(second)).toEqual(handovers(first));
        const [handover] = handovers(first);
        const mine = first.noteShown(handover.id);
        expect(mine).toMatchObject({ id: handover.id, shownAt: clock.now });
        expect(second.noteShown(handover.id)).toBeNull();
        second.noteSeen(handover.id);
        expect(handovers(first)).toHaveLength(0);
        expect(handovers(second)).toHaveLength(0);
    });

    it("lets one avatar of two take the hello", async () => {
        const clock = { now: at(11, 8, 58) };
        const hub = new ColleagueHub(
            {
                now: () => clock.now,
                random: () => 0.5,
                write: () => {},
                ask: async () => ({ status: "none" }),
                idleSec: async () => null,
                every: () => () => {},
            },
            null
        );
        const [first, second] = tabsOf(hub, clock, 2);
        first.start();
        second.start();
        await flush();
        second.noteInput();
        const [hello] = momentsOf(first);
        expect(hello.kind).toBe("hello");
        expect(first.noteShown(hello.id)).not.toBeNull();
        expect(second.noteShown(hello.id)).toBeNull();
        expect(momentsOf(second)[0].shownAt).toBe(clock.now);
    });
});
