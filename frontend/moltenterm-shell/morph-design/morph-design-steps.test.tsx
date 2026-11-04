// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The steps of the mod design panel (FR-MORPH-019), in English and French: the plain words, the choices to click, the
// plan, the preview, the way out of every step, the learned answer and the folded step.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { I18nModel } from "../i18n/i18n";
import { emptyDefaults, LearningDefaults, WorkflowMorphDesign } from "../learning/learning-model";
import type { DesignActions } from "./morph-design-actions";
import { MorphDesign, MorphQuestion, MorphStepId, MorphSteps } from "./morph-design-model";
import { StepBlock, StepProps } from "./morph-design-steps";

afterEach(async () => {
    I18nModel.getInstance().setLanguageSetting("en");
    await I18nModel.getInstance().whenReady();
});

async function french() {
    I18nModel.getInstance().setLanguageSetting("fr");
    await I18nModel.getInstance().whenReady();
}

const NoActions = {} as DesignActions;

function design(over: Partial<MorphDesign> = {}): MorphDesign {
    return {
        mod: "branch-box",
        name: "Branch box",
        dir: "/work/app",
        current: "need",
        steps: MorphSteps.map((id) => ({ id, state: "todo" as const })),
        questions: [],
        draft: { state: "none", commands: [], boxes: [] },
        updated: 1,
        ...over,
    };
}

function question(over: Partial<MorphQuestion> = {}): MorphQuestion {
    return {
        key: "audience",
        step: "questions",
        text: "Who will use it?",
        kind: "choice",
        choices: [{ label: "Just me" }, { label: "My team", detail: "Shared in the project" }],
        recommended: "Just me",
        ...over,
    };
}

function settle(d: MorphDesign, id: MorphStepId, state: "done" | "skipped", by: "agent" | "panel" | "terminal") {
    return { ...d, steps: d.steps.map((s) => (s.id === id ? { ...s, state, by } : s)) };
}

function render(id: MorphStepId, d: MorphDesign, over: Partial<StepProps> = {}): string {
    return renderToStaticMarkup(
        <StepBlock
            id={id}
            design={d}
            defaults={emptyDefaults(WorkflowMorphDesign)}
            actions={NoActions}
            busy=""
            run={() => {}}
            focusTerminal={() => {}}
            {...over}
        />
    );
}

function learnedDefaults(key: string, value: string): LearningDefaults {
    return {
        ...emptyDefaults(WorkflowMorphDesign),
        prefill: [
            {
                id: `answer:${key}`,
                kind: "answer",
                key,
                value,
                seen: 2,
                confidence: "medium",
                first: 1,
                source: { at: 1, by: "view" },
            },
        ],
    };
}

function foldedDefaults(step: string): LearningDefaults {
    return {
        ...emptyDefaults(WorkflowMorphDesign),
        folded: [
            {
                id: `skip:${step}`,
                kind: "skip",
                key: step,
                seen: 2,
                confidence: "medium",
                first: 1,
                source: { at: 1, by: "view" },
            },
        ],
    };
}

