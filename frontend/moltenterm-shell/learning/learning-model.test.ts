// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The rules a workflow reads what it learned by (FR-LRN-001, FR-LRN-002): which answers to prefill, which steps to fold,
// which adjustments a finished run records. Pure functions, no app.

import { describe, expect, it } from "vitest";
import { t } from "../i18n/i18n";
import {
    applyPrefill,
    confidenceKey,
    correctionsToLearn,
    emptyDefaults,
    FlagOff,
    FlagOn,
    FoldAfterSeen,
    foldedSteps,
    holdsValue,
    isFolded,
    itemSentence,
    itemTitle,
    KindAnswer,
    KindCorrection,
    KindPreference,
    KindSkip,
    LearningDefaults,
    LearningItem,
    PrefillField,
    prefillItem,
    prefillMap,
    prefillValue,
    runLabel,
    stillPrefilled,
    valueText,
    WorkflowPipelineSetup,
} from "./learning-model";

function item(over: Partial<LearningItem> & Pick<LearningItem, "kind" | "key">): LearningItem {
    return {
        id: `${over.kind}:${over.key}`,
        seen: 1,
        confidence: "low",
        first: 1,
        source: { at: 2, by: "view" },
        ...over,
    };
}

const defaults: LearningDefaults = {
    workflow: WorkflowPipelineSetup,
    prefill: [
        item({ kind: KindCorrection, key: "merge", value: "squash", proposed: "merge", seen: 3 }),
        item({ kind: KindPreference, key: "tagprefix", value: "rel-" }),
        item({ kind: KindAnswer, key: "merge", value: "rebase" }),
    ],
    folded: [
        item({ kind: KindSkip, key: "template", seen: FoldAfterSeen }),
        item({ kind: KindSkip, key: "icon", seen: FoldAfterSeen - 1 }),
    ],
};

describe("what a workflow reads when it starts", () => {
    it("offers the most seen item of a key, once", () => {
        expect(prefillItem(defaults, "merge").value).toBe("squash");
        expect(prefillValue(defaults, "merge")).toBe("squash");
        expect(prefillValue(defaults, "nothing")).toBeNull();
        const map = prefillMap(defaults);
        expect(Object.keys(map).sort()).toEqual(["merge", "tagprefix"]);
        expect(map.merge.value).toBe("squash");
    });

    it("folds a step skipped in enough runs in a row, and only that one", () => {
        expect(foldedSteps(defaults)).toEqual(["template"]);
        expect(isFolded(defaults, "template")).toBe(true);
        expect(isFolded(defaults, "icon")).toBe(false);
        expect(isFolded(defaults, "unknown")).toBe(false);
    });

    it("learned nothing is not an error", () => {
        for (const none of [emptyDefaults("x"), null, undefined]) {
            expect(prefillValue(none, "merge")).toBeNull();
            expect(prefillMap(none)).toEqual({});
            expect(foldedSteps(none)).toEqual([]);
            expect(isFolded(none, "template")).toBe(false);
        }
    });

    it("tells the kinds that hold a value", () => {
        expect([KindAnswer, KindCorrection, KindPreference].every(holdsValue)).toBe(true);
        expect(holdsValue(KindSkip)).toBe(false);
        expect(holdsValue("done")).toBe(false);
    });
});

type Options = { merge: string; tagprefix: string; notes: boolean };

const fields: PrefillField<Options>[] = [
    {
        key: "merge",
        read: (o) => o.merge,
        write: (o, text) => ({ ...o, merge: text }),
        allowed: (_o, text) => ["merge", "squash"].includes(text),
    },
    { key: "tagprefix", read: (o) => o.tagprefix, write: (o, text) => ({ ...o, tagprefix: text }) },
    {
        key: "notes",
        read: (o) => String(o.notes),
        write: (o, text) => ({ ...o, notes: text === "true" }),
    },
];

describe("prefilling a workflow's values", () => {
    const proposal: Options = { merge: "merge", tagprefix: "v", notes: false };

    it("writes the learned values in and says which ones it changed", () => {
        const filled = applyPrefill(proposal, defaults, fields);
        expect(filled.values).toEqual({ merge: "squash", tagprefix: "rel-", notes: false });
        expect(filled.prefilled).toEqual({ merge: "squash", tagprefix: "rel-" });
        expect(proposal).toEqual({ merge: "merge", tagprefix: "v", notes: false });
    });

    it("does not mark a field that already held the learned value", () => {
        const filled = applyPrefill({ ...proposal, tagprefix: "rel-" }, defaults, fields);
        expect(filled.prefilled).toEqual({ merge: "squash" });
    });

    it("leaves a field the workflow refuses the learned value for", () => {
        const refusing: LearningDefaults = {
            ...defaults,
            prefill: [item({ kind: KindCorrection, key: "merge", value: "rebase", seen: 4 })],
        };
        const filled = applyPrefill(proposal, refusing, fields);
        expect(filled.values).toBe(proposal);
        expect(filled.prefilled).toEqual({});
    });

    it("ignores an empty learned value and an unknown key", () => {
        const odd: LearningDefaults = {
            ...defaults,
            prefill: [
                item({ kind: KindAnswer, key: "tagprefix", value: "" }),
                item({ kind: KindAnswer, key: "zzz", value: "x" }),
            ],
        };
        expect(applyPrefill(proposal, odd, fields).prefilled).toEqual({});
    });

    it("keeps the mark only while the field holds the prefilled value", () => {
        const filled = applyPrefill(proposal, defaults, fields);
        expect(stillPrefilled(filled.values, filled.prefilled, fields)).toEqual(["merge", "tagprefix"]);
        const edited = { ...filled.values, merge: "merge" };
        expect(stillPrefilled(edited, filled.prefilled, fields)).toEqual(["tagprefix"]);
        expect(stillPrefilled(edited, {}, fields)).toEqual([]);
    });
});

