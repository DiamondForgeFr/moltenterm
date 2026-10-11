// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The working beat (#473): the one clock every working indicator of a view moves on (the rail and tab dots, the panel
// header's segment, the bell's ring, the running-work spinner). It writes a phase, 0 to 3, on the root element
// (data-mt-beat) every WorkingBeatMs, and the CSS keys each indicator's look on it (moltenterm-shell.css,
// header/header.css). An infinite CSS animation per indicator made Chromium draw a frame at every display refresh,
// about a third of a core for 3 working agents (#455); the beat draws 1 frame a second whatever the number of
// indicators. It runs only while the view is active and at least one indicator is shown, and stops under reduced
// motion: the indicators then keep their static look, which alone tells working from waiting and idle.
// Why 1 s and not faster: on macOS every frame of the window costs about 6 ms of GPU-process time whatever little
// changed (measured, #473), so the cost follows the frame rate; a 500 ms beat put 3 agents above the 3 % budget.

import { atoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { useEffect } from "react";
import { TabActivity } from "./tab-activity";
import { ActivityPolicy } from "./tab-activity-model";

export const WorkingBeatMs = 1000;
export const WorkingBeatPhases = 4;

// Paused in every state but active: an indicator nobody looks at stands still (FR-PERF-009-AC4).
export const WorkingBeatPolicy: ActivityPolicy = { active: WorkingBeatMs, visible: null };

type EveryFn = (policy: ActivityPolicy, run: () => void, label: string) => () => void;

export class WorkingBeat {
    private static instance: WorkingBeat = null;

    holders = 0;
    phase = 0;
    stopClock: () => void = null;
    every: EveryFn;
    reducedMotion: () => boolean;
    root: () => HTMLElement;

    // The clock, the reduced-motion preference and the root are passed in so that tests can drive them.
    private constructor(every: EveryFn, reducedMotion: () => boolean, root: () => HTMLElement) {
        this.every = every;
        this.reducedMotion = reducedMotion;
        this.root = root;
    }

    static getInstance(): WorkingBeat {
        if (!WorkingBeat.instance) {
            WorkingBeat.instance = new WorkingBeat(
                (policy, run, label) => TabActivity.getInstance().every(policy, run, label),
                () =>
                    atoms?.prefersReducedMotionAtom != null ? globalStore.get(atoms.prefersReducedMotionAtom) : false,
                () => globalThis.document?.documentElement
            );
        }
        return WorkingBeat.instance;
    }

    static resetInstance(): void {
        WorkingBeat.instance = null;
    }

    static makeForTest(every: EveryFn, reducedMotion: () => boolean, root: () => HTMLElement): WorkingBeat {
        return new WorkingBeat(every, reducedMotion, root);
    }

    // An indicator holds the beat while it shows; the returned function releases it (once).
    retain(): () => void {
        this.holders++;
        if (this.holders === 1) {
            this.stopClock = this.every(WorkingBeatPolicy, () => this.tick(), "working-beat");
        }
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            this.holders--;
            if (this.holders === 0) {
                this.stop();
            }
        };
    }

    tick() {
        const root = this.root();
        if (root == null) {
            return;
        }
        if (this.reducedMotion()) {
            delete root.dataset.mtBeat;
            return;
        }
        this.phase = (this.phase + 1) % WorkingBeatPhases;
        root.dataset.mtBeat = String(this.phase);
    }

    private stop() {
        this.stopClock?.();
        this.stopClock = null;
        this.phase = 0;
        const root = this.root();
        if (root != null) {
            delete root.dataset.mtBeat;
        }
    }
}

// For the component that draws a working indicator: holds the beat while `on`.
export function useWorkingBeat(on: boolean) {
    useEffect(() => {
        if (!on) {
            return;
        }
        return WorkingBeat.getInstance().retain();
    }, [on]);
}
