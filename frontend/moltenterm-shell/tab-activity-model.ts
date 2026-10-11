// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The pure side of the tab activity model (FR-PERF-009, DS-PERF-008): what a tab view's activity is, and the
// scheduler every periodic job of the MoltenTerm frontend goes through. tab-activity.ts wires it to the window.

// active: on screen in the focused window. visible: on screen, the window shows but has not the focus. hidden: this
// view is not the one on screen (another tab or workspace), or its document is hidden. minimized: the window is
// minimised or not shown.
export type ActivityState = "active" | "visible" | "hidden" | "minimized";

// must match WindowActivity in emain/moltenterm-tab-activity.ts
export type WindowActivity = { focused: boolean; minimized: boolean; shown: boolean };

export type ActivityInputs = {
    // null until the main process answered (the preview server, a test): the document's own focus stands in.
    window: WindowActivity;
    documentFocused: boolean;
    documentVisible: boolean;
    onScreen: boolean;
};

export function deriveActivity(inputs: ActivityInputs): ActivityState {
    const win = inputs.window;
    if (win != null && (win.minimized || !win.shown)) {
        return "minimized";
    }
    if (!inputs.onScreen || !inputs.documentVisible) {
        return "hidden";
    }
    const focused = win != null ? win.focused : inputs.documentFocused;
    return focused ? "active" : "visible";
}

export function isShowing(state: ActivityState): boolean {
    return state === "active" || state === "visible";
}

// The period of a job in each state, in ms; null pauses it. visible defaults to active, hidden to null (paused) and
// minimized to hidden.
export type ActivityPolicy = {
    active: number;
    visible?: number;
    hidden?: number;
    minimized?: number;
};

// Runs only while the view shows: paused when another view is on screen or the window is minimised.
export function whileShown(ms: number, unfocusedMs?: number): ActivityPolicy {
    return { active: ms, visible: unfocusedMs ?? ms };
}

// Keeps its period in every state: for what must not lapse (a lease), never for what only refreshes a display.
export function always(ms: number): ActivityPolicy {
    return { active: ms, hidden: ms };
}

export function periodFor(policy: ActivityPolicy, state: ActivityState): number {
    const pick = (v: number, fallback: number) => (v === undefined ? fallback : v);
    const visible = pick(policy.visible, policy.active);
    const hidden = pick(policy.hidden, null);
    switch (state) {
        case "active":
            return policy.active;
        case "visible":
            return visible;
        case "hidden":
            return hidden;
        case "minimized":
            return pick(policy.minimized, hidden);
    }
    return null;
}

// tick: the period elapsed. resume: the activity changed and the job was overdue under its new period (it had been
// paused, or runs faster now), so its data is stale and it runs at once (FR-PERF-009-AC5).
export type ActivityRunReason = "tick" | "resume";

export type SchedulerClock = {
    now: () => number;
    setTimeout: (fn: () => void, ms: number) => any;
    clearTimeout: (handle: any) => void;
};

type Job = {
    policy: ActivityPolicy;
    run: (reason: ActivityRunReason) => void;
    lastRun: number;
    timer: any;
    label: string;
};

export const RealClock: SchedulerClock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

// One timer per job, chained setTimeouts: a paused job holds no timer at all.
export class ActivityScheduler {
    clock: SchedulerClock;
    state: ActivityState;
    jobs = new Set<Job>();

    constructor(state: ActivityState, clock: SchedulerClock = RealClock) {
        this.state = state;
        this.clock = clock;
    }

    // The job is not run now: callers do their first read themselves, as with setInterval.
    every(policy: ActivityPolicy, run: (reason: ActivityRunReason) => void, label = ""): () => void {
        const job: Job = { policy, run, lastRun: this.clock.now(), timer: null, label };
        this.jobs.add(job);
        this.arm(job, false);
        return () => {
            this.clearJob(job);
            this.jobs.delete(job);
        };
    }

    setState(state: ActivityState) {
        if (state === this.state) {
            return;
        }
        this.state = state;
        for (const job of [...this.jobs]) {
            this.arm(job, true);
        }
    }

    // How many jobs hold a timer now, by label: what the trace counts (FR-PERF-009-AC2).
    armedLabels(): string[] {
        return [...this.jobs].filter((j) => j.timer != null).map((j) => j.label);
    }

    private clearJob(job: Job) {
        if (job.timer != null) {
            this.clock.clearTimeout(job.timer);
            job.timer = null;
        }
    }

    private arm(job: Job, stateChanged: boolean) {
        this.clearJob(job);
        const period = periodFor(job.policy, this.state);
        if (period == null || !(period > 0)) {
            return;
        }
        const delay = job.lastRun + period - this.clock.now();
        if (stateChanged && delay <= 0) {
            this.fire(job, "resume");
            return;
        }
        job.timer = this.clock.setTimeout(() => this.fire(job, "tick"), Math.max(0, delay));
    }

    private fire(job: Job, reason: ActivityRunReason) {
        job.timer = null;
        if (!this.jobs.has(job)) {
            return;
        }
        job.lastRun = this.clock.now();
        try {
            job.run(reason);
        } catch (e) {
            console.log("tab activity job failed", job.label, e);
        }
        if (this.jobs.has(job) && job.timer == null) {
            this.arm(job, false);
        }
    }
}
