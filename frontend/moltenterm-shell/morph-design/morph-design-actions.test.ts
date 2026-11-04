// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What a click in the mod design panel does (FR-MORPH-019): wavesrv takes the decision first, then the workflow's memory
// learns it; a click that failed teaches nothing and leaves the panel as it was.

import { describe, expect, it } from "vitest";
import { DesignActionDeps, makeDesignActions } from "./morph-design-actions";
import { MorphDesign, MorphQuestion } from "./morph-design-model";

const design = { mod: "branch-box" } as MorphDesign;
const question: MorphQuestion = {
    key: "audience",
    step: "questions",
    text: "Who will use it?",
    kind: "choice",
    choices: [{ label: "Just me" }, { label: "My team" }],
};

function fakeDeps(fail?: string) {
    const log: string[] = [];
    const take = (what: string) => {
        log.push(what);
        return what === fail ? Promise.reject(new Error(`${what} refused`)) : Promise.resolve(design);
    };
    const deps: DesignActionDeps = {
        choose: (mod, key, label) => take(`choose ${mod} ${key}=${label}`),
        skip: (mod, step, gesture) => take(`skip ${mod} ${step} ${gesture}`),
        decide: (mod, action) => take(`decide ${mod} ${action}`),
        rememberAnswer: async (mod, key, label) => void log.push(`answer ${mod} ${key}=${label}`),
        rememberSkip: async (mod, step) => void log.push(`remember-skip ${mod} ${step}`),
        rememberDone: async (mod, step) => void log.push(`remember-done ${mod} ${step}`),
    };
    return { deps, log };
}

describe("a choice clicked in the panel", () => {
    it("goes to wavesrv first, then teaches the memory the answer and that the step was done", async () => {
        const { deps, log } = fakeDeps();
        await expect(makeDesignActions("branch-box", deps).choose(question, "My team")).resolves.toBe(design);
        expect(log).toEqual([
            "choose branch-box audience=My team",
            "answer branch-box audience=My team",
            "remember-done branch-box questions",
        ]);
    });

    it("teaches nothing when wavesrv refused it", async () => {
        const { deps, log } = fakeDeps("choose branch-box audience=Everybody");
        await expect(makeDesignActions("branch-box", deps).choose(question, "Everybody")).rejects.toThrow("refused");
        expect(log).toEqual(["choose branch-box audience=Everybody"]);
    });
});

describe("the gestures on a step", () => {
    it("remember a skip, and a step done in the terminal", async () => {
        const { deps, log } = fakeDeps();
        const actions = makeDesignActions("branch-box", deps);
        await actions.skipStep("preview");
        await actions.doInTerminal("adjust");
        expect(log).toEqual([
            "skip branch-box preview skip",
            "remember-skip branch-box preview",
            "skip branch-box adjust terminal",
            "remember-done branch-box adjust",
        ]);
    });

    it("take a step back without teaching anything", async () => {
        const { deps, log } = fakeDeps();
        await makeDesignActions("branch-box", deps).takeBack("preview");
        expect(log).toEqual(["skip branch-box preview unskip"]);
    });

    it("teach nothing about a skip wavesrv refused", async () => {
        const { deps, log } = fakeDeps("skip branch-box preview skip");
        await expect(makeDesignActions("branch-box", deps).skipStep("preview")).rejects.toThrow();
        expect(log).toEqual(["skip branch-box preview skip"]);
    });
});

describe("the decisions", () => {
    it("remember that the plan was agreed to and the mod validated, not that it was given up", async () => {
        const { deps, log } = fakeDeps();
        const actions = makeDesignActions("branch-box", deps);
        await actions.agree();
        await actions.validate();
        await actions.giveUp();
        expect(log).toEqual([
            "decide branch-box agree",
            "remember-done branch-box plan",
            "decide branch-box validate",
            "remember-done branch-box validate",
            "decide branch-box giveup",
        ]);
    });
});
