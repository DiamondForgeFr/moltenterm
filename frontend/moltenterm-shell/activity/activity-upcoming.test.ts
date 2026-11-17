// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// How the activity source keeps the Integration panel's upcoming work current (FR-BOSS-009, AC85, #2294): asked when the
// workspace's projects or open agents change, then on the activity scheduler, never with an agent open nowhere, never
// forced, and not at all while the view is not on screen.

import { readFileSync } from "fs";
import { atom, PrimitiveAtom } from "jotai";
import { fileURLToPath } from "url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityPolicy, ActivityRunReason, ActivityState } from "../tab-activity";

const m = vi.hoisted(() => ({ asked: [] as unknown[][] }));

vi.mock("../reviews/reviews-upcoming-client", () => ({
    upcomingGet: async (...args: unknown[]) => void m.asked.push(args),
}));

import { globalStore } from "@/app/store/jotaiStore";
import {
    UpcomingBusyPollMs,
    UpcomingBusyPollUnfocusedMs,
    UpcomingPollMs,
    UpcomingPollUnfocusedMs,
    watchActivityUpcoming,
} from "./activity-upcoming";

const Dir = "/work/product";
const Other = "/work/product/mobile";

type Job = { policy: ActivityPolicy; run: (reason: ActivityRunReason) => void; label: string; stopped: boolean };

function fixture(state: ActivityState = "active") {
    const stateAtom = atom(state) as PrimitiveAtom<ActivityState>;
    const keyAtom = atom("a") as PrimitiveAtom<string>;
    const openAtom = atom(true) as PrimitiveAtom<boolean>;
    const busyAtom = atom(false) as PrimitiveAtom<boolean>;
    const dirsAtom = atom([Dir, Other]) as PrimitiveAtom<string[]>;
    const ask = vi.fn();
    const jobs: Job[] = [];
    const activity = {
        stateAtom,
        every: (policy: ActivityPolicy, run: (reason: ActivityRunReason) => void, label = "") => {
            const job: Job = { policy, run, label, stopped: false };
            jobs.push(job);
            return () => {
                job.stopped = true;
            };
        },
    };
    const stop = watchActivityUpcoming({ keyAtom, openAtom, busyAtom, dirsAtom, ask, activity });
    const live = () => jobs.filter((j) => !j.stopped);
    const set = <T>(target: PrimitiveAtom<T>, value: T) => globalStore.set(target, value);
    return { ask, jobs, live, stop, set, stateAtom, keyAtom, openAtom, busyAtom, dirsAtom };
}

beforeEach(() => {
    m.asked = [];
});

describe("asking the upcoming work for the activity source (#2294)", () => {
    it("asks every project of the workspace at once when it starts, with an agent open and the view shown", () => {
        const f = fixture();
        expect(f.ask.mock.calls).toEqual([[Dir], [Other]]);
        f.stop();
    });

    it("asks again when the projects or the open agents change", () => {
        const f = fixture();
        f.ask.mockClear();
        f.set(f.keyAtom, "b");
        expect(f.ask).toHaveBeenCalledTimes(2);
        f.set(f.keyAtom, "b");
        expect(f.ask).toHaveBeenCalledTimes(2);
        f.stop();
    });

    it("asks nothing while no agent of the workspace is open: a sub-agent belongs to one", () => {
        const f = fixture();
        f.ask.mockClear();
        f.set(f.openAtom, false);
        f.set(f.keyAtom, "none");
        f.live()[0].run("interval" as ActivityRunReason);
        expect(f.ask).not.toHaveBeenCalled();
        f.set(f.openAtom, true);
        f.set(f.keyAtom, "a");
        expect(f.ask).toHaveBeenCalledTimes(2);
        f.stop();
    });

    it("asks nothing while the view is hidden or minimised, and once when it shows again for what it missed", () => {
        const f = fixture("hidden");
        expect(f.ask).not.toHaveBeenCalled();
        f.set(f.keyAtom, "b");
        f.set(f.keyAtom, "c");
        expect(f.ask).not.toHaveBeenCalled();
        f.set(f.stateAtom, "active");
        expect(f.ask).toHaveBeenCalledTimes(2);
        f.stop();
        const minimised = fixture("minimized");
        expect(minimised.ask).not.toHaveBeenCalled();
        minimised.stop();
    });

    it("asks in a window that shows without the focus too", () => {
        const f = fixture("visible");
        expect(f.ask).toHaveBeenCalledTimes(2);
        f.stop();
    });

    it("rides the activity scheduler for its period and runs no timer of its own", () => {
        const f = fixture();
        expect(f.live()).toHaveLength(1);
        expect(f.live()[0].label).toBe("activity-upcoming");
        expect(f.live()[0].policy).toEqual({ active: UpcomingPollMs, visible: UpcomingPollUnfocusedMs });
        f.ask.mockClear();
        f.live()[0].run("interval" as ActivityRunReason);
        expect(f.ask).toHaveBeenCalledTimes(2);
        const src = readFileSync(fileURLToPath(new URL("./activity-upcoming.ts", import.meta.url)), "utf8");
        expect(src).not.toMatch(/setInterval|setTimeout/);
        expect(src).toContain("whileShown(");
        f.stop();
    });

    it("asks sooner while a sub-agent is known to work, and goes back when none does", () => {
        const f = fixture();
        f.set(f.busyAtom, true);
        expect(f.jobs.filter((j) => j.stopped)).toHaveLength(1);
        expect(f.live()).toHaveLength(1);
        expect(f.live()[0].policy).toEqual({ active: UpcomingBusyPollMs, visible: UpcomingBusyPollUnfocusedMs });
        expect(UpcomingBusyPollMs).toBeLessThan(UpcomingPollMs);
        f.set(f.busyAtom, false);
        expect(f.live()).toHaveLength(1);
        expect(f.live()[0].policy).toEqual({ active: UpcomingPollMs, visible: UpcomingPollUnfocusedMs });
        f.stop();
    });

    it("lets go of everything when the last reader leaves", () => {
        const f = fixture();
        f.stop();
        f.ask.mockClear();
        f.set(f.keyAtom, "later");
        f.set(f.busyAtom, true);
        f.set(f.stateAtom, "hidden");
        f.set(f.stateAtom, "active");
        expect(f.ask).not.toHaveBeenCalled();
        expect(f.live()).toEqual([]);
    });

    it("never forces wavesrv to place the work anew: the default ask is the plain one, and the client loads when first used", async () => {
        const stateAtom = atom("active") as PrimitiveAtom<ActivityState>;
        const noJobs = { stateAtom, every: () => () => {} };
        const stop = watchActivityUpcoming({
            keyAtom: atom("k"),
            openAtom: atom(true),
            busyAtom: atom(false),
            dirsAtom: atom([Dir]),
            activity: noJobs,
        });
        await vi.waitFor(() => expect(m.asked).toEqual([[Dir]]));
        stop();
        const src = readFileSync(fileURLToPath(new URL("./activity-upcoming.ts", import.meta.url)), "utf8");
        expect(src).not.toMatch(/force:\s*true|upcomingGet\([^)]*,/);
        expect(src).not.toMatch(/^import .*reviews-upcoming-client/m);
    });
});
