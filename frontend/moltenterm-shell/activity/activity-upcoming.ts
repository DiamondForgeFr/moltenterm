// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Keeps the Integration panel's upcoming work current for the activity source (FR-BOSS-009, AC85, #2294). The sub-agents
// the indicator counts are the ones that panel lists, from the same reading (reviews-upcoming-client.ts). That panel
// asks it only while it shows (#2154), so the indicator, which shows all the time, asks it itself, with the care that
// ask asked for: it is never forced (wavesrv answers from its cache for 20 s), it is made when the workspace's projects
// or open agents change and then on the app's activity scheduler, which pauses it while the view is not on screen, and
// not at all while no agent of the workspace is open, since a sub-agent belongs to one.

import { globalStore } from "@/app/store/jotaiStore";
import type { Atom } from "jotai";
import { makeShownAsk } from "../shown-ask";
import { TabActivity, whileShown } from "../tab-activity";

// How often the reading is asked again while an agent is open, and while a sub-agent is known to work, in the focused
// window and in one that shows but is not focused. The busy period is wavesrv's cache: asking sooner reads the same
// answer.
export const UpcomingPollMs = 45_000;
export const UpcomingPollUnfocusedMs = 120_000;
export const UpcomingBusyPollMs = 20_000;
export const UpcomingBusyPollUnfocusedMs = 60_000;

export type ActivityUpcomingWatch = {
    // What the reading depends on: it changes when the workspace's projects or open agents change.
    keyAtom: Atom<string>;
    // Whether an agent of the workspace is open.
    openAtom: Atom<boolean>;
    // Whether a sub-agent is known to work now, which makes the next ask due sooner.
    busyAtom: Atom<boolean>;
    dirsAtom: Atom<string[]>;
    ask?: (dir: string) => void;
    activity?: Pick<TabActivity, "stateAtom" | "every">;
};

// The client is loaded when the first ask is made: its import chain is the Integration panel's, which the title row's
// source must not pull in when it loads (reviews-state-atoms.ts says why).
function askUpcoming(dir: string) {
    import("../reviews/reviews-upcoming-client").then((client) => client.upcomingGet(dir)).catch(() => {});
}

export function watchActivityUpcoming(watch: ActivityUpcomingWatch): () => void {
    const activity = watch.activity ?? TabActivity.getInstance();
    const ask = watch.ask ?? askUpcoming;
    const run = () => {
        if (!globalStore.get(watch.openAtom)) {
            return;
        }
        for (const dir of globalStore.get(watch.dirsAtom)) {
            ask(dir);
        }
    };
    const shown = makeShownAsk(run, activity);
    const unsubscribeKey = globalStore.sub(watch.keyAtom, shown.event);
    let stopPeriodic = () => {};
    const schedule = () => {
        stopPeriodic();
        const busy = globalStore.get(watch.busyAtom);
        const policy = busy
            ? whileShown(UpcomingBusyPollMs, UpcomingBusyPollUnfocusedMs)
            : whileShown(UpcomingPollMs, UpcomingPollUnfocusedMs);
        stopPeriodic = activity.every(policy, run, "activity-upcoming");
    };
    const unsubscribeBusy = globalStore.sub(watch.busyAtom, schedule);
    schedule();
    shown.event();
    return () => {
        unsubscribeKey();
        unsubscribeBusy();
        stopPeriodic();
        shown.stop();
    };
}
