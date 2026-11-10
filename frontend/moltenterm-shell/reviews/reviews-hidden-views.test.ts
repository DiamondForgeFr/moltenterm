// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const Rpc = vi.hoisted(() => ({ calls: [] as { command: string; data: any }[] }));
vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: {
        wshRpcCall: vi.fn(async (command: string, data: any) => {
            Rpc.calls.push({ command, data });
            return null;
        }),
    },
}));
const Events = vi.hoisted(() => ({ handlers: new Map<string, Set<(event: any) => void>>() }));
vi.mock("@/app/store/wps", () => ({
    waveEventSubscribeSingle: ({ eventType, handler }: { eventType: string; handler: (event: any) => void }) => {
        const set = Events.handlers.get(eventType) ?? new Set();
        set.add(handler);
        Events.handlers.set(eventType, set);
        return () => set.delete(handler);
    },
}));

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import { MissionUpdateEvent } from "../mission/mission-client";
import { makeShownAsk } from "../shown-ask";
import { ActivityPolicy, ActivityState, periodFor } from "../tab-activity-model";
import { ReviewsCommand, watchReviewsRail } from "./reviews-client";
import { askUpcomingWork, UpcomingAnswers } from "./reviews-upcoming-client";
import { UpcomingCommand } from "./reviews-upcoming-model";

type Job = { policy: ActivityPolicy; run: () => void; label: string };

function fixture(state: ActivityState) {
    const stateAtom = atom(state) as PrimitiveAtom<ActivityState>;
    const jobs: Job[] = [];
    const activity = {
        stateAtom,
        every: (policy: ActivityPolicy, run: () => void, label = "") => {
            jobs.push({ policy, run, label });
            return () => {};
        },
    };
    const move = (next: ActivityState) => globalStore.set(stateAtom, next);
    return { activity: activity as any, jobs, move };
}

function emit(eventType: string, data?: unknown) {
    for (const handler of [...(Events.handlers.get(eventType) ?? [])]) {
        handler({ data });
    }
}

function calls(command: string) {
    return Rpc.calls.filter((call) => call.command === command);
}

const FocusTarget = new EventTarget();

beforeEach(() => {
    Rpc.calls = [];
    Events.handlers.clear();
    vi.stubGlobal("window", FocusTarget);
});

afterEach(() => {
    vi.unstubAllGlobals();
    UpcomingAnswers.resetInstance();
});

describe("the rail's reviews counts in a view that shows (#2154)", () => {
    it("ask passively when the view mounts, on a mission update and on the window's focus", () => {
        const { activity } = fixture("active");
        const stop = watchReviewsRail("proj", activity);
        expect(calls(ReviewsCommand)).toHaveLength(1);
        expect(calls(ReviewsCommand)[0].data).toMatchObject({ dir: "proj", passive: true });
        emit(MissionUpdateEvent);
        expect(calls(ReviewsCommand)).toHaveLength(2);
        FocusTarget.dispatchEvent(new Event("focus"));
        expect(calls(ReviewsCommand)).toHaveLength(3);
        stop();
    });

    it("ask in a window that shows without the focus too", () => {
        const { activity } = fixture("visible");
        const stop = watchReviewsRail("proj", activity);
        emit(MissionUpdateEvent);
        expect(calls(ReviewsCommand)).toHaveLength(2);
        stop();
    });
});

describe("the rail's reviews counts in a hidden view (#2154, AC-2)", () => {
    it("make no reviewsGet on mount, on mission updates, nor on a focus", () => {
        const { activity } = fixture("hidden");
        const stop = watchReviewsRail("proj", activity);
        for (let i = 0; i < 4; i++) {
            emit(MissionUpdateEvent);
        }
        FocusTarget.dispatchEvent(new Event("focus"));
        expect(calls(ReviewsCommand)).toHaveLength(0);
        stop();
    });

    it("ask once when the view shows again, whatever came meanwhile", () => {
        const { activity, move } = fixture("hidden");
        const stop = watchReviewsRail("proj", activity);
        emit(MissionUpdateEvent);
        emit(MissionUpdateEvent);
        move("active");
        expect(calls(ReviewsCommand)).toHaveLength(1);
        emit(MissionUpdateEvent);
        expect(calls(ReviewsCommand)).toHaveLength(2);
        stop();
    });

    it("ask nothing in a minimised window, nor after the watch stopped", () => {
        const { activity, move } = fixture("minimized");
        const stop = watchReviewsRail("proj", activity);
        emit(MissionUpdateEvent);
        stop();
        move("active");
        emit(MissionUpdateEvent);
        expect(calls(ReviewsCommand)).toHaveLength(0);
    });

    it("hold a poll that pauses with the view, and runs at once when it comes back overdue", () => {
        const { activity, jobs } = fixture("active");
        const stop = watchReviewsRail("proj", activity);
        const poll = jobs.find((job) => job.label === "reviews-rail");
        expect(poll).toBeDefined();
        expect(periodFor(poll.policy, "active")).toBeGreaterThan(0);
        expect(periodFor(poll.policy, "hidden")).toBeNull();
        expect(periodFor(poll.policy, "minimized")).toBeNull();
        stop();
    });
});

describe("the upcoming work in a hidden view (#2154, AC-2)", () => {
    function watch(state: ActivityState, key: string) {
        const { activity, move } = fixture(state);
        const seen = { agents: null as string };
        let agents = "a1";
        const shown = makeShownAsk(() => askUpcomingWork(seen, "proj", key, agents), activity);
        const changeAgents = (next: string) => {
            agents = next;
            shown.event();
        };
        return { shown, move, changeAgents };
    }

    it("is asked when the agents change while the view shows, and forced", async () => {
        const { shown, changeAgents } = watch("active", "k");
        shown.event();
        expect(calls(UpcomingCommand)).toHaveLength(1);
        expect(calls(UpcomingCommand)[0].data.force).toBeUndefined();
        changeAgents("a2");
        expect(calls(UpcomingCommand)).toHaveLength(2);
        expect(calls(UpcomingCommand)[1].data.force).toBe(true);
        shown.stop();
    });

    it("is not asked, and never forced, while the view is hidden", () => {
        const { shown, move, changeAgents } = watch("active", "k");
        shown.event();
        move("hidden");
        changeAgents("a2");
        changeAgents("a3");
        changeAgents("a4");
        expect(calls(UpcomingCommand)).toHaveLength(1);
        expect(calls(UpcomingCommand).filter((call) => call.data.force)).toHaveLength(0);
        shown.stop();
    });

    it("is asked once when the view shows again, forced because the agents changed meanwhile", () => {
        const { shown, move, changeAgents } = watch("active", "k");
        shown.event();
        move("hidden");
        changeAgents("a2");
        changeAgents("a3");
        move("active");
        expect(calls(UpcomingCommand)).toHaveLength(2);
        expect(calls(UpcomingCommand)[1].data.force).toBe(true);
        shown.stop();
    });

    it("is asked nothing without a review list to place the work on", () => {
        const { shown } = watch("active", "");
        shown.event();
        expect(calls(UpcomingCommand)).toHaveLength(0);
        shown.stop();
    });
});
