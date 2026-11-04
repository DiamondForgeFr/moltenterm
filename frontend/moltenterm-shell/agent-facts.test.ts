// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// #1848: one formatter words the CLI, model and effort of every agent line.

import { describe, expect, it } from "vitest";
import { agentFactParts, agentFactsLine, agentModelText, agentRunFacts } from "./agent-facts";
import { subagentLeafTitle, type SubagentRow } from "./agent-info/agent-info-model";
import type { AgentStateInfo } from "./agent-state-model";
import { t } from "./i18n/i18n";

describe("the facts of an agent line (#1848)", () => {
    it("names a model the same way for a Claude id, an alias, another CLI's id and the agent's own name", () => {
        expect(agentModelText("claude-sonnet-5-5")).toBe("Sonnet 5.5");
        expect(agentModelText("claude-opus-5-5[1m]")).toBe("Opus 5.5");
        expect(agentModelText("sonnet")).toBe("Sonnet");
        expect(agentModelText("gpt-5.5")).toBe("gpt-5.5");
        expect(agentModelText("", "Opus 4.7 (1M context)")).toBe("Opus 4.7 (1M context)");
        expect(agentModelText("claude-opus-5-5", "Opus")).toBe("Opus 5.5");
        expect(agentModelText("inherit")).toBe("");
        expect(agentModelText(undefined, undefined)).toBe("");
    });

    it("keeps the order CLI, model, effort and leaves out what is missing", () => {
        expect(agentFactParts({ cli: "Codex", model: "gpt-5.5", effort: "high" })).toEqual([
            "Codex",
            "gpt-5.5",
            "high",
        ]);
        expect(agentFactParts({ effort: " high ", cli: " Codex " })).toEqual(["Codex", "high"]);
        expect(agentFactParts({ model: "gpt-5.5" })).toEqual(["gpt-5.5"]);
        expect(agentFactParts({})).toEqual([]);
        expect(agentFactParts(null)).toEqual([]);
    });

    it("joins them, then what follows", () => {
        expect(agentFactsLine({ cli: "Claude Code", model: "claude-sonnet-5-5", effort: "xhigh" }, "Build #1844")).toBe(
            "Claude Code · Sonnet 5.5 · xhigh · Build #1844"
        );
        expect(agentFactsLine({}, "", undefined, " task ")).toBe("task");
        expect(agentFactsLine({})).toBe("");
    });

    it("reads a terminal's run the same for Claude Code and Codex", () => {
        const claude: AgentStateInfo = {
            blockid: "b1",
            version: 1,
            agent: "claude",
            agentname: "Claude Code",
            model: "claude-opus-5-5",
            modelname: "Opus",
            effort: "medium",
        };
        const codex: AgentStateInfo = {
            blockid: "b2",
            version: 1,
            agent: "codex",
            agentname: "Codex",
            model: "gpt-5.5",
            effort: "high",
        };
        expect(agentFactsLine(agentRunFacts(claude))).toBe("Claude Code · Opus 5.5 · medium");
        expect(agentFactsLine(agentRunFacts(codex))).toBe("Codex · gpt-5.5 · high");
        expect(agentFactsLine(agentRunFacts({ blockid: "b3", version: 1, agent: "codex" }))).toBe("codex");
        expect(agentFactsLine(agentRunFacts(null))).toBe("");
    });
});

describe("a sub-agent row's tooltip in the sidebar (#1848)", () => {
    const row: SubagentRow = {
        id: "s1",
        name: "Build #1844 agent line",
        kind: "worker",
        model: "claude-sonnet-5-5",
        effort: "high",
        state: "working",
    };

    it("says its state, type, CLI, model and effort, then how to open it", () => {
        const lines = subagentLeafTitle(t, row, "Claude Code").split("\n");
        expect(lines[0]).toBe("Build #1844 agent line");
        expect(lines[1]).toMatch(/Claude Code · Sonnet 5\.5 · high$/);
        expect(lines[1].split(" · ")).toHaveLength(5);
        expect(lines[2]).toBe(t("agentInfo.sub.open"));
    });

    it("leaves out a model and an effort its files do not give", () => {
        const lines = subagentLeafTitle(t, { ...row, model: "", effort: "" }, "Codex").split("\n");
        expect(lines[1]).toMatch(/ · Codex$/);
        expect(lines[1]).not.toMatch(/Sonnet|high/);
    });
});