describe("every step in plain words", () => {
    it("titles each step with a label chip and describes it in one line", () => {
        for (const id of MorphSteps) {
            const html = render(id, design());
            expect(html, id).toContain(`data-testid="morph-step-${id}"`);
            expect(html, id).toContain("df-chip");
            expect(html, id).toContain("df-block-desc");
        }
        expect(render("need", design())).toContain("Your need");
        expect(render("questions", design())).toContain("A few questions");
        expect(render("finish", design())).toContain("Name, icon and category");
        expect(render("collect", design())).toContain("Your mods");
    });

    it("lights the current step and says so", () => {
        const html = render("plan", design({ current: "plan" }));
        expect(html).toContain('data-status="current"');
        expect(html).toContain("Current step");
        expect(html).toMatch(/df-glow"[^>]*data-on/);
        expect(render("plan", design())).not.toMatch(/df-glow"[^>]*data-on/);
    });

    it("reads in French", async () => {
        await french();
        const html = render("questions", design({ current: "questions", questions: [question()] }));
        expect(html).toContain("Quelques questions");
        expect(html).toContain("Étape en cours");
        expect(html).toContain("Passer cette étape");
        expect(html).toContain("Je le fais dans le terminal");
        expect(html).toContain("Ou répondez dans le terminal à gauche.");
    });

    it("shows the sentence the agent set under the step", () => {
        const d = design({
            steps: design().steps.map((s) => (s.id === "need" ? { ...s, say: "A box that shows the branch" } : s)),
        });
        const html = render("need", d);
        expect(html).toContain("A box that shows the branch");
        expect(html).not.toContain("morph-step-empty");
    });
});

describe("never blocking: every step has a way out", () => {
    it("offers to skip it or to do it in the terminal, on each step", () => {
        for (const id of MorphSteps) {
            const html = render(id, design());
            expect(html, id).toContain('data-testid="morph-step-skip"');
            expect(html, id).toContain('data-testid="morph-step-terminal"');
            expect(html, id).toContain("Skip this step");
            expect(html, id).toContain("I&#x27;ll do it in the terminal");
        }
    });

    it("lets a skipped step be taken back, and shows nothing of its body", () => {
        const html = render(
            "plan",
            settle(
                design({ plan: { summary: "A box.", moltenpart: [], agentpart: [], accesses: [], waits: [] } }),
                "plan",
                "skipped",
                "panel"
            )
        );
        expect(html).toContain('data-status="skipped"');
        expect(html).toContain("Skipped");
        expect(html).toContain('data-testid="morph-step-back"');
        expect(html).toContain("Take it back");
        expect(html).not.toContain("morph-plan-summary");
        expect(html).not.toContain('data-testid="morph-step-skip"');
    });

    it("says a step was done in the terminal", () => {
        const html = render("questions", settle(design(), "questions", "done", "terminal"));
        expect(html).toContain("Done in the terminal");
        expect(html).not.toContain('data-testid="morph-step-skip"');
    });

    it("waits on the one control that was clicked", () => {
        const html = render("preview", design(), { busy: "skip:preview" });
        expect(html).toContain("df-domino-loader");
        expect(html).toMatch(/data-testid="morph-step-skip"/);
        expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(2);
    });
});

describe("questions to click", () => {
    it("lists the choices as option rows, the recommended one marked, with the terminal as the other way", () => {
        const html = render("questions", design({ current: "questions", questions: [question()] }));
        expect(html).toContain("Who will use it?");
        expect(html).toContain('role="radiogroup"');
        expect(html.match(/type="radio"/g)).toHaveLength(2);
        expect(html).toContain("Just me");
        expect(html).toContain("Recommended");
        expect(html).toContain("Shared in the project");
        expect(html).toContain("Or answer in the terminal on the left.");
    });

    it("marks the choice that comes from the developer's earlier runs, without selecting it for them", () => {
        const html = render("questions", design({ questions: [question()] }), {
            defaults: learnedDefaults("audience", "My team"),
        });
        expect(html).toContain('data-testid="learning-prefill-mark"');
        expect(html).toContain("Based on your earlier choices");
        expect(html).not.toContain("checked");
    });

    it("shows the answer, wherever it was given", () => {
        const html = render("questions", design({ questions: [question({ answer: "My team", answeredby: "panel" })] }));
        expect(html).toContain("checked");
        expect(html).toContain("Selected");
        expect(html).not.toContain("Or answer in the terminal");
        const typed = render(
            "questions",
            design({ questions: [question({ answer: "My whole company", answeredby: "terminal", choices: [] })] })
        );
        expect(typed).toContain("Answered: My whole company");
        expect(typed).toContain("in the terminal");
    });

    it("draws the choices of an icon question as icons", () => {
        const icons = question({
            key: "icon",
            step: "finish",
            kind: "icon",
            text: "Which icon?",
            choices: [{ label: "code-branch" }, { label: "clock" }],
        });
        const html = render("finish", design({ current: "finish", questions: [icons] }));
        expect(html).toContain("fa-code-branch");
        expect(html).toContain("fa-clock");
    });

    it("waits on the question being sent", () => {
        const html = render("questions", design({ questions: [question()] }), { busy: "choose:audience:My team" });
        expect(html).toContain("df-domino-loader");
        expect(html).toContain("disabled");
    });

    it("says what to expect when nothing was asked", () => {
        expect(render("questions", design())).toContain("A request that is clear enough gets none.");
    });
});

describe("the plan", () => {
    const plan = {
        summary: "A box next to the terminal that shows the branch.",
        moltenpart: ["the branch command", "the box"],
        agentpart: ["a slash command"],
        accesses: ["the branch name, passed in by the shell"],
        waits: ["the status bar item waits for story #726"],
    };

    it("shows what goes where, what it will access and what waits, and keeps the approval for the trust prompt", () => {
        const html = render("plan", design({ current: "plan", plan }));
        expect(html).toContain("A box next to the terminal that shows the branch.");
        for (const text of [
            "In MoltenTerm",
            "the branch command",
            "In the agent",
            "a slash command",
            "What it will access",
            "What waits",
            "story #726",
        ]) {
            expect(html, text).toContain(text);
        }
        expect(html).toContain("Accesses are approved in MoltenTerm&#x27;s trust prompt, not here.");
    });

    it("says nothing else when the plan lists no access", () => {
        expect(render("plan", design({ plan: { ...plan, accesses: [] } }))).toContain("Nothing else");
    });

    it("offers to agree or to change something, and says once the developer agreed", () => {
        const open = render("plan", design({ current: "plan", plan }));
        expect(open).toContain('data-testid="morph-plan-agree"');
        expect(open).toContain("molten-btn");
        expect(open).toContain("I agree");
        expect(open).toContain("Change something");
        const agreed = render("plan", design({ plan: { ...plan, agreed: true, agreedby: "panel" } }));
        expect(agreed).toContain("You agreed to this plan.");
        expect(agreed).not.toContain('data-testid="morph-plan-agree"');
    });
});

describe("the live preview", () => {
    it("shows what API version 1 draws, and an empty placeholder where the declarative panel will plug in", () => {
        const html = render(
            "preview",
            design({
                draft: { state: "sample", commands: ["branch"], boxes: ["Branch"], note: "Invented branch names" },
            })
        );
        expect(html).toContain("Draft");
        expect(html).toContain("Invented sample data");
        expect(html).toContain("Invented branch names");
        expect(html).toContain("Commands");
        expect(html).toContain("branch");
        expect(html).toContain("Boxes");
        expect(html).toContain('data-testid="morph-preview-placeholder"');
        expect(html).toContain("Soon");
    });

    it("says the data is real once it is", () => {
        expect(render("preview", design({ draft: { state: "real", commands: [], boxes: [] } }))).toContain("Real data");
    });

    it("says there is nothing yet, and still shows the placeholder, in French as well", async () => {
        await french();
        const html = render("preview", design());
        expect(html).toContain("Rien à montrer pour l&#x27;instant");
        expect(html).toContain("Bientôt");
    });
});

describe("validation and collection", () => {
    it("offers to validate or give up, and asks before giving up", () => {
        const html = render("validate", design({ current: "validate" }));
        expect(html).toContain('data-testid="morph-validate"');
        expect(html).toContain("Validate");
        expect(html).toContain('data-testid="morph-giveup"');
        expect(html).not.toContain("morph-giveup-confirm");
    });

    it("says what the developer decided", () => {
        expect(render("validate", design({ outcome: "validated" }))).toContain("You validated the tool.");
        const gaveUp = render("validate", design({ outcome: "gaveup" }));
        expect(gaveUp).toContain("You gave the tool up");
        expect(gaveUp).not.toContain('data-testid="morph-validate"');
    });

    it("tells that the Your mods page and the icon and category storage come later, not that they are missing", async () => {
        expect(render("collect", design())).toContain("The Your mods page arrives soon.");
        expect(render("finish", design())).toContain("Soon.");
        await french();
        expect(render("collect", design())).toContain("La page Vos mods arrive bientôt.");
        expect(render("finish", design())).toContain("Bientôt.");
    });
});

describe("learning", () => {
    it("folds a step the developer always skips to one calm row, still one click away", () => {
        const html = render("preview", design(), { defaults: foldedDefaults("preview") });
        expect(html).toContain('data-testid="morph-folded-preview"');
        expect(html).toContain("You usually skip this step.");
        expect(html).toContain("Show");
        expect(html).not.toContain('data-testid="morph-step-preview"');
    });

    it("never folds the step in hand", () => {
        const html = render("preview", design({ current: "preview" }), { defaults: foldedDefaults("preview") });
        expect(html).toContain('data-testid="morph-step-preview"');
        expect(html).not.toContain("morph-folded-preview");
    });
});
