// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the pipeline setup learns of the developer (FR-LRN-004, DS-LRN-005): the six choices of the description step,
// where a learned value may go, what a finished run teaches, and the marks on the choices.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
    applyPrefill,
    emptyDefaults,
    KindCorrection,
    LearningDefaults,
    LearningItem,
    stillPrefilled,
    WorkflowPipelineSetup,
} from "../learning/learning-model";
import { ChoicesStep } from "./release-setup";
import { learnsFrom, pipelineLearningFields, PipelineLearningKeys, pipelineLessons } from "./release-setup-learning";
import type { SetupDraft, SetupOptions } from "./release-setup-model";

const proposal: SetupOptions = {
    kind: "on-premise",
    channels: ["rc", "public"],
    branchmodel: "promote",
    merge: "merge",
    tagprefix: "v",
    rcformat: "numeric",
    changelogs: [],
    ciworkflows: [],
    dispatch: [],
    notes: false,
    notespath: "releases/{tag}.md",
    syncback: true,
    milestone: true,
    manual: [],
    environments: [],
    reconcile: false,
    labels: [],
};

function makeDraft(
    over: Partial<{ ongithub: boolean; merges: SetupDraft["merges"]; rcformats: SetupDraft["rcformats"] }> = {}
): SetupDraft {
    return {
        facts: {
            ongithub: over.ongithub ?? true,
            branches: { trunk: "develop", release: "main" },
            changelogs: [],
            workflows: [],
            targets: [],
            labels: [],
        },
        defaults: proposal,
        options: proposal,
        merges: over.merges ?? [
            { id: "merge", allowed: true },
            { id: "squash", allowed: true },
            { id: "rebase", allowed: false },
        ],
        rcformats: over.rcformats ?? [
            { id: "numeric", allowed: true },
            { id: "rcdot", allowed: true },
        ],
        branchmodels: [{ id: "promote", allowed: true }],
        deploytargets: [],
        tagworkflows: { rc: [], public: [] },
        proposal: { sources: {} },
    } as unknown as SetupDraft;
}

function learnt(key: string, value: string, seen = 1): LearningItem {
    return {
        id: `correction:${key}`,
        kind: KindCorrection,
        key,
        value,
        proposed: "x",
        seen,
        confidence: "low",
        first: 1,
        source: { at: 2, by: "view" },
    };
}

function learntDefaults(...items: LearningItem[]): LearningDefaults {
    return { workflow: WorkflowPipelineSetup, prefill: items, folded: [] };
}

describe("the choices the pipeline setup learns", () => {
    it("are the six habits and not the facts about a project", () => {
        expect(pipelineLearningFields(makeDraft()).map((f) => f.key)).toEqual([...PipelineLearningKeys]);
        expect(PipelineLearningKeys).not.toContain("branchmodel");
    });

    it("prefill the proposal with what the developer chose before, and mark only what changed", () => {
        const draft = makeDraft();
        const learned = learntDefaults(
            learnt("merge", "squash", 2),
            learnt("tagprefix", "rel-"),
            learnt("notes", "true"),
            learnt("syncback", "true")
        );
        const filled = applyPrefill(proposal, learned, pipelineLearningFields(draft));
        expect(filled.values).toMatchObject({ merge: "squash", tagprefix: "rel-", notes: true, syncback: true });
        expect(filled.prefilled).toEqual({ merge: "squash", tagprefix: "rel-", notes: "true" });
        expect(stillPrefilled(filled.values, filled.prefilled, pipelineLearningFields(draft))).toEqual([
            "merge",
            "tagprefix",
            "notes",
        ]);
        expect(
            stillPrefilled({ ...filled.values, merge: "merge" }, filled.prefilled, pipelineLearningFields(draft))
        ).toEqual(["tagprefix", "notes"]);
    });

    it("leave a value the draft refuses, a prefix that is not one, and a switch the project has no use for", () => {
        const noGithub = makeDraft({ ongithub: false });
        const learned = learntDefaults(
            learnt("merge", "rebase"),
            learnt("rcformat", "unknown"),
            learnt("tagprefix", "not a prefix!"),
            learnt("notes", "maybe"),
            learnt("milestone", "false")
        );
        const filled = applyPrefill(proposal, learned, pipelineLearningFields(noGithub));
        expect(filled.values).toBe(proposal);
        expect(filled.prefilled).toEqual({});
        const single = applyPrefill(
            { ...proposal, branchmodel: "single", syncback: false },
            learntDefaults(learnt("syncback", "true")),
            pipelineLearningFields(makeDraft())
        );
        expect(single.prefilled).toEqual({});
    });

    it("fill a candidate format the draft allows", () => {
        const filled = applyPrefill(
            proposal,
            learntDefaults(learnt("rcformat", "rcdot")),
            pipelineLearningFields(makeDraft())
        );
        expect(filled.values.rcformat).toBe("rcdot");
        const refused = makeDraft({
            rcformats: [
                { id: "numeric", allowed: true },
                { id: "rcdot", allowed: false },
            ],
        });
        expect(
            applyPrefill(proposal, learntDefaults(learnt("rcformat", "rcdot")), pipelineLearningFields(refused))
                .prefilled
        ).toEqual({});
    });
});

