// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Help me choose on the first launch's agents scene (FR-ONB-008 AC-1, AC-2, AC-6 to AC-10, #1697): the same path as the
// Library's, the short profile on each card, the suggestions outlined without moving a card.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
    answerChooseState,
    backChooseState,
    chooseAgents,
    ChooseQuestionCount,
    libraryAgents,
    startChooseState,
    suggestedIds,
    type ChooseState,
} from "../moltenterm-shell/library/agents-model";
import type { AgentFacts, OnboardingAgent, OnboardingAgents } from "./onboarding-agent-model";
import { pourAgentCards } from "./onboarding-pour-agents";
import { AgentsScene } from "./onboarding-pour-scenes";

const noop = () => {};
// today, so the fresh fixture never turns stale as time passes
const Today = new Date().toISOString().slice(0, 10);

function facts(over: Partial<AgentFacts>): AgentFacts {
    return { checkedon: Today, goodforkey: "library.agents.profiles.codex.goodFor", uses: ["code"], ...over };
}

function agent(id: string, name: string, profile: AgentFacts, found = false): OnboardingAgent {
    return {
        id,
        name,
        executable: id,
        found,
        path: "",
        invocation: "/morph <request>",
        format: "skill",
        installed: found,
        guides: [],
        installcommands: [`install ${id}`],
        profile,
    };
}

const List: OnboardingAgents = {
    version: "1.0.0",
    agents: [
        agent("claude-code", "Claude Code", facts({ from: { amount: "20", currency: "USD", plan: "Pro" } }), true),
        agent("codex", "Codex", facts({ freetier: "yes", includedin: ["chatgpt"] })),
        agent("kimi", "Kimi Code", facts({ from: { amount: "19", currency: "USD" } })),
        agent("vibe", "Mistral Vibe", facts({ freetier: "yes", checkedon: "2020-01-01" })),
    ],
};

function scene(initialChoose?: ChooseState): string {
    return renderToStaticMarkup(
        <AgentsScene
            cards={pourAgentCards(List)}
            list={List}
            initialChoose={initialChoose}
            loading={false}
            checking={false}
            open={null}
            onToggle={noop}
            onCheck={noop}
        />
    );
}

function cardOrder(html: string): string[] {
    return [...html.matchAll(/class="mt-pour-agent"[^>]*data-agent="([^"]+)"/g)].map((m) => m[1]);
}

function done(answers: ChooseState["answers"], seed = 7): ChooseState {
    return { step: ChooseQuestionCount, answers, seed };
}

describe("Help me choose's state (shared with the Library)", () => {
    it("asks three questions, one at a time, then shows the suggestions; Back and Skip move one step", () => {
        let s = startChooseState(1);
        expect(s.step).toBe(0);
        s = answerChooseState(s, { goal: "code" });
        s = answerChooseState(s, {});
        expect(s).toMatchObject({ step: 2, answers: { goal: "code" } });
        expect(backChooseState(s).step).toBe(1);
        s = answerChooseState(s, { already: "chatgpt" });
        expect(s.step).toBe(ChooseQuestionCount);
        expect(answerChooseState(s, { budget: "free" })).toBe(s);
        expect(backChooseState(startChooseState(1)).step).toBe(0);
    });

    it("highlights only the shown suggestions, and none before the path ends", () => {
        const rows = libraryAgents(List);
        const state = done({ already: "chatgpt" });
        const ids = suggestedIds(rows, state);
        expect(ids).toEqual(chooseAgents(rows, state.answers, state.seed).shown.map((s) => s.row.card.id));
        expect(ids[0]).toBe("codex");
        expect(ids).toHaveLength(2);
        expect(suggestedIds(rows, { ...state, step: 2 })).toEqual([]);
        expect(suggestedIds(rows, null)).toEqual([]);
    });
});

describe("the agents scene (FR-ONB-008)", () => {
    it("offers Help me choose above the cards, closed until asked", () => {
        const html = scene();
        expect(html).toContain('data-testid="pour-choose-entry"');
        expect(html).toContain("Help me choose");
        expect(html).not.toContain('data-testid="pour-choose"');
        expect(html.indexOf("pour-choose-entry")).toBeLessThan(html.indexOf("mt-pour-forge"));
        expect(html).not.toContain("data-suggested");
    });

    it("shows each card's short profile: good for, the cost line as the vendor shows it, the checked date", () => {
        const html = scene();
        expect(html.match(/data-testid="pour-card-profile"/g)).toHaveLength(4);
        expect(html).toContain("From 20 USD / month · Pro");
        expect(html).toContain("Free to start");
        expect(html).toContain(`Checked on ${Today}<`);
        expect(html).toContain("Checked on 2020-01-01: this may have changed");
    });

    it("asks the path's questions in place of the grid, with Skip, and says the answers stay here", () => {
        const html = scene(answerChooseState(startChooseState(3), { goal: "code" }));
        expect(html).toContain('data-testid="pour-choose-question"');
        expect(html).toContain('data-step="1"');
        expect(html).toContain('data-testid="pour-choose-skip"');
        expect(html).toContain("nothing is recorded or sent");
        expect(html).not.toContain("mt-pour-forge");
    });

    it("comes back to the cards in their own order, the suggestions outlined", () => {
        const plain = cardOrder(scene());
        const html = scene(done({ already: "chatgpt" }));
        expect(cardOrder(html)).toEqual(plain);
        expect(html).toContain('data-testid="pour-match-codex"');
        expect(html.match(/data-suggested=""/g)).toHaveLength(2);
        expect(html).toContain('data-testid="pour-choose-highlighted"');
        expect(html).toContain("Change my answers");
        expect(html).not.toMatch(/recommended|best|popular/i);
    });

    it("outlines nothing when no agent matches the answers", () => {
        const html = scene(done({ goal: "write-research", budget: "free" }));
        expect(html).not.toContain("data-suggested");
        expect(cardOrder(html)).toEqual(cardOrder(scene()));
    });
});
