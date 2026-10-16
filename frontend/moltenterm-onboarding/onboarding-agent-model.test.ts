// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    canMorph,
    catalogAgents,
    foundAgents,
    genericAgent,
    genericRequest,
    GenericRequestPlaceholder,
    guideCall,
    guideRequest,
    guideState,
    OnboardingAgent,
    OnboardingAgents,
    preselectedAgent,
} from "./onboarding-agent-model";

function agent(id: string, patch: Partial<OnboardingAgent> = {}): OnboardingAgent {
    return {
        id,
        name: id,
        path: `/home/u/${id}/morph`,
        invocation: "/morph <request>",
        format: "skill",
        installed: false,
        guides: [],
        found: false,
        ...patch,
    };
}

const listing: OnboardingAgents = {
    version: "1.0.0",
    agents: [
        agent("claude-code", { found: true, installed: true, version: "1.0.0" }),
        agent("codex", { invocation: "$morph <request>" }),
        agent("gemini-cli", { found: true, declined: true }),
        agent("kimi", { invocation: "/skill:morph <request>" }),
        agent("generic", {
            invocation: "Read /data/molten/agents/morph.md and follow it with my request: <request>",
        }),
    ],
};

describe("your agent step (FR-ONB-002)", () => {
    it("lists the catalog with the agents found first, generic apart", () => {
        expect(catalogAgents(listing).map((a) => a.id)).toEqual(["claude-code", "gemini-cli", "codex", "kimi"]);
        expect(foundAgents(listing).map((a) => a.id)).toEqual(["claude-code", "gemini-cli"]);
        expect(genericAgent(listing).id).toBe("generic");
        expect(catalogAgents(null)).toEqual([]);
    });

    it("writes the call in each agent's syntax", () => {
        expect(guideCall("/morph <request>")).toBe("/morph");
        expect(guideCall("$morph <request>")).toBe("$morph");
        expect(guideCall("/skill:morph <request>")).toBe("/skill:morph");
        expect(guideRequest("$morph <request>", "add a box")).toBe("$morph add a box");
        expect(genericRequest(genericAgent(listing), "add a box")).toBe(
            "Read /data/molten/agents/morph.md and follow it with my request: add a box"
        );
        expect(genericRequest(null, "x")).toBe("");
    });

    it("keeps the pasted line English, its placeholder included, whatever the interface language (#749)", () => {
        expect(genericRequest(genericAgent(listing), GenericRequestPlaceholder)).toBe(
            "Read /data/molten/agents/morph.md and follow it with my request: <what you want MoltenTerm to do>"
        );
    });

    it("tells installed, outdated, foreign and missing guides apart", () => {
        const g = { name: "morph", path: "/p", invocation: "/morph <request>" };
        expect(guideState({ ...g, installed: true, version: "1.0.0" }, "1.0.0")).toBe("installed");
        expect(guideState({ ...g, installed: true, version: "0.9.0" }, "1.0.0")).toBe("outdated");
        expect(guideState({ ...g, installed: false, foreign: true }, "1.0.0")).toBe("foreign");
        expect(guideState({ ...g, installed: false }, "1.0.0")).toBe("missing");
    });

    it("preselects the saved agent while found, else the only one found", () => {
        expect(preselectedAgent(listing, "gemini-cli")).toBe("gemini-cli");
        expect(preselectedAgent(listing, "codex")).toBeNull();
        expect(preselectedAgent(listing, null)).toBeNull();
        const one = { ...listing, agents: listing.agents.filter((a) => a.id !== "gemini-cli") };
        expect(preselectedAgent(one, null)).toBe("claude-code");
        expect(preselectedAgent({ version: "", agents: [] }, null)).toBeNull();
    });

    it("says /morph works only with molten's own guide on an agent not declined", () => {
        expect(canMorph(listing.agents[0])).toBe(true);
        expect(canMorph(listing.agents[2])).toBe(false);
        expect(canMorph(agent("x", { installed: true, foreign: true }))).toBe(false);
        expect(canMorph(null)).toBe(false);
    });
});
