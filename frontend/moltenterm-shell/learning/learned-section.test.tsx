// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// "What MoltenTerm learned" (FR-LRN-003) and the marks a workflow view shows (FR-LRN-002): the list in plain words in
// English and French, the edit choices, the empty state, the prefill mark and the folded step.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { I18nModel, t, tCount } from "../i18n/i18n";
import { editChoices, itemMeta, LearnedWorkflowBody, workflowName } from "./learned-section";
import {
    KindAnswer,
    KindCorrection,
    KindPreference,
    KindSkip,
    LearningItem,
    WorkflowPipelineSetup,
} from "./learning-model";
import { FoldedStep, PrefillMark } from "./prefill-mark";

function item(over: Partial<LearningItem> & Pick<LearningItem, "kind" | "key">): LearningItem {
    return {
        id: `${over.kind}:${over.key}`,
        seen: 1,
        confidence: "low",
        first: 1,
        source: { at: Date.UTC(2026, 10, 4, 12), by: "view" },
        ...over,
    };
}

const items: LearningItem[] = [
    item({
        kind: KindCorrection,
        key: "merge",
        value: "squash",
        proposed: "merge",
        seen: 3,
        confidence: "high",
        source: { at: Date.UTC(2026, 10, 4, 12), by: "view", run: "moltenterm" },
    }),
    item({
        kind: KindPreference,
        key: "tagprefix",
        value: "rel-",
        seen: 2,
        confidence: "medium",
        source: { at: Date.UTC(2026, 10, 3, 12), by: "agent" },
        edited: false,
    }),
    item({
        kind: KindSkip,
        key: "template",
        seen: 2,
        confidence: "medium",
        source: { at: Date.UTC(2026, 10, 2, 12), by: "user" },
    }),
    item({ kind: KindAnswer, key: "audience", value: "<img src=x onerror=alert(1)>" }),
];

afterEach(async () => {
    I18nModel.getInstance().setLanguageSetting("en");
    await I18nModel.getInstance().whenReady();
});

function body(workflow: string, list: LearningItem[]): string {
    return renderToStaticMarkup(<LearnedWorkflowBody workflow={workflow} items={list} onChanged={() => {}} />);
}

describe("the list of what was learned", () => {
    it("reads each item as a plain sentence with how often it was seen, and by whom", () => {
        const html = body(WorkflowPipelineSetup, items);
        expect(html).toContain("How the release branch is reached: you choose Squash instead of Merge commit");
        expect(html).toContain("Tag prefix: you prefer rel-.");
        expect(html).toContain("You skip template.");
        expect(html).toContain("Seen 3 times, settled");
        expect(html).toContain("run moltenterm");
        expect(html).toContain("recorded by an agent");
        expect(html).toContain("edited by you");
        expect(html).toContain("Seen 1 time, tentative");
    });

    it("offers Edit on a value and Forget on every item, and Reset on the workflow", () => {
        const html = body(WorkflowPipelineSetup, items);
        expect(html.match(/data-testid="learning-forget"/g)).toHaveLength(4);
        expect(html.match(/data-testid="learning-edit"/g)).toHaveLength(3);
        expect(html).toContain("Reset this workflow");
        expect(html).not.toContain("learning-reset-confirm");
    });

    it("shows a recorded value as text, never as markup", () => {
        const html = body(WorkflowPipelineSetup, items);
        expect(html).not.toContain("<img");
        expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    });

    it("says nothing was learned for a workflow with nothing", () => {
        const html = body(WorkflowPipelineSetup, []);
        expect(html).toContain("Nothing learned yet in Pipeline setup.");
        expect(html).not.toContain("learning-reset");
    });

    it("speaks French", async () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        await I18nModel.getInstance().whenReady();
        const html = body(WorkflowPipelineSetup, items);
        expect(html).toContain("Arrivée sur la branche de release : vous choisissez Squash plutôt que");
        expect(html).toContain("Préfixe des tags : vous préférez rel-.");
        expect(html).toContain("Vu 3 fois, acquis");
        expect(html).toContain("noté par un agent");
        expect(html).toContain("Remettre ce parcours à zéro");
        expect(body(WorkflowPipelineSetup, [])).toContain("Rien n’a encore été appris dans Mise en place du pipeline.");
    });

    it("names the workflows, and an unknown one by its id", () => {
        expect(workflowName(WorkflowPipelineSetup, t)).toBe("Pipeline setup");
        expect(workflowName("morph-design", t)).toBe("Mod design");
        expect(workflowName("other", t)).toBe("other");
    });
});

describe("editing an item", () => {
    it("offers the options of a choice, yes or no for a switch, nothing for free text", () => {
        const merge = item({ kind: KindCorrection, key: "merge", value: "squash" });
        expect(editChoices(WorkflowPipelineSetup, merge, t).map((c) => c.value)).toEqual(["merge", "squash", "rebase"]);
        const notes = item({ kind: KindCorrection, key: "notes", value: "true" });
        expect(editChoices(WorkflowPipelineSetup, notes, t)).toEqual([
            { value: "true", label: "yes" },
            { value: "false", label: "no" },
        ]);
        expect(editChoices(WorkflowPipelineSetup, items[1], t)).toEqual([]);
        expect(editChoices("morph-design", items[3], t)).toEqual([]);
    });
});

describe("an item's source line", () => {
    it("joins the count, the confidence, the author, the run and the date", () => {
        const text = itemMeta(items[0], t, tCount, "en");
        // The day follows the machine's time zone: noon UTC is the 4th or the 5th.
        expect(text).toMatch(/^Seen 3 times, settled · run moltenterm · Nov [45], 2026$/);
        expect(itemMeta(items[1], t, tCount, "en")).toMatch(
            /^Seen 2 times, likely · recorded by an agent · Nov [34], 2026$/
        );
    });
});

describe("the marks a workflow view shows", () => {
    it("marks a prefilled answer as based on the earlier choices", () => {
        const html = renderToStaticMarkup(<PrefillMark />);
        expect(html).toContain("Based on your earlier choices");
        expect(html).toContain('data-testid="learning-prefill-mark"');
    });

    it("folds a step to one row with a way to open it, and shows an unfolded step as it is", () => {
        const folded = renderToStaticMarkup(
            <FoldedStep folded title="Save as a template">
                <div data-testid="the-step">The step</div>
            </FoldedStep>
        );
        expect(folded).toContain("Save as a template");
        expect(folded).toContain("You usually skip this step.");
        expect(folded).toContain("Show");
        expect(folded).not.toContain("the-step");
        const shown = renderToStaticMarkup(
            <FoldedStep folded={false} title="Save as a template">
                <div data-testid="the-step">The step</div>
            </FoldedStep>
        );
        expect(shown).toContain("the-step");
        expect(shown).not.toContain("You usually skip");
    });
});
