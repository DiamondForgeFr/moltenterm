// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The names the window and wavesrv share for the mod design view (FR-MORPH-019), and the rules the panel reads a design
// by: which step stands out, which answer is prefilled, which step is folded, who receives the clicks.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyDefaults, LearnedWorkflowInfos, LearningDefaults, WorkflowMorphDesign } from "../learning/learning-model";
import * as model from "./morph-design-model";
import { MorphDesign, MorphQuestion } from "./morph-design-model";

const goSource = readFileSync(join(process.cwd(), "pkg/molten/agentmorphdesign.go"), "utf8");
const tabSource = readFileSync(join(process.cwd(), "pkg/molten/morphdesign/tab.go"), "utf8");

function goString(source: string, name: string): string {
    const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(source);
    expect(match, `${name} in the Go source`).not.toBeNull();
    return match[1];
}

describe("the names the window and wavesrv share", () => {
    it("agree on the route, the events and the commands", () => {
        expect(model.MorphDesignRoute).toBe(goString(goSource, "MorphDesignRoute"));
        expect(model.MorphDesignEvent).toBe(goString(goSource, "MorphDesignEvent"));
        expect(model.MorphDesignHandoffEvent).toBe(goString(goSource, "MorphDesignHandoffEvent"));
        expect(model.MorphDesignTabCommand).toBe(goString(goSource, "MorphDesignTabCommand"));
        expect(model.MorphDesignStateCommand).toBe(goString(goSource, "MorphDesignStateCommand"));
        expect(model.MorphDesignChooseCommand).toBe(goString(goSource, "MorphDesignChooseCommand"));
        expect(model.MorphDesignSkipCommand).toBe(goString(goSource, "MorphDesignSkipCommand"));
        expect(model.MorphDesignDecideCommand).toBe(goString(goSource, "MorphDesignDecideCommand"));
    });

    it("agree on the panel's view and the meta of the tab", () => {
        expect(model.MoltentermMorphDesignView).toBe(goString(tabSource, "View"));
        expect(model.MorphDesignPanelMetaKey).toBe(goString(tabSource, "PanelMetaKey"));
        expect(model.MorphDesignTermMetaKey).toBe(goString(tabSource, "TermMetaKey"));
    });

    it("agree on the steps, in order", () => {
        const listed = /MorphDesignSteps = \[\]string\{([^}]*)\}/.exec(goSource)[1];
        const goSteps = listed
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .map((name) => goString(goSource, name));
        expect(model.MorphSteps).toEqual(goSteps);
    });

    it("know the learning keys of every step, so a skipped step reads as a sentence", () => {
        const keys = Object.keys(LearnedWorkflowInfos[WorkflowMorphDesign].keys);
        for (const step of model.MorphSteps) {
            expect(keys, step).toContain(step);
        }
        expect(keys).toEqual(expect.arrayContaining(["name", "icon", "category"]));
    });
});

function question(over: Partial<MorphQuestion> = {}): MorphQuestion {
    return {
        key: "audience",
        step: "questions",
        text: "Who will use it?",
        kind: "choice",
        choices: [{ label: "Just me" }, { label: "My team" }],
        ...over,
    };
}

function design(over: Partial<MorphDesign> = {}): MorphDesign {
    return {
        mod: "branch-box",
        dir: "/work/app",
        current: "need",
        steps: model.MorphSteps.map((id) => ({ id, state: "todo" as const })),
        questions: [],
        draft: { state: "none", commands: [], boxes: [] },
        updated: 1,
        ...over,
    };
}

function withStep(d: MorphDesign, id: model.MorphStepId, state: "todo" | "done" | "skipped", by?: model.MorphBy) {
    return { ...d, steps: d.steps.map((s) => (s.id === id ? { ...s, state, by } : s)) };
}

