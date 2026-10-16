// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { feedbackFor } from "../command-panel/agent-commands";
import { I18nModel } from "../i18n/i18n";
import { restartResult, sendResult } from "../sessions/sessions-bulk";
import { termupdateMessage } from "./termupdate-text";

const handlers = { interrupt: async () => "close" as const, confirmDraft: async () => "close" as const };

describe("typing and update outcomes in English (#656)", () => {
    it("words a code with its vars, and shows the English without one", () => {
        expect(
            termupdateMessage({
                message: "english",
                messagetext: { code: "termupdate.input.notforeground", vars: { program: "vim", agent: "Codex" } },
            })
        ).toBe("vim is in the foreground of this terminal, not Codex: nothing was typed.");
        expect(termupdateMessage({ message: "plain English" })).toBe("plain English");
        expect(termupdateMessage({ message: "fallback", messagetext: { code: "termupdate.nosuchcode" } })).toBe(
            "fallback"
        );
        expect(termupdateMessage(null)).toBe("");
    });

    it("shows a permission mode by the panel's label", () => {
        expect(
            termupdateMessage({
                message: "english",
                messagetext: {
                    code: "termupdate.input.modemissed",
                    vars: { agent: "Claude Code", mode: "acceptEdits", target: "plan" },
                },
            })
        ).toBe("Claude Code shows Accept edits mode: Plan was not reached.");
    });
});

describe("typing and update outcomes in French (#656)", () => {
    beforeAll(() => I18nModel.getInstance().setLanguageSetting("fr"));
    afterAll(() => I18nModel.getInstance().setLanguageSetting("en"));

    it("words the command panel's refusal", () => {
        const feedback = feedbackFor(
            {
                result: "refused",
                reason: "working",
                message: "Claude Code is working: wait for its turn to end, or interrupt it.",
                messagetext: { code: "termupdate.input.working", vars: { agent: "Claude Code" } },
            },
            "compact",
            handlers
        );
        expect(feedback).not.toBe("close");
        expect((feedback as { message: string }).message).toBe(
            "Claude Code travaille : attendez la fin de son tour, ou interrompez-le."
        );
    });

    it("words the mode labels in French", () => {
        expect(
            termupdateMessage({
                message: "Claude Code is now in Accept edits mode.",
                messagetext: { code: "termupdate.input.modenow", vars: { agent: "Claude Code", mode: "acceptEdits" } },
            })
        ).toBe("Claude Code est maintenant en mode Accepter les modifications.");
    });

    it("words the Sessions view's bulk results", () => {
        expect(
            restartResult("s1", {
                status: "restarted",
                message: "Restarted. Claude Code resumes its session (claude --resume x).",
                messagetext: {
                    code: "termupdate.restart.done",
                    vars: { agent: "Claude Code", command: "claude --resume x" },
                },
            }).message
        ).toBe("Redémarré. Claude Code reprend sa session (claude --resume x).");
        expect(
            sendResult("s1", {
                result: "refused",
                reason: "busy",
                message: "MoltenTerm is already typing in this terminal: try again in a moment.",
                messagetext: { code: "termupdate.input.busy" },
            })
        ).toEqual({ id: "s1", kind: "skipped", message: "MoltenTerm tape déjà dans ce terminal : réessayez dans un instant." });
    });
});
