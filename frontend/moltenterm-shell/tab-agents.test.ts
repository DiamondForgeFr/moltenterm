// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { AgentStateInfo } from "./agent-state-model";
import { translate } from "./i18n/i18n-core";
import { tabAgentName, tabAgentRunTime, tabAgentsByRun, tabAgentsTitle } from "./tab-agents";

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const fr = (key: string, vars?: Record<string, string | number>) => translate("fr", key, vars);

const Min = 60_000;
const Now = 1_000 * Min;

function agent(blockid: string, firstname: string, startedMinutesAgo: number, extra: Partial<AgentStateInfo> = {}) {
    return {
        blockid,
        firstname,
        agent: "claude",
        agentname: "Claude Code",
        state: "working",
        started: Now - startedMinutesAgo * Min,
        since: Now - Min,
        version: 1,
        ...extra,
    } as AgentStateInfo;
}

describe("the agent a tab names (FR-SHELL-056, #1033)", () => {
    it("names nobody without an agent", () => {
        expect(tabAgentName(tabAgentsByRun([]))).toBeNull();
        expect(tabAgentName(null)).toBeNull();
    });

    it("names the one agent", () => {
        expect(tabAgentName(tabAgentsByRun([agent("b1", "Valentin", 5)]))).toEqual({ name: "Valentin", more: 0 });
    });

    it("names the longest-running of three, +2 for the others", () => {
        const sorted = tabAgentsByRun([
            agent("b1", "Léon", 3),
            agent("b2", "Valentin", 40),
            agent("b3", "Olivia", 12, { agent: "codex", agentname: "Codex" }),
        ]);
        expect(sorted.map((a) => a.firstname)).toEqual(["Valentin", "Olivia", "Léon"]);
        expect(tabAgentName(sorted)).toEqual({ name: "Valentin", more: 2 });
        expect(en("tabs.agent.more", { count: 2 })).toBe("+2");
    });

    it("passes to the next longest-running when the first one ends", () => {
        const sorted = tabAgentsByRun([agent("b1", "Léon", 3), agent("b3", "Olivia", 12)]);
        expect(tabAgentName(sorted)).toEqual({ name: "Olivia", more: 1 });
    });

    it("orders by the run's start, not the state's", () => {
        const sorted = tabAgentsByRun([
            agent("b1", "Léon", 30, { since: Now - 1 * Min }),
            agent("b2", "Valentin", 10, { since: Now - 9 * Min }),
        ]);
        expect(sorted[0].firstname).toBe("Léon");
    });

    it("falls back to the state's start, then breaks ties by first name", () => {
        const old = agent("b2", "Zoé", 0, { started: undefined, since: Now - 50 * Min });
        const tieA = agent("b9", "Anna", 20);
        const tieB = agent("b1", "Bruno", 20);
        expect(tabAgentsByRun([tieB, old, tieA]).map((a) => a.firstname)).toEqual(["Zoé", "Anna", "Bruno"]);
    });

    it("shows the tool's name for an agent without a first name", () => {
        expect(tabAgentName(tabAgentsByRun([agent("b1", "", 1, { agentname: "Codex" })])).name).toBe("Codex");
    });

    it("lists every agent with its tool, state and run time", () => {
        const sorted = tabAgentsByRun([
            agent("b1", "Valentin", 75),
            agent("b2", "Olivia", 12, { agent: "codex", agentname: "Codex", state: "waiting" }),
            agent("b3", "Léon", 0, { state: "done" }),
        ]);
        expect(tabAgentsTitle(en, sorted, Now)).toBe(
            [
                "Valentin · Claude Code: working, for 1 h 15",
                "Olivia · Codex: waiting for you, for 12 min",
                "Léon · Claude Code: done, for less than a minute",
            ].join("\n")
        );
        expect(tabAgentsTitle(fr, sorted.slice(1, 2), Now)).toBe(
            `Olivia · Codex : ${fr("agent.state.waiting")}, depuis 12 min`
        );
    });

    it("formats the run time", () => {
        expect(tabAgentRunTime(en, 30_000)).toBe("less than a minute");
        expect(tabAgentRunTime(en, 59 * Min)).toBe("59 min");
        expect(tabAgentRunTime(en, 125 * Min)).toBe("2 h 05");
        expect(tabAgentRunTime(fr, 30_000)).toBe("moins d'une minute");
    });
});
