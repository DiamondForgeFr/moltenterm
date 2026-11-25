// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
    AgentHookOffer,
    dismissedWith,
    hookApplyNeedsConfirmation,
    hookApplyTextKey,
    hookChangeValue,
    hookOfferQueryKey,
    hookOfferTexts,
    hookProposalTextKey,
    visibleHookOffer,
} from "./agent-hooks-model";
import { AgentStateInfo } from "./agent-state-model";
import { translate } from "./i18n/i18n-core";

const claude: AgentStateInfo = { blockid: "b1", agent: "claude", agentname: "Claude Code", state: "idle", version: 3 };
const offer: AgentHookOffer = {
    blockid: "b1",
    agent: "claude",
    agentname: "Claude Code",
    show: true,
    file: "~/.claude/settings.json",
    snippet: "{}",
};

describe("hook setup offer", () => {
    it("shows the offer wavesrv made for the pane's agent", () => {
        expect(visibleHookOffer(claude, offer, [])).toBe(offer);
    });

    it("hides it once the agent's hooks report", () => {
        expect(visibleHookOffer({ ...claude, hooked: true }, offer, [])).toBeNull();
    });

    it("hides it when the agent is dismissed in this window", () => {
        expect(visibleHookOffer(claude, offer, ["claude"])).toBeNull();
        expect(visibleHookOffer(claude, offer, ["codex"])).toBe(offer);
    });

    it("hides an offer wavesrv declined, one for another agent, or none", () => {
        expect(visibleHookOffer(claude, { ...offer, show: false, reason: "configured" }, [])).toBeNull();
        expect(visibleHookOffer({ ...claude, agent: "codex" }, offer, [])).toBeNull();
        expect(visibleHookOffer(claude, null, [])).toBeNull();
        expect(visibleHookOffer(null, offer, [])).toBeNull();
    });

    it("refreshes on an agent change and when hooks start reporting", () => {
        expect(hookOfferQueryKey(claude)).toBe("claude:unreported");
        expect(hookOfferQueryKey({ ...claude, state: "working", version: 9 })).toBe("claude:unreported");
        expect(hookOfferQueryKey({ ...claude, agent: "codex" })).toBe("codex:unreported");
        expect(hookOfferQueryKey({ ...claude, hooked: true })).toBe("claude:reporting");
        expect(hookOfferQueryKey(null)).toBe("");
    });

    it("keeps persistent updates and repairs visible after reports", () => {
        const persistent: AgentHookOffer = {
            ...offer,
            agent: "kimi",
            persistent: true,
            show: true,
            status: "definition-update",
            updatekind: "definition",
            updatekey: "revision-1",
        };
        expect(visibleHookOffer({ ...claude, agent: "kimi", hooked: true }, persistent, [])).toBe(persistent);
        expect(
            visibleHookOffer({ ...claude, agent: "kimi", hooked: true }, persistent, ["kimi:revision-1"])
        ).toBeNull();
        const revised = { ...persistent, updatekey: "revision-2" };
        expect(visibleHookOffer({ ...claude, agent: "kimi", hooked: true }, revised, ["kimi:revision-1"])).toBe(
            revised
        );
        const reporting = { ...persistent, status: "reporting" as const, updatekind: undefined };
        expect(visibleHookOffer({ ...claude, agent: "kimi", hooked: true }, reporting, [])).toBeNull();
    });

    it("distinguishes setup, restart, definition update, repair and compatibility labels", () => {
        expect(hookProposalTextKey(offer)).toBe("cmdpanel.proposals.setupHooks");
        expect(hookProposalTextKey({ ...offer, status: "installed-not-reporting" })).toBe(
            "cmdpanel.proposals.restartHooks"
        );
        expect(hookProposalTextKey({ ...offer, updatekind: "definition" })).toBe("cmdpanel.proposals.updateHooks");
        expect(hookProposalTextKey({ ...offer, updatekind: "repair" })).toBe("cmdpanel.proposals.repairHooks");
        expect(hookProposalTextKey({ ...offer, updatekind: "compatibility" })).toBe("cmdpanel.proposals.reviewHooks");
    });

    // #2543: the header dot and the command entry lead to the update once hooks differ, whatever the version; only a
    // known incompatible version reads as a compatibility check.
    it("words a difference as an update, also on an unqualified version, and asks before that write", () => {
        const kimi: AgentHookOffer = {
            ...offer,
            agent: "kimi",
            agentname: "Kimi Code",
            persistent: true,
            status: "definition-update",
            action: "update",
            updatekind: "definition",
            updatekey: "revision-1",
            canapply: true,
            unqualified: true,
            currentkimiversion: "2.9.0",
        };
        expect(visibleHookOffer({ ...claude, agent: "kimi", hooked: true }, kimi, [])).toBe(kimi);
        expect(hookProposalTextKey(kimi)).toBe("cmdpanel.proposals.updateHooks");
        expect(translate("fr", hookProposalTextKey(kimi), { agent: "Kimi Code" })).toBe(
            "Mettre à jour les hooks de Kimi Code"
        );
        expect(translate("en", hookProposalTextKey(kimi), { agent: "Kimi Code" })).toBe("Update Kimi Code's hooks");
        expect(hookApplyTextKey(kimi)).toBe("agent.hooks.update");
        expect(hookApplyNeedsConfirmation(kimi)).toBe(true);
        expect(hookApplyNeedsConfirmation({ ...kimi, unqualified: false })).toBe(false);
        expect(hookApplyNeedsConfirmation({ ...kimi, canapply: false })).toBe(false);
        const claudeUpdate: AgentHookOffer = { ...offer, status: "definition-update", updatekind: "definition", updatekey: "k" };
        expect(visibleHookOffer({ ...claude, hooked: true }, claudeUpdate, [])).toBe(claudeUpdate);
        expect(hookProposalTextKey(claudeUpdate)).toBe("cmdpanel.proposals.updateHooks");
    });

    it("shows a change's values in words", () => {
        const t = (key: string, vars?: any) => translate("en", key, vars);
        expect(hookChangeValue({ kind: "changed", field: "timeout" }, "15", t)).toBe("15 s");
        expect(hookChangeValue({ kind: "changed", field: "timeout" }, "", t)).toBe("default");
        expect(hookChangeValue({ kind: "changed", field: "matcher" }, "", t)).toBe("none");
        expect(hookChangeValue({ kind: "changed", field: "command" }, "molten agent hook", t)).toBe("molten agent hook");
    });

    it("words the offer in the interface language for Claude Code and Codex (#988)", () => {
        const codex: AgentHookOffer = { ...offer, agent: "codex", brings: "english", also: "english too" };
        for (const locale of ["en", "fr"]) {
            const texts = hookOfferTexts(codex, (key) => translate(locale, key));
            expect(texts.brings).not.toBe(texts.also);
            expect(texts.brings).not.toContain("agent.hooks");
            expect(texts.also).toContain(".codex/hooks.json");
            expect(texts.also).toContain("/hooks");
        }
        expect(hookOfferTexts(codex, (key) => translate("fr", key)).brings).toContain("terminé");
        expect(hookOfferTexts({ ...offer, brings: "theirs" }, (key) => translate("fr", key)).also).toContain(
            ".claude/settings.json"
        );
        expect(hookOfferTexts({ ...offer, agent: "gemini", brings: "b", also: "a" }, (key) => key)).toEqual({
            brings: "b",
            also: "a",
        });
    });

    it("remembers each dismissed agent once", () => {
        const one = dismissedWith([], "claude");
        expect(one).toEqual(["claude"]);
        expect(dismissedWith(one, "claude")).toBe(one);
        expect(dismissedWith(one, "codex")).toEqual(["claude", "codex"]);
    });
});
