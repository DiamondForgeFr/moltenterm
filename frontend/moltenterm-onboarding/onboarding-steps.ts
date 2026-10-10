// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The steps contract of the first run (FR-ONB-001, DS-ONB-001). The panel (onboarding-view.tsx) renders the stepper,
// the step's title, the step's component and a footer with "Skip this step"; a step's own primary action lives in its
// component and calls ctx.complete(). #162 (agent), #163 (morph) and #165 (project) each replace one entry of
// FirstRunSteps with their component and touch nothing else in the host.

import type React from "react";
import { AgentPlaceholderStep, MorphPlaceholderStep, ProjectPlaceholderStep } from "./onboarding-placeholder-steps";
import type { FirstRunStepId, OnboardingState } from "./onboarding-state";

export type { FirstRunStepId, FirstRunStepStatus } from "./onboarding-state";

export type FirstRunStepContext = {
    // the panel's block
    panelBlockId: string;
    // read-only snapshot of the client meta "molten:onboarding"; another step's data is state.data[<its id>]
    state: OnboardingState;
    // this step's own data (state.data[id])
    data: Record<string, any>;
    // merged into state.data[id] by wavesrv; a null value removes its key
    setData: (patch: Record<string, any>) => Promise<void>;
    // status done, then the panel moves to the next step; ignored while the panel is busy, a failure shows on the panel
    complete: () => Promise<void>;
    // status skipped, then the panel moves to the next step; same rules as complete
    skip: () => Promise<void>;
    // splits the panel "after": the new pane lands on its right; returns the new block id
    openBeside: (blockdef: BlockDef) => Promise<string>;
};

export type FirstRunStep = {
    id: FirstRunStepId;
    title: string;
    // short name in the stepper
    label: string;
    // one line, shown in the stepper's tooltip and on the summary page
    summary: string;
    component: React.FC<{ ctx: FirstRunStepContext }>;
    // Until its story ships (#162): a step that cannot do its job is left out, never shown as "not ready"
    // (FR-SHELL-053-AC4).
    hidden?: boolean;
    // A step whose component has no primary action of its own yet: the footer's Next moves on (recorded as skipped,
    // so Getting started brings it back once it does something).
    placeholder?: boolean;
};

// Ordered as FirstRunStepIds.
export const FirstRunSteps: FirstRunStep[] = [
    {
        id: "agent",
        title: "Your agent",
        label: "Your agent",
        summary: "The coding agents MoltenTerm finds on this machine, and the one you work with.",
        component: AgentPlaceholderStep,
        hidden: true,
        placeholder: true,
    },
    {
        id: "morph",
        title: "Your first morph",
        label: "First morph",
        summary: "Ask your agent to reshape MoltenTerm, and see the change land.",
        component: MorphPlaceholderStep,
        placeholder: true,
    },
    {
        id: "project",
        title: "Your project and your sessions",
        label: "Your project",
        summary: "Link a workspace to your project folder and find your agent sessions.",
        component: ProjectPlaceholderStep,
        placeholder: true,
    },
];

export function visibleSteps(steps: FirstRunStep[] = FirstRunSteps): FirstRunStep[] {
    return steps.filter((step) => !step.hidden);
}

// The steps the panel walks through, in order: the ids the page selectors of onboarding-state.ts take.
export const ShownFirstRunSteps: FirstRunStep[] = visibleSteps();
export const ShownStepIds: FirstRunStepId[] = ShownFirstRunSteps.map((step) => step.id);

export function findFirstRunStep(id: FirstRunStepId): FirstRunStep {
    return ShownFirstRunSteps.find((step) => step.id === id) ?? null;
}
