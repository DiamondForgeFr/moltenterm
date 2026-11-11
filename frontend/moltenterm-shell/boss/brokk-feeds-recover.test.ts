// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { Atom, atom, createStore, PrimitiveAtom } from "jotai";
import { describe, expect, it } from "vitest";
import type { AgentStatesData } from "../agent-state-model";
import type { ReviewPr, ReviewsAnswer } from "../reviews/reviews-model";
import { markRowHandled } from "./boss-handled";
import { buildToHandle, ciFailureSince, keptReviewAnswers, ToHandleItem, ToHandleList } from "./boss-to-handle-model";
import type { UsageReadings } from "./boss-usage";
import {
    acknowledgeUsage,
    EmptyUsageMemory,
    readUsageMemory,
    usageEventsAfter,
    UsageMemory,
    usageMemoryText,
} from "./brokk-extra-feeds";
import { BrokkHub } from "./brokk-hub";
import { avatarBadgeOf, faceRowKeys } from "./brokk-hub-feed";
import { feedBrokkHub } from "./brokk-hub-feed-store";
import { DefaultVisitSettings, VisitSettings } from "./brokk-visit-events";
import { EmptyShared } from "./brokk-visit-share";

const T = Date.parse("2026-11-11T10:00:00Z");
const Dir = "/projects/forge";

function failing(completedat: string): ReviewPr {
    return {
        number: 7,
        title: "PR 7",
        url: "https://example.test/pull/7",
        branch: "fix/7-x",
        base: "develop",
        createdat: "2026-11-10T09:00:00Z",
        updatedat: "2026-11-10T09:00:00Z",
        merge: "failing",
        ci: {
            state: "failure",
            success: 0,
            failure: 1,
            pending: 0,
            checks: [{ name: "Frontend", state: "failure", runid: 1, completedat }],
        },
        report: { state: "present" },
        unpublished: 0,
    } as ReviewPr;
}

function ok(...prs: ReviewPr[]): ReviewsAnswer {
    return { dir: Dir, state: "ok", ready: prs, drafts: [] } as ReviewsAnswer;
}

function rowsOf(answers: Record<string, ReviewsAnswer>, handled = {}): ToHandleList {
    return buildToHandle({
        states: { states: {} } as AgentStatesData,
        notifications: [],
        answers,
        readied: {},
        sessions: [],
        parked: {},
        handled,
    });
}

describe("a CI that fails again after Re-run is news again (#2223, B3)", () => {
    it("dates the failure from its failing checks, not from the pull request's last update", () => {
        expect(ciFailureSince(failing("2026-11-11T08:00:00Z"))).toBe(Date.parse("2026-11-11T08:00:00Z"));
        const noTime = failing("");
        expect(ciFailureSince(noTime)).toBe(Date.parse(noTime.updatedat));
    });

    it("does not hold back a second failure with the mark of the first one", () => {
        const first = rowsOf({ [Dir]: ok(failing("2026-11-11T08:00:00Z")) }).items[0];
        expect(first.key).toBe(`ci:${Dir}:7`);
        const handled = markRowHandled({}, { key: first.key, since: first.since, tone: first.tone }, T);
        expect(rowsOf({ [Dir]: ok(failing("2026-11-11T08:00:00Z")) }, handled).items).toHaveLength(0);
        // Re-run pushed no commit: the PR's update is the same, the run's end is not.
        expect(rowsOf({ [Dir]: ok(failing("2026-11-11T09:30:00Z")) }, handled).items.map((i) => i.key)).toEqual([
            first.key,
        ]);
    });
});

