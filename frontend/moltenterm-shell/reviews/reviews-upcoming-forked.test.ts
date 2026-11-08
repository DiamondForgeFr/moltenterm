// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// #1967: Léa's three background sub-agents, on #1964, #1965 and #1966, as wavesrv answers for a Codex session and for
// a Claude Code one (pkg/molten/mission/upcoming_codex_forked_test.go writes the answers here). A Codex sub-agent's
// line says the same facts as a Claude Code one's: its parent, its CLI, its own model and effort, its task. It is
// never Léa's own line with her model, and never an anonymous background agent.

import { describe, expect, it } from "vitest";
import type { AgentStatesData } from "../agent-state-model";
import { translate } from "../i18n/i18n-core";
import { upcomingEntries, UpcomingEntry } from "./reviews-sections-model";
import { agentDetails, branchAgent, UpcomingAnswer, upcomingRows } from "./reviews-upcoming-model";
import golden from "./testdata/upcoming-forked-card.json";

type Tool = "claude" | "codex";

const Answers = golden as unknown as Record<Tool, UpcomingAnswer>;

const ToolNames: Record<Tool, string> = { claude: "Claude Code", codex: "Codex" };

// Léa's own state: her model is not her sub-agents'.
function live(agent: Tool): AgentStatesData {
    return {
        states: {
            b0: {
                blockid: "b0",
                version: 1,
                agent,
                agentname: ToolNames[agent],
                firstname: "Léa",
                state: "working",
                model: agent === "codex" ? "gpt-6-astra" : "claude-fable-5",
                effort: "high",
            },
        },
        versions: { b0: 1 },
    };
}

function entriesOf(agent: Tool): UpcomingEntry[] {
    const answer = Answers[agent];
    const states = live(agent);
    return upcomingEntries(upcomingRows(answer, null), (branch) => branchAgent(answer, states, branch));
}

function sessionOf(agent: Tool) {
    const session = entriesOf(agent).find((e) => e.kind === "session");
    expect(session).toBeDefined();
    if (session.kind !== "session") {
        throw new Error("not a session");
    }
    return session;
}

describe("a Codex session's background sub-agents on the Integration card (#1967)", () => {
    it("are three sub-agent lines of Léa's session, as Claude Code's are", () => {
        for (const agent of ["codex", "claude"] as const) {
            const session = sessionOf(agent);
            expect(session.parentBlockId).toBe("b0");
            expect(session.parentName).toBe("Léa");
            expect(session.items.map((i) => [i.branch.ticket, i.agent.kind, i.agent.state, i.agent.subState])).toEqual([
                [1964, "subagent", "working", "running"],
                [1965, "subagent", "working", "running"],
                [1966, "subagent", "working", "running"],
            ]);
        }
        // The only other row is the repository's #4 branch, which nobody works on.
        const others = entriesOf("codex").flatMap((e) =>
            e.kind === "session" ? [] : [[e.item.branch.ticket, e.item.agent]]
        );
        expect(others).toEqual([[4, null]]);
    });

    it("say Codex, the sub-agent's own model and effort, and its task, never Léa's model", () => {
        const details = sessionOf("codex").items.map((i) => agentDetails(i.agent));
        expect(details).toEqual([
            "Codex · gpt-6.1-sol · medium · fix 1964 vars",
            "Codex · gpt-6.1-sol · medium · fix 1965 routes",
            "Codex · gpt-6.1-sol · medium · fix 1966 materials",
        ]);
        for (const line of details) {
            expect(line).not.toContain("gpt-6-astra");
        }
        expect(sessionOf("claude").items.map((i) => agentDetails(i.agent))).toEqual([
            "Claude Code · Opus 5.5 · fix 1964 vars",
            "Claude Code · Opus 5.5 · fix 1965 routes",
            "Claude Code · Opus 5.5 · fix 1966 materials",
        ]);
        expect(translate("fr", "reviewsAgents.subagent.of", { name: "Léa" })).toBe("Sous-agent de Léa");
        expect(translate("en", "reviewsAgents.subagent.of", { name: "Léa" })).toBe("Sub-agent of Léa");
    });

    it("are never the anonymous background guess", () => {
        for (const agent of ["codex", "claude"] as const) {
            const kinds = sessionOf(agent).items.map((i) => i.agent.kind);
            expect(kinds).not.toContain("background");
            expect(kinds).not.toContain("panel");
        }
    });
});
