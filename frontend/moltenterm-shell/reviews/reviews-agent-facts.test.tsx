// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// #1848 (FR-REV-022 AC2 and AC9, parity #987): every agent line says the same facts in the same order after its name,
// first name · CLI · model · effort (then a sub-agent's task), whatever the CLI and whether it leads or serves.

import { getDefaultStore } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setTestMatrix } from "../agent-info/agent-features-fixture";
import type { AgentStateInfo, AgentStatesData } from "../agent-state-model";
import { AgentBar, MinuteClock } from "./reviews-agent-bar";
import {
    agentDetails,
    branchAgent,
    panelFacts,
    type AgentBarFacts,
    type BranchAgent,
    type UpcomingAnswer,
} from "./reviews-upcoming-model";

setTestMatrix();

const Now = new Date(2026, 10, 3, 12, 0).getTime();
const Clock = MinuteClock.getInstance().nowAtom;
const PreviousNow = getDefaultStore().get(Clock);

beforeEach(() => getDefaultStore().set(Clock, Now));
afterEach(() => getDefaultStore().set(Clock, PreviousNow));

function info(extra: Partial<AgentStateInfo>): AgentStateInfo {
    return { blockid: "b1", version: 1, state: "working", ...extra };
}

function states(infos: AgentStateInfo[]): AgentStatesData {
    return {
        states: Object.fromEntries(infos.map((i) => [i.blockid, i])),
        versions: Object.fromEntries(infos.map((i) => [i.blockid, i.version])),
    };
}

function answer(agents: BranchAgent[]): UpcomingAnswer {
    return { dir: "/p", branches: [], agents, at: Now };
}

const Lea = info({
    blockid: "b-lea",
    agent: "codex",
    agentname: "Codex",
    firstname: "Léa",
    model: "gpt-5.5",
    effort: "high",
});
const Arthur = info({
    blockid: "b-arthur",
    agent: "claude",
    agentname: "Claude Code",
    firstname: "Arthur",
    model: "claude-opus-5-5",
    modelname: "Opus",
    effort: "medium",
});

describe("a lead's line (#1848)", () => {
    it("says a Codex lead's CLI, model and effort like a Claude Code lead's", () => {
        const lea = panelFacts("b-lea", Lea);
        const arthur = panelFacts("b-arthur", Arthur);
        expect(lea.name).toBe("Léa");
        expect(agentDetails(lea)).toBe("Codex · gpt-5.5 · high");
        expect(agentDetails(arthur)).toBe("Claude Code · Opus 5.5 · medium");
    });

    it("omits a fact the agent did not report, never guesses it", () => {
        expect(agentDetails(panelFacts("b1", info({ agent: "codex", agentname: "Codex", firstname: "Léa" })))).toBe(
            "Codex"
        );
        expect(
            agentDetails(
                panelFacts("b1", info({ agent: "codex", agentname: "Codex", firstname: "Léa", model: "gpt-5.5" }))
            )
        ).toBe("Codex · gpt-5.5");
        expect(
            agentDetails(
                panelFacts("b1", info({ agent: "codex", agentname: "Codex", firstname: "Léa", effort: "low" }))
            )
        ).toBe("Codex · low");
        expect(agentDetails(panelFacts("b1", info({ firstname: "Léa" })))).toBe("");
    });

    it("names the model as the agent itself does when it gave no id", () => {
        const facts = panelFacts(
            "b1",
            info({ agent: "claude", agentname: "Claude Code", firstname: "Val", modelname: "Opus" })
        );
        expect(agentDetails(facts)).toBe("Claude Code · Opus");
    });

    it("does not say the CLI twice for a lead named by its CLI", () => {
        const facts = panelFacts("b1", info({ agent: "codex", agentname: "Codex", model: "gpt-5.5", effort: "high" }));
        expect(facts.name).toBe("Codex");
        expect(agentDetails(facts)).toBe("gpt-5.5 · high");
    });

    it("says the provider behind a run", () => {
        const facts = panelFacts(
            "b1",
            info({
                agent: "claude",
                agentname: "Claude Code",
                firstname: "Val",
                provider: "z.ai",
                providername: "GLM",
                model: "glm-4.6",
            })
        );
        expect(agentDetails(facts)).toBe("Claude Code via GLM · glm-4.6");
    });

    it("shows the facts on the lead's bar, after its first name and before its state", () => {
        const facts: AgentBarFacts = { ...panelFacts("b-lea", Lea), since: Now - 12 * 60_000 };
        const html = renderToStaticMarkup(<AgentBar facts={facts} />);
        expect(html).toMatch(/data-testid="reviews-agent-name"[^>]*>Léa</);
        expect(html).toMatch(
            /title="Codex · gpt-5.5 · high" data-testid="reviews-agent-details">Codex · gpt-5.5 · high</
        );
        expect(html.indexOf("reviews-agent-name")).toBeLessThan(html.indexOf("reviews-agent-details"));
        expect(html).toContain('aria-label="Léa, Codex · gpt-5.5 · high,');
    });
});

