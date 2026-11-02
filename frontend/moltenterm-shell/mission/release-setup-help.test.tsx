// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nModel } from "../i18n/i18n";
import { PipelineTabContext } from "./pipeline-tab-context";
import { HelpScope, QuestionButton } from "./release-setup-help";
import { AskAgent, helpContextOf, pipelineContextOf, plainContextOf, SetupHelp } from "./release-setup-help-model";

const Dir = "/tmp/project";

function screen(askAgent?: AskAgent) {
    const tree = (
        <HelpScope dir={Dir} screen="flow" context={"Public release:\n1. Prepare"}>
            <QuestionButton step={{ kind: "changelog", number: 3 }} />
        </HelpScope>
    );
    if (!askAgent) {
        return renderToStaticMarkup(tree);
    }
    return renderToStaticMarkup(
        <PipelineTabContext.Provider value={{ dir: Dir, project: "p", panelBlockId: "b", askAgent }}>
            {tree}
        </PipelineTabContext.Provider>
    );
}

describe("help from the pipeline setup (#1152, FR-MC-044)", () => {
    beforeEach(() => {
        SetupHelp.resetInstances();
    });
    afterEach(() => {
        I18nModel.getInstance().setLanguageSetting("en");
    });

    it("shows each step's Question in the tab, in French, and nothing outside it", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        const html = screen(async () => "sent");
        expect(html).toContain(">Question<");
        expect(html).toContain("Interroger votre agent de code sur cette étape");
        expect(screen()).toBe("");
    });

    it("builds the context: the step, the screen, the language and what the panel shows", async () => {
        const context = helpContextOf({
            locale: "fr",
            screen: "flow",
            step: { channel: "public", number: 5, kind: "tag", text: "On marque la version v1.2.0." },
            panel: "Version publique :\n5. On marque la version v1.2.0.",
        });
        expect(context).toContain(
            'The developer is asking about step 5 of the public release: "On marque la version v1.2.0."'
        );
        expect(context).toContain(`"Your way of publishing"`);
        expect(context).toContain("The step's kind: tag.");
        expect(context).toContain("Answer in French");
        expect(context).toContain("What the panel shows:\n\nVersion publique :\n5. On marque la version v1.2.0.");
        expect(helpContextOf({ locale: "en", screen: "validate" })).toContain('asking for help on "Validation"');
        expect(helpContextOf({ locale: "en", screen: "flow", panel: "x".repeat(9000) }).length).toBeLessThan(8000);
    });

    it("hands askAgent the context and keeps its result for the panel's help line", async () => {
        const askAgent = vi.fn<AskAgent>(async () => "busy");
        const model = SetupHelp.getInstance(Dir);
        await model.ask(askAgent, "ctx");
        expect(askAgent).toHaveBeenCalledWith({ context: "ctx" });
        expect(globalStore.get(model.statusAtom)).toBe("busy");
        await model.ask(async () => {
            throw new Error("boom");
        }, "ctx");
        expect(globalStore.get(model.statusAtom)).toBe("failed");
    });

    it("describes the pipeline for the agent", () => {
        const text = JSON.stringify({
            release: {
                rc: [{ id: "prepare", title: "Prepare the candidate" }],
                public: [
                    { id: "a", title: "Prepare" },
                    { id: "notes", title: "Write the changelog", manual: "x" },
                ],
            },
        });
        expect(pipelineContextOf(text)).toBe(
            "Release candidate:\n1. Prepare the candidate\nPublic release:\n1. Prepare\n2. Write the changelog (by hand)"
        );
        expect(pipelineContextOf("not json")).toBe("");
        expect(
            plainContextOf([
                { name: "Version publique", steps: [{ number: 1, text: "On part de develop." }] },
                { name: "Version candidate", steps: [] },
            ])
        ).toBe("Version publique:\n1. On part de develop.");
    });
});
