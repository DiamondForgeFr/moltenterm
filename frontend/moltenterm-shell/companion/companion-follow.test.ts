// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: () => () => {} }));

import { ActivityScheduler, ActivityState } from "../tab-activity-model";
import { followedView, followJobs } from "./companion-follow";
import type { CompanionView } from "./companion-model";

const LeaseRenewMs = 15000;
const RefreshMs = 20000;

function fixture(state: ActivityState) {
    const scheduler = new ActivityScheduler(state);
    const opens: boolean[] = [];
    const stop = followJobs((refresh) => opens.push(refresh), {
        every: (policy, run, label) => scheduler.every(policy, run, label),
    });
    return { scheduler, opens, stop };
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("the follow lease (#2154, AC-3)", () => {
    it("is renewed while the view shows, and the sub-agents are looked at again on their own beat", () => {
        const { opens, stop } = fixture("active");
        vi.advanceTimersByTime(LeaseRenewMs + 1);
        expect(opens).toEqual([false]);
        vi.advanceTimersByTime(RefreshMs - LeaseRenewMs);
        expect(opens).toEqual([false, true]);
        stop();
    });

    it("is renewed in a window that shows without the focus", () => {
        const { opens, stop } = fixture("visible");
        vi.advanceTimersByTime(LeaseRenewMs + 1);
        expect(opens).toEqual([false]);
        stop();
    });

    it("is not renewed in a hidden view: it lapses, and wavesrv stops following", () => {
        const { opens, stop } = fixture("hidden");
        vi.advanceTimersByTime(10 * 60 * 1000);
        expect(opens).toEqual([]);
        stop();
    });

    it("is not renewed in a minimised window", () => {
        const { opens, stop } = fixture("minimized");
        vi.advanceTimersByTime(10 * 60 * 1000);
        expect(opens).toEqual([]);
        stop();
    });

    it("is taken again, and the sub-agents looked at again, once when the view shows after the lease lapsed", () => {
        const { scheduler, opens, stop } = fixture("active");
        scheduler.setState("hidden");
        vi.advanceTimersByTime(2 * 60 * 1000);
        expect(opens).toEqual([]);
        scheduler.setState("active");
        expect(opens.filter((refresh) => !refresh)).toHaveLength(1);
        expect(opens.filter((refresh) => refresh)).toHaveLength(1);
        stop();
    });

    it("is not taken again at once when the view was away less than its beat: the lease still holds", () => {
        const { scheduler, opens, stop } = fixture("active");
        scheduler.setState("hidden");
        vi.advanceTimersByTime(5000);
        scheduler.setState("active");
        expect(opens).toEqual([]);
        stop();
    });

    it("stops with the follower", () => {
        const { opens, stop } = fixture("active");
        stop();
        vi.advanceTimersByTime(5 * 60 * 1000);
        expect(opens).toEqual([]);
    });
});

function view(extra: Partial<CompanionView>): CompanionView {
    return { blockid: "b1", version: 1, status: "live", ...extra } as CompanionView;
}

function subagents(...ids: string[]): CompanionView["subagents"] {
    return ids.map((id) => ({ id, description: `Sub-agent ${id}`, state: "running" as const }));
}

describe("the sub-agents a follower lists when the view shows again (#2154)", () => {
    const listed = view({ version: 5, subagents: subagents("s1", "s2") });

    it("keep the list the view held while the leased-anew follower is still loading", () => {
        const loading = view({ version: 9, status: "loading", subagents: undefined });
        expect(followedView(listed, loading)).toBe(listed);
    });

    it("follow what wavesrv reads once it has read the session again", () => {
        const fresh = view({ version: 10, subagents: subagents("s3") });
        expect(followedView(listed, fresh)).toBe(fresh);
    });

    it("take the first view of a terminal, loading or not", () => {
        const loading = view({ version: 1, status: "loading" });
        expect(followedView(null, loading)).toBe(loading);
    });

    it("follow a status that is no longer loading, a terminal that lost its agent included", () => {
        const none = view({ version: 11, status: "noagent", subagents: undefined });
        expect(followedView(listed, none)).toBe(none);
    });

    it("keep the newest version when an older event arrives late", () => {
        const late = view({ version: 4, subagents: [] });
        expect(followedView(listed, late)).toBe(listed);
    });
});
