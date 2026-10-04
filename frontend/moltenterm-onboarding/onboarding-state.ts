// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The first run's record (FR-ONB-001, DS-ONB-001): the client meta "molten:onboarding", written by wavesrv only
// (pkg/molten/onboarding) and read here. Pure selectors, so the panel's page logic is tested without a window.

// must match pkg/molten/onboarding/state.go
export const OnboardingMetaKey = "molten:onboarding";
export const OnboardingPageMetaKey = "molten:onboarding:page";
export const OnboardingRoute = "molten:onboarding";
export const MoltentermOnboardingView = "molten-onboarding";
export const OnboardingOpenGesture = "onboarding:open";
export const OnboardingUpdateCommand = "onboardingupdate";
export const OnboardingStateCommand = "onboardingstate";
export const OnboardingPanelCommand = "onboardingpanel";

export const FirstRunStepIds = ["agent", "morph", "project"] as const;

export type FirstRunStepId = (typeof FirstRunStepIds)[number];
export type FirstRunStepStatus = "todo" | "done" | "skipped";
export type OnboardingDoneBy = "" | "finish" | "leave" | "closed" | "env" | "existing";

export type OnboardingState = {
    v: number;
    done: boolean;
    by: OnboardingDoneBy;
    startedts: number;
    welcomets: number;
    donets: number;
    steps: Partial<Record<FirstRunStepId, FirstRunStepStatus>>;
    data: Partial<Record<FirstRunStepId, Record<string, any>>>;
    lastversion: string;
};

export type FirstRunPage = "welcome" | "summary" | `step:${FirstRunStepId}`;

export const EmptyOnboardingState: OnboardingState = {
    v: 0,
    done: false,
    by: "",
    startedts: 0,
    welcomets: 0,
    donets: 0,
    steps: {},
    data: {},
    lastversion: "",
};

function isRecord(value: unknown): value is Record<string, any> {
    return value != null && typeof value === "object" && !Array.isArray(value);
}

function num(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isStepId(value: string): value is FirstRunStepId {
    return (FirstRunStepIds as readonly string[]).includes(value);
}

// Whether wavesrv has written a record yet.
export function hasOnboardingState(meta: MetaType): boolean {
    return isRecord(meta?.[OnboardingMetaKey]);
}

// The record in the client meta; an absent or malformed one reads as a run not started.
export function readOnboardingState(meta: MetaType): OnboardingState {
    const raw = meta?.[OnboardingMetaKey];
    if (!isRecord(raw)) {
        return EmptyOnboardingState;
    }
    const steps: OnboardingState["steps"] = {};
    if (isRecord(raw.steps)) {
        for (const [id, status] of Object.entries(raw.steps)) {
            if (isStepId(id) && (status === "done" || status === "skipped")) {
                steps[id] = status;
            }
        }
    }
    const data: OnboardingState["data"] = {};
    if (isRecord(raw.data)) {
        for (const [id, value] of Object.entries(raw.data)) {
            if (isStepId(id) && isRecord(value)) {
                data[id] = value;
            }
        }
    }
    return {
        v: num(raw.v),
        done: raw.done === true,
        by: typeof raw.by === "string" ? (raw.by as OnboardingDoneBy) : "",
        startedts: num(raw.startedts),
        welcomets: num(raw.welcomets),
        donets: num(raw.donets),
        steps,
        data,
        lastversion: typeof raw.lastversion === "string" ? raw.lastversion : "",
    };
}

export function stepStatus(state: OnboardingState, id: FirstRunStepId): FirstRunStepStatus {
    return state?.steps?.[id] ?? "todo";
}

export function isWelcomeDone(state: OnboardingState): boolean {
    return (state?.welcomets ?? 0) > 0;
}

export function stepPage(id: FirstRunStepId): FirstRunPage {
    return `step:${id}`;
}

export function pageStep(page: FirstRunPage): FirstRunStepId {
    if (!page?.startsWith("step:")) {
        return null;
    }
    const id = page.slice("step:".length);
    return isStepId(id) ? id : null;
}

export function parsePage(value: unknown, ids: readonly FirstRunStepId[] = FirstRunStepIds): FirstRunPage {
    if (value === "welcome" || value === "summary") {
        return value;
    }
    if (typeof value !== "string") {
        return null;
    }
    const step = pageStep(value as FirstRunPage);
    return step != null && ids.includes(step) ? stepPage(step) : null;
}

// The first step not done: a skipped step is still unfinished, so reopening the first run lands on it.
export function firstUnfinishedStep(
    state: OnboardingState,
    ids: readonly FirstRunStepId[] = FirstRunStepIds
): FirstRunStepId {
    return ids.find((id) => stepStatus(state, id) !== "done") ?? null;
}

// Where Getting started opens: the welcome page until it is passed, then the first unfinished step, then the summary.
export function reopenPage(state: OnboardingState, ids: readonly FirstRunStepId[] = FirstRunStepIds): FirstRunPage {
    if (!isWelcomeDone(state)) {
        return "welcome";
    }
    const step = firstUnfinishedStep(state, ids);
    return step == null ? "summary" : stepPage(step);
}

// The page after a step is completed or skipped: the next step not done after it, else the summary. Skipping always
// moves forward, even when an earlier step is still unfinished.
export function pageAfter(
    state: OnboardingState,
    current: FirstRunStepId,
    ids: readonly FirstRunStepId[] = FirstRunStepIds
): FirstRunPage {
    const index = ids.indexOf(current);
    const next = ids.slice(index + 1).find((id) => stepStatus(state, id) !== "done");
    return next == null ? "summary" : stepPage(next);
}

// The page the panel shows: the welcome page until it is passed, else the page the panel was sent to, else where
// reopening would land.
export function panelPage(
    state: OnboardingState,
    requested: unknown,
    ids: readonly FirstRunStepId[] = FirstRunStepIds
): FirstRunPage {
    if (!isWelcomeDone(state)) {
        return "welcome";
    }
    const page = parsePage(requested, ids);
    if (page != null) {
        return page;
    }
    return reopenPage(state, ids);
}

// "Step 2 of 3" for a step page; the welcome and the summary have no number.
export function progressLabel(page: FirstRunPage, ids: readonly FirstRunStepId[] = FirstRunStepIds): string {
    const step = pageStep(page);
    if (step == null) {
        return page === "summary" ? "All steps" : "Welcome";
    }
    return `Step ${ids.indexOf(step) + 1} of ${ids.length}`;
}

// Whether the first run still waits for the user (the window docks the panel when wavesrv could not).
export function isPending(meta: MetaType): boolean {
    return hasOnboardingState(meta) && !readOnboardingState(meta).done;
}
