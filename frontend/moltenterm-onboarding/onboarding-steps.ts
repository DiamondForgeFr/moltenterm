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
    // status done, then the panel moves to the next step
    complete: () => Promise<void>;
    // status skipped, then the panel moves to the next step
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
};

// Ordered as FirstRunStepIds.
export const FirstRunSteps: FirstRunStep[] = [
    {
        id: "agent",
        title: "Your agent",
        label: "Your agent",
        summary: "The coding agents MoltenTerm finds on this machine, and the one you work with.",
        component: AgentPlaceholderStep,
    },
    {
        id: "morph",
        title: "Your first morph",
        label: "First morph",
        summary: "Ask your agent to reshape MoltenTerm, and see the change land.",
        component: MorphPlaceholderStep,
    },
    {
        id: "project",
        title: "Your project and your sessions",
        label: "Your project",
        summary: "Link a workspace to your project folder and find your agent sessions.",
        component: ProjectPlaceholderStep,
    },
];

export function findFirstRunStep(id: FirstRunStepId): FirstRunStep {
    return FirstRunSteps.find((step) => step.id === id) ?? null;
}