describe("a sub-agent's line (#1848)", () => {
    const upcoming = answer([
        {
            branch: "feature/1844-x",
            worktree: "/w/a",
            kind: "subagent",
            agent: "claude",
            activeat: Now - 60_000,
            parentblockid: "b-arthur",
            model: "claude-sonnet-5-5",
            effort: "high",
            description: "Build #1844 agent line",
            state: "running",
        },
        {
            branch: "feature/1845-y",
            worktree: "/w/b",
            kind: "subagent",
            agent: "codex",
            activeat: Now - 60_000,
            parentblockid: "b-lea",
            model: "gpt-5.5",
            effort: "low",
            description: "audit reliability",
            state: "running",
        },
        {
            branch: "feature/1846-z",
            worktree: "/w/c",
            kind: "subagent",
            agent: "claude",
            activeat: Now - 60_000,
            parentblockid: "b-arthur",
            description: "fresh, nothing known yet",
            state: "running",
        },
    ]);
    const live = states([Lea, Arthur]);

    it("says CLI, model, effort and task, a Codex sub-agent like a Claude Code one", () => {
        expect(agentDetails(branchAgent(upcoming, live, "feature/1844-x"))).toBe(
            "Claude Code · Sonnet 5.5 · high · Build #1844 agent line"
        );
        expect(agentDetails(branchAgent(upcoming, live, "feature/1845-y"))).toBe(
            "Codex · gpt-5.5 · low · audit reliability"
        );
    });

    it("leaves out a model and an effort its files do not give, never taking its lead's", () => {
        expect(agentDetails(branchAgent(upcoming, live, "feature/1846-z"))).toBe(
            "Claude Code · fresh, nothing known yet"
        );
    });

    it("is named by its parent on the bar, with the same details", () => {
        const html = renderToStaticMarkup(<AgentBar facts={branchAgent(upcoming, live, "feature/1844-x")} />);
        expect(html).toMatch(/data-testid="reviews-agent-name"[^>]*>Sub-agent of Arthur</);
        expect(html).toContain(">Claude Code · Sonnet 5.5 · high · Build #1844 agent line<");
    });
});

describe("a signed background agent's line (#1848)", () => {
    const signed = (extra: Partial<BranchAgent>) =>
        answer([
            {
                branch: "feature/7-a",
                worktree: "/w/a",
                kind: "background",
                signed: true,
                firstname: "Jérôme",
                agent: "codex",
                agentname: "Codex",
                activeat: Now,
                ...extra,
            },
        ]);

    it("says the model and effort it signed", () => {
        const facts = branchAgent(signed({ model: "gpt-5.5-codex", effort: "high" }), states([]), "feature/7-a");
        expect(agentDetails(facts)).toBe("Codex · gpt-5.5-codex · high");
    });

    it("says its CLI alone when the signature has nothing more, and an unsigned guess nothing", () => {
        expect(agentDetails(branchAgent(signed({}), states([]), "feature/7-a"))).toBe("Codex");
        const unsigned = answer([
            { branch: "feature/8-b", worktree: "/w/b", kind: "background", activeat: Now, model: "x", effort: "high" },
        ]);
        expect(agentDetails(branchAgent(unsigned, states([]), "feature/8-b"))).toBe("");
    });
});