describe("a failed review reading keeps the last good rows (#2223, B4)", () => {
    it("keeps a project's last good answer through an error, and takes the next good one", () => {
        const good = ok(failing("2026-11-11T08:00:00Z"));
        const error = { dir: Dir, state: "error", message: "timeout", ready: [], drafts: [] } as ReviewsAnswer;
        let kept = keptReviewAnswers({}, { [Dir]: good });
        expect(kept[Dir]).toBe(good);
        kept = keptReviewAnswers(kept, { [Dir]: error });
        expect(kept[Dir]).toBe(good);
        expect(rowsOf(kept).items).toHaveLength(1);
        const next = ok();
        kept = keptReviewAnswers(kept, { [Dir]: next });
        expect(kept[Dir]).toBe(next);
        expect(rowsOf(kept).items).toHaveLength(0);
    });

    it("lets a signed-out or gone project replace its rows, and returns the same record when nothing changes", () => {
        const good = ok(failing("2026-11-11T08:00:00Z"));
        const out = { dir: Dir, state: "loggedout", ready: [], drafts: [] } as ReviewsAnswer;
        const kept = keptReviewAnswers({}, { [Dir]: good });
        expect(keptReviewAnswers(kept, { [Dir]: out })[Dir]).toBe(out);
        expect(keptReviewAnswers(kept, { [Dir]: good })).toBe(kept);
        expect(keptReviewAnswers(kept, {})).toEqual({});
    });

    it("tells the rows once: an error between two good readings raises no new event", () => {
        const store = createStore();
        const latest = atom({} as Record<string, ReviewsAnswer>) as PrimitiveAtom<Record<string, ReviewsAnswer>>;
        let kept: Record<string, ReviewsAnswer> = {};
        const rows = atom((get) => {
            kept = keptReviewAnswers(kept, get(latest));
            return rowsOf(kept);
        });
        const hub = hubOn(store, rows);
        store.set(latest, { [Dir]: ok(failing("2026-11-11T08:00:00Z")) });
        expect(hub.getView().badgeKeys).toEqual([`ci:${Dir}:7`]);
        const event = hub.getModel().visits.events[`ci:${Dir}:7`];
        store.set(latest, { [Dir]: { dir: Dir, state: "error", ready: [], drafts: [] } as ReviewsAnswer });
        expect(hub.getView().badgeKeys).toEqual([`ci:${Dir}:7`]);
        store.set(latest, { [Dir]: ok(failing("2026-11-11T08:00:00Z")) });
        // The very same event: never cancelled, so never raised again as news.
        expect(hub.getModel().visits.events[`ci:${Dir}:7`]).toBe(event);
    });
});

function hubOn(store: ReturnType<typeof createStore>, rows: Atom<ToHandleList>, extra = {}) {
    const hub = new BrokkHub({
        now: () => T,
        setTimer: () => 0,
        clearTimer: () => {},
        overlayOpen: () => false,
        openPanel: () => {},
        readShared: () => EmptyShared,
        writeShared: () => {},
    });
    feedBrokkHub(hub, {
        store,
        agentsAtom: atom({ states: {}, versions: {} } as AgentStatesData),
        agentsLoadedAtom: atom(true),
        toHandleAtom: rows,
        settingsAtom: atom(DefaultVisitSettings),
        sidebarOnScreenAtom: atom(true),
        searchOpenAtom: atom(false),
        dragAtom: atom(false),
        cardOpenAtom: atom(false),
        ...extra,
    });
    return hub;
}

const Hot: UsageReadings = {
    claude: { agent: "claude", source: "t", readat: T, windows: [{ id: "w", label: "w", usedpercent: 95 }] },
};