describe("what a finished run teaches the pipeline setup", () => {
    it("records the choices that differ from the proposal, with the proposal", () => {
        const lessons = pipelineLessons(
            makeDraft(),
            { ...proposal, merge: "squash", tagprefix: "rel-", notes: true },
            emptyDefaults(WorkflowPipelineSetup)
        );
        expect(lessons).toEqual([
            { op: "record", kind: "correction", key: "merge", value: "squash", proposed: "merge" },
            { op: "record", kind: "correction", key: "tagprefix", value: "rel-", proposed: "v" },
            { op: "record", kind: "correction", key: "notes", value: "true", proposed: "false" },
        ]);
    });

    it("forgets the habit the developer put back to the proposal, and confirms the one kept", () => {
        const learned = learntDefaults(learnt("merge", "squash", 2), learnt("tagprefix", "rel-"));
        const lessons = pipelineLessons(makeDraft(), { ...proposal, tagprefix: "rel-" }, learned);
        expect(lessons).toEqual([
            { op: "forget", id: "correction:merge" },
            { op: "record", kind: "correction", key: "tagprefix", value: "rel-", proposed: "v" },
        ]);
    });

    it("learns nothing without a draft or options", () => {
        expect(pipelineLessons(null, proposal, emptyDefaults("x"))).toEqual([]);
        expect(pipelineLessons(makeDraft(), null, emptyDefaults("x"))).toEqual([]);
    });
});

describe("when the pipeline setup learns", () => {
    it("only from the description that started from the standard questions", () => {
        expect(learnsFrom("describe", "standard", "on-premise")).toBe(true);
        expect(learnsFrom("describe", "model", "on-premise")).toBe(false);
        expect(learnsFrom("describe", "template", "on-premise")).toBe(false);
        expect(learnsFrom("describe", "words", "on-premise")).toBe(false);
        expect(learnsFrom("analyse", "standard", "on-premise")).toBe(false);
        expect(learnsFrom("describe", "standard", "saas")).toBe(false);
    });
});

describe("the marks on the choices", () => {
    const draft = makeDraft();
    function choices(prefilledKeys?: string[]): string {
        return renderToStaticMarkup(
            <ChoicesStep
                draft={draft}
                options={proposal}
                onChange={() => {}}
                channel="public"
                setChannel={() => {}}
                bare
                prefilledKeys={prefilledKeys}
            />
        );
    }

    it("shows no mark when nothing was prefilled", () => {
        expect(choices()).not.toContain("learning-prefill-mark");
        expect(choices([])).not.toContain("learning-prefill-mark");
    });

    it("marks the block of each prefilled choice, once per block", () => {
        expect(choices(["merge"]).match(/learning-prefill-mark/g)).toHaveLength(1);
        expect(choices(["tagprefix", "rcformat"]).match(/learning-prefill-mark/g)).toHaveLength(1);
        expect(choices(["notes"]).match(/learning-prefill-mark/g)).toHaveLength(1);
        expect(choices(["milestone", "syncback"]).match(/learning-prefill-mark/g)).toHaveLength(1);
        expect(choices(["merge", "tagprefix", "notes", "syncback"]).match(/learning-prefill-mark/g)).toHaveLength(4);
        expect(choices(["merge"])).toContain("Based on your earlier choices");
    });
});
