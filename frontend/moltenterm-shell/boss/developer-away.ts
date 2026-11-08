// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Whether the developer is away from this computer (FR-BOSS-007, AC2, #1958): Brokk sleeps then, and only then when
// nothing works or waits. The signal is this computer's idle time, the one the tab views' paint check reads in Electron
// main (emain/moltenterm-system-idle.ts): input in another application, or in another view of the window (a page of its
// own), is the developer being there. It is read only while a surface shows his face, and any input in this page wakes
// him at once, without waiting for the next reading.

import { getApi } from "@/app/store/global";
import { useEffect, useState } from "react";
import { TabActivity } from "../tab-activity";
import { whileShown } from "../tab-activity-model";

// About ten minutes without input.
export const AwayAfterSec = 600;
// How often the idle time is read while his face shows: the delay to fall asleep, or to wake for input elsewhere.
export const AwayPollMs = 15000;

export const InputEvents = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"];

export function isAway(idleSec: number): boolean {
    return typeof idleSec === "number" && idleSec >= AwayAfterSec;
}

export type InputTarget = {
    addEventListener: (type: string, listener: () => void, options?: any) => void;
    removeEventListener: (type: string, listener: () => void, options?: any) => void;
};

// Runs `run` every `ms` and returns the stop.
export type Every = (ms: number, run: () => void) => () => void;

// The view's own scheduler: paused while another view is on screen, and still running while the window is not in front,
// since the developer working in another application is what the idle time must see.
const ActivityEvery: Every = (ms, run) =>
    TabActivity.getInstance().every(whileShown(ms, ms), () => run(), "brokk-away");

// Reads the idle time now and every AwayPollMs, and tells each change of the answer; an input on `target` is the
// developer back. Returns the stop. Apart from React, so the rules run against stand-ins in the tests.
export function watchAway(
    target: InputTarget,
    readIdleSec: () => Promise<number>,
    onChange: (away: boolean) => void,
    every: Every = ActivityEvery
): () => void {
    let live = true;
    let away = false;
    const set = (next: boolean) => {
        if (live && next !== away) {
            away = next;
            onChange(next);
        }
    };
    const read = () => {
        if (readIdleSec == null) {
            return;
        }
        readIdleSec()
            .then((sec) => set(isAway(sec)))
            .catch(() => {});
    };
    const back = () => set(false);
    const options = { passive: true, capture: true };
    read();
    const stopPolling = every(AwayPollMs, read);
    InputEvents.forEach((name) => target.addEventListener(name, back, options));
    return () => {
        live = false;
        stopPolling();
        InputEvents.forEach((name) => target.removeEventListener(name, back, options));
    };
}

export function useDeveloperAway(active: boolean): boolean {
    const [away, setAway] = useState(false);
    useEffect(() => {
        if (!active) {
            setAway(false);
            return;
        }
        const ask = getApi()?.moltentermGetSystemIdleSec;
        return watchAway(window, ask == null ? null : () => ask(), setAway);
    }, [active]);
    return away;
}