function learned(...items: [string, string][]): LearningDefaults {
    return {
        ...emptyDefaults(WorkflowMorphDesign),
        prefill: items.map(([key, value]) => ({
            id: `answer:${key}`,
            kind: "answer",
            key,
            value,
            seen: 1,
            confidence: "low",
            first: 1,
            source: { at: 1, by: "view" },
        })),
    };
}

function foldedDefaults(...steps: string[]): LearningDefaults {
    return {
        ...emptyDefaults(WorkflowMorphDesign),
        folded: steps.map((key) => ({
            id: `skip:${key}`,
            kind: "skip",
            key,
            seen: 2,
            confidence: "medium",
            first: 1,
            source: { at: 1, by: "view" },
        })),
    };
}

describe("reading what wavesrv sends", () => {
    it("reads the panel's target and refuses what is not one", () => {
        expect(model.readMorphDesignTarget({ mod: "branch-box", name: "Branch box", dir: "/work/app" })).toEqual({
            mod: "branch-box",
            name: "Branch box",
            dir: "/work/app",
        });
        expect(model.readMorphDesignTarget({ mod: "x", dir: "/w" })).toEqual({ mod: "x", name: undefined, dir: "/w" });
        for (const bad of [null, undefined, "x", {}, { mod: "x" }, { dir: "/w" }, { mod: "", dir: "/w" }]) {
            expect(model.readMorphDesignTarget(bad), JSON.stringify(bad)).toBeNull();
        }
    });

    it("reads a hand-off only when it can open a tab from it", () => {
        const ok = { id: "h1", mod: "branch-box", dir: "/work", workspaceid: "ws", at: 1 };
        expect(model.readMorphHandoff(ok)).toEqual(ok);
        for (const bad of [
            null,
            {},
            { ...ok, id: "" },
            { ...ok, mod: "" },
            { ...ok, dir: "" },
            { ...ok, workspaceid: "" },
        ]) {
            expect(model.readMorphHandoff(bad), JSON.stringify(bad)).toBeNull();
        }
    });

    it("fills what wavesrv leaves out of a design", () => {
        const d = model.readMorphDesign({ mod: "x", dir: "/w", current: "need", steps: [], updated: 3 });
        expect(d.questions).toEqual([]);
        expect(d.draft).toEqual({ state: "none", commands: [], boxes: [] });
        expect(model.readMorphDesign(null)).toBeNull();
        expect(model.readMorphDesign({ mod: "x" })).toBeNull();
    });

    it("titles the design with the name /morph gave, else the mod's id", () => {
        expect(model.designTitle({ mod: "branch-box", name: "Branch box" })).toBe("Branch box");
        expect(model.designTitle({ mod: "branch-box" })).toBe("branch-box");
    });
});

describe("how a step reads in the panel", () => {
    it("stands out when it is the current one, and says how a settled step was settled", () => {
        let d = design({ current: "plan" });
        expect(model.stepView(d, "plan")).toBe("current");
        expect(model.stepView(d, "preview")).toBe("todo");
        d = withStep(d, "need", "done", "agent");
        expect(model.stepView(d, "need")).toBe("done");
        d = withStep(d, "questions", "done", "terminal");
        expect(model.stepView(d, "questions")).toBe("terminal");
        d = withStep(d, "preview", "skipped", "panel");
        expect(model.stepView(d, "preview")).toBe("skipped");
    });

    it("lists a step's questions, and those still open", () => {
        const d = design({
            questions: [
                question(),
                question({ key: "refresh", answer: "Every minute" }),
                question({ key: "icon", step: "finish" }),
            ],
        });
        expect(model.questionsOf(d, "questions").map((q) => q.key)).toEqual(["audience", "refresh"]);
        expect(model.openQuestions(d, "questions").map((q) => q.key)).toEqual(["audience"]);
        expect(model.questionsOf(d, "finish").map((q) => q.key)).toEqual(["icon"]);
    });

    it("knows when the agent has something to show under a step", () => {
        const empty = design();
        expect(model.stepHasContent(empty, "plan")).toBe(false);
        expect(model.stepHasContent(empty, "preview")).toBe(false);
        expect(
            model.stepHasContent(
                { ...empty, plan: { summary: "x", moltenpart: [], agentpart: [], accesses: [], waits: [] } },
                "plan"
            )
        ).toBe(true);
        expect(model.stepHasContent({ ...empty, draft: { state: "sample", commands: [], boxes: [] } }, "preview")).toBe(
            true
        );
        expect(model.stepHasContent({ ...empty, questions: [question()] }, "questions")).toBe(true);
        expect(
            model.stepHasContent(
                { ...empty, steps: empty.steps.map((s) => (s.id === "adjust" ? { ...s, say: "Wider box" } : s)) },
                "adjust"
            )
        ).toBe(true);
    });
});