describe("what a finished run teaches", () => {
    const proposal: Options = { merge: "merge", tagprefix: "v", notes: false };

    it("records the choices ended on another value than the proposal, with the proposal", () => {
        const actions = correctionsToLearn(
            { merge: "squash", tagprefix: "v", notes: true },
            proposal,
            emptyDefaults("w"),
            fields
        );
        expect(actions).toEqual([
            { op: "record", kind: KindCorrection, key: "merge", value: "squash", proposed: "merge" },
            { op: "record", kind: KindCorrection, key: "notes", value: "true", proposed: "false" },
        ]);
    });

    it("confirms a correction an earlier run left by recording it again", () => {
        const actions = correctionsToLearn(
            { merge: "squash", tagprefix: "rel-", notes: false },
            proposal,
            defaults,
            fields
        );
        expect(actions).toEqual([
            { op: "record", kind: KindCorrection, key: "merge", value: "squash", proposed: "merge" },
            { op: "record", kind: KindCorrection, key: "tagprefix", value: "rel-", proposed: "v" },
        ]);
    });

    it("forgets a correction the developer put back to the proposal", () => {
        const actions = correctionsToLearn(proposal, proposal, defaults, fields);
        expect(actions).toEqual([
            { op: "forget", id: "correction:merge" },
            { op: "forget", id: "preference:tagprefix" },
        ]);
    });

    it("learns nothing from a run that changed nothing", () => {
        expect(correctionsToLearn(proposal, proposal, emptyDefaults("w"), fields)).toEqual([]);
    });

    it("learns nothing from an empty field", () => {
        const blank = { merge: "merge", tagprefix: "", notes: false };
        expect(correctionsToLearn(blank, proposal, emptyDefaults("w"), fields)).toEqual([]);
    });
});

describe("run labels", () => {
    it("are one line, trimmed and cut to the store's bound", () => {
        expect(runLabel("  my\nproject\t ")).toBe("my project");
        expect(runLabel("a".repeat(200))).toHaveLength(80);
        expect(runLabel(null)).toBe("");
        expect(runLabel("é".repeat(81))).toBe("é".repeat(80));
    });
});

describe("plain words", () => {
    it("words a pipeline setup correction with its proposal", () => {
        const merge = item({ kind: KindCorrection, key: "merge", value: "squash", proposed: "merge" });
        expect(itemSentence(WorkflowPipelineSetup, merge, t)).toBe(
            "How the release branch is reached: you choose Squash instead of Merge commit (fast-forward when possible)."
        );
        expect(itemTitle(WorkflowPipelineSetup, merge, t)).toBe("How the release branch is reached");
    });

    it("words switches as yes or no and free text as it is", () => {
        const notes = item({ kind: KindCorrection, key: "notes", value: FlagOn, proposed: FlagOff });
        expect(itemSentence(WorkflowPipelineSetup, notes, t)).toBe(
            "Release notes rewritten with the coding agent: you choose yes instead of no."
        );
        const prefix = item({ kind: KindPreference, key: "tagprefix", value: "rel-" });
        expect(itemSentence(WorkflowPipelineSetup, prefix, t)).toBe("Tag prefix: you prefer rel-.");
        expect(valueText(WorkflowPipelineSetup, "tagprefix", "rel-", t)).toBe("rel-");
    });

    it("shows what an agent recorded for a key the interface does not know as it was recorded", () => {
        const unknown = item({ kind: KindAnswer, key: "audience", value: "team" });
        expect(itemSentence("morph-design", unknown, t)).toBe("audience: you answered team.");
        expect(itemSentence("other-workflow", unknown, t)).toBe("audience: you answered team.");
        const odd = item({ kind: KindCorrection, key: "merge", value: "<b>x</b>" });
        expect(itemSentence(WorkflowPipelineSetup, odd, t)).toContain("<b>x</b>");
    });

    it("words a skipped step and the confidence levels", () => {
        expect(itemSentence("morph-design", item({ kind: KindSkip, key: "icon" }), t)).toBe("You skip icon.");
        expect(["low", "medium", "high", "other"].map((c) => t(confidenceKey(c)))).toEqual([
            "tentative",
            "likely",
            "settled",
            "tentative",
        ]);
    });
});