describe("a plan usage already seen stays seen after a restart (#2223, B8)", () => {
    it("keeps a seen provider until a reading says it cooled down, not while no reading is in", () => {
        const seen: UsageMemory = { seen: new Set(["claude"]) };
        const empty = usageEventsAfter(seen, {}, T);
        expect(empty.events).toEqual([]);
        expect([...empty.memory.seen]).toEqual(["claude"]);
        expect(usageEventsAfter(empty.memory, Hot, T).events).toEqual([]);
        const cool: UsageReadings = {
            claude: { ...Hot.claude, windows: [{ id: "w", label: "w", usedpercent: 40 }] },
        };
        expect([...usageEventsAfter(seen, cool, T).memory.seen]).toEqual([]);
    });

    it("comes back from the storage as it was written, and reads anything odd as nothing seen", () => {
        const memory = acknowledgeUsage(Hot, T);
        expect(readUsageMemory(usageMemoryText(memory)).seen).toEqual(new Set(["claude"]));
        expect(readUsageMemory("{oops").seen.size).toBe(0);
        expect(readUsageMemory(null)).toBe(EmptyUsageMemory);
    });

    it("brings him no second time after a restart for a usage he already told", () => {
        const vient: VisitSettings = {
            ...DefaultVisitSettings,
            coming: { ...DefaultVisitSettings.coming, usage: "vient" },
        };
        let saved = "";
        const usageMemory = {
            read: () => readUsageMemory(saved),
            write: (memory: UsageMemory) => (saved = usageMemoryText(memory)),
        };
        const start = (readings: UsageReadings) => {
            const store = createStore();
            const usage = atom(readings) as PrimitiveAtom<UsageReadings>;
            const card = atom(false) as PrimitiveAtom<boolean>;
            const hub = hubOn(store, atom({ items: [], info: [], parked: 0 } as ToHandleList), {
                settingsAtom: atom(vient),
                usageAtom: usage,
                cardOpenAtom: card,
                usageMemory,
            });
            return { store, usage, card, hub };
        };
        const first = start(Hot);
        expect(first.hub.getModel().visits.events["usage:claude"]).toBeDefined();
        first.store.set(first.card, true);
        expect(first.hub.getModel().visits.events["usage:claude"]).toBeUndefined();
        // The app restarts: the readings come in a while after the start.
        const second = start({});
        second.store.set(second.usage, Hot);
        expect(second.hub.getModel().visits.events["usage:claude"]).toBeUndefined();
        expect(second.hub.getView().visit).toBeNull();
    });
});

function row(key: string, extra: Partial<ToHandleItem> = {}): ToHandleItem {
    return {
        key,
        tone: "waiting",
        notice: null,
        lineFromNotice: false,
        name: key,
        line: { text: key },
        place: "",
        since: T,
        rank: 1,
        seen: false,
        actions: [],
        ...extra,
    } as ToHandleItem;
}

describe("the call, the pose and the badge read one count (#2223, B9)", () => {
    const cases: { name: string; settings: VisitSettings; items: ToHandleItem[] }[] = [
        {
            name: "a ready pull request set to Rien",
            settings: { ...DefaultVisitSettings, coming: { ...DefaultVisitSettings.coming, ready: "rien" } },
            items: [row(`ready:${Dir}:7`, { tone: "done" as ToHandleItem["tone"] })],
        },
        { name: "an agent that waits", settings: DefaultVisitSettings, items: [row("agent:b1")] },
        {
            name: "a hand-off request, which raises no event",
            settings: DefaultVisitSettings,
            items: [row("handoff:r1")],
        },
        {
            name: "a failing CI set to Rien beside an agent that stopped",
            settings: { ...DefaultVisitSettings, coming: { ...DefaultVisitSettings.coming, ci: "rien" } },
            items: [row(`ci:${Dir}:7`, { tone: "error" }), row("agent:b2", { tone: "error" })],
        },
        { name: "a row already seen", settings: DefaultVisitSettings, items: [row("agent:b3", { seen: true })] },
    ];

    for (const c of cases) {
        it(`${c.name}: the rows that call are the rows the face counts`, () => {
            const store = createStore();
            const rows = atom({ items: c.items, info: [], parked: 0 } as ToHandleList);
            const hub = hubOn(store, rows, { settingsAtom: atom(c.settings) });
            const face = avatarBadgeOf(c.items, hub.getView().badge, c.settings);
            const calling = faceRowKeys(c.items, c.settings);
            expect(calling).toHaveLength(face.count);
        });
    }
});
