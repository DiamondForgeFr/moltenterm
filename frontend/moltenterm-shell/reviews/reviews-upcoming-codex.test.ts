// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// #1463: a Codex session and its sub-agents get the same Integration card as a Claude Code session's. The answers are
// the ones wavesrv gives for the two fixtures of pkg/molten/mission/upcoming_codex_subagents_test.go (one session in
// the main checkout, a sub-agent at work on fix/1462-… and a finished one on feature/1029-…), which writes them here.

import { describe, expect, it } from "vitest";
import type { AgentStatesData } from "../agent-state-model";
import { tCount } from "../i18n/i18n";
import { translate } from "../i18n/i18n-core";
import { upcomingEntries, UpcomingEntry } from "./reviews-sections-model";
import { branchAgent, subagentDetails, UpcomingAnswer, upcomingRows } from "./reviews-upcoming-model";
import golden from "./testdata/upcoming-subagent-card.json";

const Answers = golden as unknown as Record<"claude" | "codex", UpcomingAnswer>;

const ToolNames = { claude: "Claude Code", codex: "Codex" };

function live(agent: "claude" | "codex"): AgentStatesData {
    return {
        states: { b0: { blockid: "b0", version: 1, agent, agentname: ToolNames[agent], firstname: "Adrien", state: "working" } },
        versions: { b0: 1 },
    };
}

function entriesOf(agent: "claude" | "codex"): UpcomingEntry[] {
    const answer = Answers[agent];
    const states = live(agent);
    return upcomingEntries(upcomingRows(answer, null), (branch) => branchAgent(answer, states, branch));
}

// What the card shows, its tool's own words (tool, model, task) left out.
function card(entries: UpcomingEntry[]) {
    return entries.map((e) =>
        e.kind === "session"
            ? {
                  kind: e.kind,
                  parent: e.parentBlockId,
                  name: e.parentName,
                  lines: e.items.map((i) => ({
                      ticket: i.branch.ticket,
                      agent: i.agent.kind,
                      state: i.agent.state,
                      sub: i.agent.subState,
                      model: !!i.agent.model,
                  })),
              }
            : { kind: e.kind, ticket: e.item.branch.ticket, agent: e.item.agent?.kind ?? null }
    );
}

describe("a Codex session's Integration card (#1463)", () => {
    it("is the Claude Code session's card: the session, its first name and one line per sub-agent", () => {
        const codex = card(entriesOf("codex"));
        expect(codex).toEqual(card(entriesOf("claude")));
        expect(codex[0]).toEqual({
            kind: "session",
            parent: "b0",
            name: "Adrien",
            lines: [
                { ticket: 1029, agent: "subagent", state: "done", sub: "done", model: true },
                { ticket: 1462, agent: "subagent", state: "working", sub: "running", model: true },
            ],
        });
    });

    it("never falls back to the background guess", () => {
        for (const e of entriesOf("codex")) {
            const agents = e.kind === "session" ? e.items.map((i) => i.agent) : [e.item.agent];
            expect(agents.some((a) => a?.kind === "background")).toBe(false);
        }
    });

    it("shows the model and task as data on each sub-agent's line", () => {
        const session = entriesOf("codex")[0];
        expect(session.kind).toBe("session");
        if (session.kind !== "session") {
            return;
        }
        expect(session.items.map((i) => subagentDetails(i.agent))).toEqual([
            "Codex · gpt-5.5 · ticket 1029 release notes",
            "Codex · gpt-5.5 · ticket 1462 codex sessions",
        ]);
        expect(tCount("reviewsAgents.upcoming.session.orchestrates", session.items.length, { name: "Adrien" })).toBe(
            "Adrien orchestrates 2 tickets"
        );
        expect(translate("fr", "reviewsAgents.upcoming.session.title", { name: "Adrien" })).toBe("Session d'Adrien");
    });
});
