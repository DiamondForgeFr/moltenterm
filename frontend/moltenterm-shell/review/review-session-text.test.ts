// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { I18nModel } from "../i18n/i18n";
import type { ReviewSessionInfo } from "./review-session";
import { localizeAsk, localizeBrief, localizeSession, sessionReasonText, startResultText } from "./review-session-text";

const session = {
    id: "s1",
    repo: "o/r",
    number: 7,
    projectdir: "/p",
    headref: "feature/7-x",
    headoid: "abc",
    worktree: "/w",
    worktreekind: "review",
    agent: "claude",
    agentname: "Claude Code",
    blockid: "b1",
    command: "claude --permission-mode plan",
    state: "failed",
    message: "the terminal showed no prompt",
    reason: "notstarted",
    startedat: 1,
    connected: false,
    queuenote: "A queued question could not be sent: The agent no longer runs in this terminal: nothing was typed.",
    queuenotereason: "queuefailed",
    queuenotecause: "noagent",
} as ReviewSessionInfo;

describe("review session text in English (#652)", () => {
    it("words each code, with wavesrv's detail where the code carries one", () => {
        expect(startResultText({ status: "noagent", reason: "notinstalled", message: "english" })).toContain(
            "No supported coding agent"
        );
        expect(startResultText({ status: "noagent", reason: "agentmissing", agentname: "Codex" })).toMatch(
            /^Codex is not installed/
        );
        expect(startResultText({ status: "failed", reason: "worktree", message: "git said no" })).toBe(
            "The review worktree could not be prepared: git said no"
        );
    });

    it("shows wavesrv's message for a code it does not know, or none", () => {
        expect(startResultText({ status: "failed", message: "boom" })).toBe("boom");
        expect(sessionReasonText("somethingnew", "as is")).toBe("as is");
    });
});

describe("review session text in French (#652)", () => {
    beforeAll(() => I18nModel.getInstance().setLanguageSetting("fr"));
    afterAll(() => I18nModel.getInstance().setLanguageSetting("en"));

    it("says no supported agent is installed in French", () => {
        const text = startResultText({
            status: "noagent",
            reason: "notinstalled",
            message: "No supported coding agent",
        });
        expect(text).toContain("Aucun agent de code pris en charge");
    });

    it("words a failed session and its queue note", () => {
        const out = localizeSession(session);
        expect(out.message).toBe(
            "L'agent n'a pas démarré (the terminal showed no prompt). Lancez-le dans le terminal de revue avec : claude --permission-mode plan"
        );
        expect(out.queuenote).toBe(
            "Une question en attente n'a pas pu être envoyée : Claude Code ne tourne plus dans le terminal de revue : rien n'a été tapé."
        );
        expect(localizeSession({ ...session, reason: undefined, queuenotereason: undefined }).message).toBe(
            session.message
        );
    });

    it("words Ask, Discuss and briefing outcomes", () => {
        expect(
            localizeAsk({ sent: false, reason: "sessionended", message: "This review session has ended" }, "Codex")
                .message
        ).toBe("Cette session de revue est terminée.");
        expect(localizeAsk({ sent: false, queued: true, reason: "working", message: "x" }, "Codex").message).toBe(
            "Codex travaille."
        );
        expect(
            localizeAsk({ sent: false, reason: "notforeground", program: "vim", message: "english" }, "Codex").message
        ).toBe("vim est au premier plan du terminal de revue, pas Codex : rien n'a été tapé.");
        expect(localizeAsk({ sent: true, message: "Sent to Codex." }, "Codex").message).toBe("Sent to Codex.");
        expect(localizeBrief({ status: "typed", message: "english" }, "Codex").message).toContain("appuyez sur Entrée");
        expect(localizeBrief({ status: "busy", reason: "waiting" }, "Codex").message).toBe(
            "Codex attend votre réponse."
        );
    });
});
