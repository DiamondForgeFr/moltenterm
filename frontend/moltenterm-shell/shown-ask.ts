// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Asking wavesrv only where somebody can see the answer (#2154, FR-PERF-009). Every tab view of a project hears the
// project's events (a mission update, a CI report, an agent starting or stopping), and a view that is not on screen
// (another tab or workspace, a minimised window) has nobody to show the answer to: with V views on a project, one event
// made V of them ask, and the asks that force wavesrv's caches cost the most. A shown ask runs at once while its view
// shows. While it does not, the ask is remembered, and made once when the view shows again, so what happened meanwhile
// is read then and only then.

import { globalStore } from "@/app/store/jotaiStore";
import type { Atom } from "jotai";
import { useEffect, useRef } from "react";
import { TabActivity } from "./tab-activity";
import { ActivityState, isShowing } from "./tab-activity-model";

// What a shown ask needs of the view's activity: its state, as TabActivity gives it.
export type ShownActivity = { stateAtom: Atom<ActivityState> };

export type ShownAsk = {
    // Something calls for an answer: it is asked now while the view shows, and once when the view shows again otherwise.
    event: () => void;
    stop: () => void;
};

export function makeShownAsk(ask: () => void, activity: ShownActivity = TabActivity.getInstance()): ShownAsk {
    let owed = false;
    let stopped = false;
    const showing = () => isShowing(globalStore.get(activity.stateAtom));
    const unsubscribe = globalStore.sub(activity.stateAtom, () => {
        if (owed && showing()) {
            owed = false;
            ask();
        }
    });
    return {
        event: () => {
            if (stopped) {
                return;
            }
            if (!showing()) {
                owed = true;
                return;
            }
            owed = false;
            ask();
        },
        stop: () => {
            stopped = true;
            owed = false;
            unsubscribe();
        },
    };
}

// Asks, with the latest `ask`, each time `deps` change while the view shows, and once when it shows again if they changed
// while it did not. It asks at the mount too.
export function useAskWhenShown(ask: () => void, deps: readonly unknown[]) {
    const askRef = useRef(ask);
    askRef.current = ask;
    const gate = useRef<ShownAsk>(null);
    useEffect(() => {
        gate.current = makeShownAsk(() => askRef.current());
        return () => {
            gate.current.stop();
            gate.current = null;
        };
    }, []);
    useEffect(() => {
        gate.current?.event();
    }, deps);
}
