// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Agent first names (FR-CONT-014): wavesrv gives each pane's agent session a first name; the windows show it wherever
// they name the agent.

import { describe, expect, it } from "vitest";
import { agentCallName, agentLabel, agentStateTitle, type AgentStateInfo } from "./agent-state-model";
import { agentEntryLabel, shareAgents, shareMenuItems, tellReason, type ShareActions } from "./browser/browser-share";
import { termHeaderTitle, waitingPill } from "./header/header-model";

function info(blockid: string, firstname: string, state: AgentStateInfo["state"] = "idle"): AgentStateInfo {
    return { blockid, agent: "claude", agentname: "Claude Code", firstname, state, version: 1, workspaceid: "ws1" };
}

const actions: ShareActions = { share: () => {}, stopSharing: () => {}, openAgentSettings: () => {} };

describe("agent first names (FR-CONT-014)", () => {
    it("labels an agent [Name] Agent, and a sentence by its first name", () => {
        expect(agentLabel(info("b1", "Jérôme"))).toBe("[Jérôme] Claude Code");
        expect(agentCallName(info("b1", "Jérôme"))).toBe("Jérôme");
        expect(agentLabel(info("b1", ""))).toBe("Claude Code");
        expect(agentCallName(info("b1", ""))).toBe("Claude Code");
        expect(agentLabel(null)).toBe("Agent");
        expect(agentStateTitle(info("b1", "Alice", "working"))).toMatch(/^\[Alice\] Claude Code: /);
    });

    it("shows the name in the pane header and its pills", () => {
        expect(termHeaderTitle(info("b1", "Jérôme"), "", "Terminal")).toBe("[Jérôme] Claude Code");
        const pill = waitingPill({ ...info("b1", "Jérôme", "waiting"), message: "" });
        expect(pill.title).toBe("Jérôme is waiting for you");
    });

    it("tells two Claude Code sessions of one tab apart in the Share with agent menu", () => {
        const list = shareAgents([info("b1", "Jérôme"), info("b2", "Alice", "working")], [], () => "app");
        expect(list.map(agentEntryLabel)).toEqual(["[Alice] Claude Code — app", "[Jérôme] Claude Code — app"]);
        expect(list.map((a) => a.agentName)).toEqual(["Alice", "Jérôme"]);
        expect(tellReason({ ...list[0], sessionId: "s" })).toBe("Alice is working");
        const menu = shareMenuItems(
            { id: "t1", url: "https://example.com", title: "Example" },
            null,
            list,
            "",
            actions
        );
        expect(menu[0].submenu[0].sublabel).toBe("Set up the MoltenTerm browser for Claude Code");
        expect(menu[0].submenu.slice(0, 2).map((i) => i.label)).toEqual([
            "[Alice] Claude Code — app",
            "[Jérôme] Claude Code — app",
        ]);
    });
});
