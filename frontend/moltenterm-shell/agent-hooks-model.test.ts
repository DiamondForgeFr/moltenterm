// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { AgentHookOffer, dismissedWith, hookOfferQueryKey, visibleHookOffer } from "./agent-hooks-model";
import { AgentStateInfo } from "./agent-state-model";

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

    it("asks again when the agent changes, never once it is hooked", () => {
        expect(hookOfferQueryKey(claude)).toBe("claude");
        expect(hookOfferQueryKey({ ...claude, state: "working", version: 9 })).toBe("claude");
        expect(hookOfferQueryKey({ ...claude, agent: "codex" })).toBe("codex");
        expect(hookOfferQueryKey({ ...claude, hooked: true })).toBe("");
        expect(hookOfferQueryKey(null)).toBe("");
    });

    it("remembers each dismissed agent once", () => {
        const one = dismissedWith([], "claude");
        expect(one).toEqual(["claude"]);
        expect(dismissedWith(one, "claude")).toBe(one);
        expect(dismissedWith(one, "codex")).toEqual(["claude", "codex"]);
    });
});
