// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What a click in the design panel does (FR-MORPH-019): wavesrv records it and types it into the agent's prompt, and the
// view's memory (#1879) learns it. The panel never blocks and never decides for the developer: every action is a click,
// and one that fails leaves the panel as it was.

import * as client from "./morph-design-client";
import { Decision, StepGesture } from "./morph-design-client";
import { MorphDesign, MorphQuestion, MorphStepId } from "./morph-design-model";

export type DesignActionDeps = {
    choose: (mod: string, key: string, label: string) => Promise<MorphDesign>;
    skip: (mod: string, step: MorphStepId, gesture: StepGesture) => Promise<MorphDesign>;
    decide: (mod: string, action: Decision) => Promise<MorphDesign>;
    rememberAnswer: (mod: string, key: string, label: string) => Promise<void>;
    rememberSkip: (mod: string, step: MorphStepId) => Promise<void>;
    rememberDone: (mod: string, step: MorphStepId) => Promise<void>;
};

export const DefaultActionDeps: DesignActionDeps = {
    choose: client.morphDesignChoose,
    skip: client.morphDesignSkip,
    decide: client.morphDesignDecide,
    rememberAnswer: client.rememberAnswer,
    rememberSkip: client.rememberSkip,
    rememberDone: client.rememberDone,
};

export type DesignActions = {
    choose: (question: MorphQuestion, label: string) => Promise<MorphDesign>;
    skipStep: (step: MorphStepId) => Promise<MorphDesign>;
    takeBack: (step: MorphStepId) => Promise<MorphDesign>;
    doInTerminal: (step: MorphStepId) => Promise<MorphDesign>;
    agree: () => Promise<MorphDesign>;
    validate: () => Promise<MorphDesign>;
    giveUp: () => Promise<MorphDesign>;
};

// The memory learns after wavesrv took the decision: a click that failed was not a choice.
export function makeDesignActions(mod: string, deps: DesignActionDeps = DefaultActionDeps): DesignActions {
    return {
        choose: async (question, label) => {
            const design = await deps.choose(mod, question.key, label);
            await deps.rememberAnswer(mod, question.key, label);
            await deps.rememberDone(mod, question.step);
            return design;
        },
        skipStep: async (step) => {
            const design = await deps.skip(mod, step, "skip");
            await deps.rememberSkip(mod, step);
            return design;
        },
        takeBack: (step) => deps.skip(mod, step, "unskip"),
        doInTerminal: async (step) => {
            const design = await deps.skip(mod, step, "terminal");
            await deps.rememberDone(mod, step);
            return design;
        },
        agree: async () => {
            const design = await deps.decide(mod, "agree");
            await deps.rememberDone(mod, "plan");
            return design;
        },
        validate: async () => {
            const design = await deps.decide(mod, "validate");
            await deps.rememberDone(mod, "validate");
            return design;
        },
        giveUp: () => deps.decide(mod, "giveup"),
    };
}