describe("prefilling a question from what the developer chose before", () => {
    it("preselects the learned answer when it is one of the choices", () => {
        expect(model.prefilledChoice(question(), learned(["audience", "My team"]))).toBe("My team");
    });

    it("leaves alone what has no learned answer, a learned answer the question no longer offers, and an answered question", () => {
        expect(model.prefilledChoice(question(), learned())).toBeNull();
        expect(model.prefilledChoice(question(), learned(["refresh", "Every minute"]))).toBeNull();
        expect(model.prefilledChoice(question(), learned(["audience", "Everybody"]))).toBeNull();
        expect(model.prefilledChoice(question({ answer: "Just me" }), learned(["audience", "My team"]))).toBeNull();
    });
});

describe("folding a step the developer always skips", () => {
    it("folds a step to do that nothing waits on", () => {
        expect(model.stepFolded(design(), foldedDefaults("preview"), "preview")).toBe(true);
        expect(model.stepFolded(design(), foldedDefaults("preview"), "adjust")).toBe(false);
        expect(model.stepFolded(design(), emptyDefaults(WorkflowMorphDesign), "preview")).toBe(false);
    });

    it("never folds the step in hand, a step with a question waiting, or a step already settled", () => {
        const defaults = foldedDefaults("questions", "plan");
        expect(model.stepFolded(design({ current: "plan" }), defaults, "plan")).toBe(false);
        expect(model.stepFolded(design({ questions: [question()] }), defaults, "questions")).toBe(false);
        expect(model.stepFolded(withStep(design(), "plan", "done", "agent"), defaults, "plan")).toBe(false);
        expect(model.stepFolded(withStep(design(), "plan", "skipped", "panel"), defaults, "plan")).toBe(false);
    });
});

describe("who receives the developer's decisions", () => {
    it("names the agent wavesrv found, and where it is", () => {
        const d = design({
            agent: { blockid: "b1", firstname: "Marion", agent: "claude-code", tabid: "tab-1", here: false },
        });
        expect(model.receiverOf(d, null)).toEqual({
            blockId: "b1",
            name: "Marion · claude-code",
            tabId: "tab-1",
            here: false,
        });
    });

    it("stops naming an agent the window sees ended, before wavesrv publishes the design again", () => {
        const d = design({ agent: { blockid: "b1", firstname: "Marion", agent: "claude-code", tabid: "tab-1" } });
        expect(model.withLiveAgent(d, true)).toBe(d);
        const gone = model.withLiveAgent(d, false);
        expect(gone.agent).toBeUndefined();
        expect(model.receiverOf(gone, null)).toBeNull();
        const none = design();
        expect(model.withLiveAgent(none, false)).toBe(none);
    });

    it("falls back to an agent running in the design's own terminal, which wavesrv has not seen yet", () => {
        const d = design({ tabid: "tab-design" });
        expect(model.receiverOf(d, { blockId: "b2", name: "Jérôme · codex" })).toEqual({
            blockId: "b2",
            name: "Jérôme · codex",
            tabId: "tab-design",
            here: true,
        });
        expect(model.receiverOf(d, null)).toBeNull();
    });
});
